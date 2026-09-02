/**
 * Gehärteter HTTP-Client für Abrufe bei externen Datenquellen (nur GET).
 *
 * Schutzmechanismen:
 *  - Origin-Allowlist vor jedem Request (SSRF-Schutz): nur http(s)-URLs ohne
 *    Zugangsdaten, deren Origin in `allowedOrigins` steht.
 *  - Keine Weiterleitungen (`redirect: 'manual'`, 3xx → Fehler).
 *  - Timeout per AbortController (deckt auch das Lesen des Bodys ab).
 *  - Größenlimit für Antworten (Content-Length und tatsächlich gelesene Bytes).
 *  - Wiederholungen mit exponentiellem Backoff und Jitter nur bei 5xx, Netz-
 *    fehlern und Timeouts; 429 nur mit kurzem `Retry-After`; 4xx nie.
 *  - Antworten werden defensiv gelesen; kein JSON → `UpstreamFormatError`.
 *
 * Logs enthalten die URL stets ohne Query-String. Fehlermeldungen für Clients
 * enthalten weder URLs noch Upstream-Texte (diese landen nur in `details`).
 */
import { AppError, UpstreamError, UpstreamTimeoutError, RateLimitedError, UpstreamFormatError } from './errors.js';
import { silentLogger } from '../logger.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETRY_MAX_MS = 8_000;
const DEFAULT_RETRY_AFTER_MAX_MS = 5_000;
const RETRY_AFTER_CAP_MS = 24 * 3600 * 1000;
const ERROR_BODY_MAX_BYTES = 16 * 1024;
const DEFAULT_USER_AGENT = 'db-ice-live-karte';

function defaultSetTimeout(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function positiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Normalisiert eine Origin-Angabe; wirft bei ungültigen Werten. */
function normalizeOrigin(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new TypeError(`allowedOrigins enthält keinen gültigen Origin: "${value}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError(`allowedOrigins erlaubt nur http(s): "${value}"`);
  return u.origin;
}

/** Wandelt `Retry-After` (Sekunden oder HTTP-Datum) in Millisekunden um; `null` wenn unbrauchbar. */
export function parseRetryAfterMs(value, nowMs) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '') return null;
  if (/^\d{1,9}$/.test(v)) return Math.min(Number(v) * 1000, RETRY_AFTER_CAP_MS);
  const date = Date.parse(v);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.min(date - nowMs, RETRY_AFTER_CAP_MS));
}

function headersToObject(headers) {
  const out = {};
  if (!headers || typeof headers[Symbol.iterator] !== 'function') return out;
  try {
    for (const [k, v] of headers) out[String(k).toLowerCase()] = String(v);
  } catch {
    return {};
  }
  return out;
}

function isAbortError(err) {
  return Boolean(err) && typeof err === 'object' && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.from(chunk);
}

function tooLarge(status, details) {
  return new UpstreamError('Die Antwort der Datenquelle ist zu groß.', {
    code: 'RESPONSE_TOO_LARGE',
    upstreamStatus: status,
    retryable: false,
    details,
  });
}

/**
 * Liest den Antwort-Body mit Größenlimit. Überschreitung → `UpstreamError` (RESPONSE_TOO_LARGE);
 * der Stream wird dabei abgebrochen.
 */
async function readBodyLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    discardBody(response);
    throw tooLarge(response.status, { declaredBytes: declared, limit });
  }
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    // Web-ReadableStream: explizit über den Reader lesen, damit ein Abbruch (cancel) nie
    // blockiert – bei geteilten Streams (tee) löst cancel() erst auf, wenn alle Zweige abgebrochen sind.
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = toBuffer(value);
      total += buf.byteLength;
      if (total > limit) {
        reader.cancel().catch(() => {});
        throw tooLarge(response.status, { readBytes: total, limit });
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    // Node-Streams o. ä.
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = toBuffer(chunk);
      total += buf.byteLength;
      if (total > limit) throw tooLarge(response.status, { readBytes: total, limit }); // beendet die Iteration → Stream wird abgebrochen
      chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
  }
  // Fallback für Antwortobjekte ohne Stream (z. B. einfache Fakes)
  let buf;
  if (typeof response.arrayBuffer === 'function') buf = Buffer.from(await response.arrayBuffer());
  else if (typeof response.text === 'function') buf = Buffer.from(await response.text(), 'utf8');
  else buf = Buffer.alloc(0);
  if (buf.byteLength > limit) throw tooLarge(response.status, { readBytes: buf.byteLength, limit });
  return buf;
}

/** Verwirft einen Body ohne auf den Abbruch zu warten (darf den Fehlerpfad nie blockieren). */
function discardBody(response) {
  try {
    if (response.body && typeof response.body.cancel === 'function') {
      const p = response.body.cancel();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch {
    // Verwerfen des Bodys ist unkritisch.
  }
}

/** Versucht, aus einem Fehler-Body die Meldung (`msg`) zu lesen – nur für interne Details, nie für Clients. */
async function readErrorHint(response) {
  const hint = { upstreamMessage: null };
  try {
    const buf = await readBodyLimited(response, ERROR_BODY_MAX_BYTES);
    const text = buf.toString('utf8').trim();
    if (text === '') return hint;
    try {
      const json = JSON.parse(text);
      const msg = json && typeof json === 'object' ? json.msg ?? json.message ?? json.error : null;
      if (typeof msg === 'string') hint.upstreamMessage = msg.slice(0, 300);
    } catch {
      hint.upstreamMessage = text.slice(0, 300);
    }
  } catch {
    // Fehler-Body ist optional.
  }
  return hint;
}

/**
 * @param {object} options
 * @param {string[]} options.allowedOrigins erlaubte Origins (z. B. `https://v6.db.transport.rest`)
 * @param {string} [options.userAgent]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxResponseBytes]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 * @param {number} [options.retries] zusätzliche Versuche bei wiederholbaren Fehlern
 * @param {number} [options.retryBaseMs] Basis des exponentiellen Backoffs
 * @param {number} [options.retryMaxMs] Obergrenze der Backoff-Wartezeit
 * @param {number} [options.retryAfterMaxMs] 429 wird nur wiederholt, wenn `Retry-After` ≤ dieser Wert ist
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.random] Zufallsquelle für Jitter (0 ≤ x < 1)
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimeoutImpl]
 * @param {(handle: unknown) => void} [options.clearTimeoutImpl]
 */
export function createHttpClient({
  allowedOrigins = [],
  userAgent = DEFAULT_USER_AGENT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
  logger = silentLogger,
  now = () => Date.now(),
  retries = 2,
  retryBaseMs = 500,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  retryAfterMaxMs = DEFAULT_RETRY_AFTER_MAX_MS,
  sleep,
  random = Math.random,
  setTimeoutImpl,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!Array.isArray(allowedOrigins)) throw new TypeError('allowedOrigins muss ein Array sein');
  const allowed = new Set(allowedOrigins.map(normalizeOrigin));
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl muss eine Funktion sein');
  if (typeof now !== 'function') throw new TypeError('now muss eine Funktion sein');
  if (!positiveNumber(timeoutMs)) throw new RangeError('timeoutMs muss eine positive Zahl sein');
  if (!positiveNumber(maxResponseBytes)) throw new RangeError('maxResponseBytes muss eine positive Zahl sein');
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError('retries muss eine ganze Zahl ≥ 0 sein');
  if (!positiveNumber(retryBaseMs)) throw new RangeError('retryBaseMs muss eine positive Zahl sein');
  const ua = typeof userAgent === 'string' && userAgent.trim() !== '' ? userAgent.trim() : DEFAULT_USER_AGENT;
  const log = logger && typeof logger.debug === 'function' ? logger : silentLogger;
  // Timer für den Timeout: injiziert oder unref()t (die offene Verbindung hält die Event-Loop am Leben).
  const schedule = typeof setTimeoutImpl === 'function' ? setTimeoutImpl : defaultSetTimeout;
  // Wartezeit zwischen Wiederholungen: injiziertes `sleep`, sonst injizierte Timer, sonst ein
  // referenzierter Standard-Timer (begrenzt durch retryMaxMs), damit ein laufender Abruf den Prozess
  // nicht mitten in einer Wiederholung beenden lässt.
  let doSleep;
  if (typeof sleep === 'function') doSleep = sleep;
  else if (typeof setTimeoutImpl === 'function') doSleep = (ms) => new Promise((resolve) => { setTimeoutImpl(resolve, ms); });
  else doSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  const counters = {
    requests: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    timeouts: 0,
    rateLimited: 0,
    blocked: 0,
    formatErrors: 0,
    bytesReceived: 0,
    inFlight: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
  };

  if (allowed.size === 0) log.warn('HTTP-Client ohne erlaubte Origins erstellt – alle Upstream-Anfragen werden blockiert');

  /** Prüft URL und Origin-Allowlist; wirft `AppError` (SSRF_BLOCKED) bei Verstößen. */
  function parseTarget(url) {
    const blocked = (reason, details) => new AppError('Upstream-Anfrage wurde aus Sicherheitsgründen blockiert.', {
      statusCode: 500,
      code: 'SSRF_BLOCKED',
      details: { reason, ...details },
    });
    let u;
    try {
      u = url instanceof URL ? new URL(url.href) : new URL(String(url));
    } catch {
      throw blocked('ungültige URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw blocked('unzulässiges Protokoll', { protocol: u.protocol });
    if (u.username !== '' || u.password !== '') throw blocked('Zugangsdaten in URL');
    if (!allowed.has(u.origin)) throw blocked('Origin nicht erlaubt', { origin: u.origin });
    return u;
  }

  /** URL für Logs: ohne Query-String und Fragment. */
  function logUrlOf(u) {
    return `${u.origin}${u.pathname}`;
  }

  function buildHeaders(extra, accept) {
    const h = { 'user-agent': ua, accept };
    if (extra && typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) {
        if (typeof k === 'string' && k.trim() !== '' && typeof v === 'string') h[k.toLowerCase()] = v;
      }
    }
    return h;
  }

  function backoffMs(attempt) {
    const base = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1));
    const jitter = 0.5 + Math.min(Math.max(random(), 0), 0.999999); // Faktor in [0.5, 1.5)
    return Math.max(1, Math.round(base * jitter));
  }

  /** Wartezeit vor dem nächsten Versuch oder `null`, wenn nicht wiederholt wird. */
  function retryDelayFor(err, attempt, maxAttempts) {
    if (attempt >= maxAttempts) return null;
    if (err instanceof RateLimitedError) {
      return err.retryAfterMs !== null && err.retryAfterMs <= retryAfterMaxMs ? err.retryAfterMs : null;
    }
    if (err instanceof UpstreamError && err.retryable) return backoffMs(attempt);
    return null;
  }

  /** Ein einzelner Versuch: Fetch, Statusauswertung, begrenztes Lesen des Bodys. */
  async function attemptOnce(target, { timeoutMs: effTimeout, headers, maxResponseBytes: effMax, accept }) {
    const ac = new AbortController();
    let timedOut = false;
    const timer = schedule(() => {
      timedOut = true;
      ac.abort();
    }, effTimeout);
    const timeoutError = (cause) => {
      counters.timeouts += 1;
      return new UpstreamTimeoutError(undefined, { cause, details: { timeoutMs: effTimeout } });
    };
    try {
      let response;
      try {
        response = await fetchImpl(target.href, {
          method: 'GET',
          headers: buildHeaders(headers, accept),
          redirect: 'manual',
          signal: ac.signal,
        });
      } catch (err) {
        if (timedOut || isAbortError(err)) throw timeoutError(err);
        throw new UpstreamError('Die Datenquelle ist nicht erreichbar.', { code: 'UPSTREAM_NETWORK', retryable: true, cause: err });
      }
      if (!response || typeof response !== 'object' || !Number.isInteger(response.status) || !response.headers || typeof response.headers.get !== 'function') {
        throw new UpstreamFormatError('Ungültiges Antwortobjekt der Datenquelle.');
      }
      const status = response.status;
      if (status >= 300 && status < 400) {
        discardBody(response);
        throw new UpstreamError('Die Datenquelle hat eine Weiterleitung geschickt, der nicht gefolgt wird.', {
          code: 'UPSTREAM_REDIRECT',
          upstreamStatus: status,
          retryable: false,
          details: { location: response.headers.get('location') || null },
        });
      }
      if (status === 429) {
        counters.rateLimited += 1;
        const details = await readErrorHint(response);
        throw new RateLimitedError(undefined, { retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), now()), details });
      }
      if (status >= 500) {
        const details = await readErrorHint(response);
        throw new UpstreamError('Die Datenquelle meldet einen Serverfehler.', { upstreamStatus: status, retryable: true, details });
      }
      if (status >= 400) {
        const details = await readErrorHint(response);
        const message = status === 404
          ? 'Die Datenquelle kennt die angefragte Ressource nicht.'
          : 'Die Datenquelle hat die Anfrage abgelehnt.';
        throw new UpstreamError(message, { upstreamStatus: status, retryable: false, details });
      }
      if (status < 200) {
        discardBody(response);
        throw new UpstreamError('Die Datenquelle hat einen unerwarteten Status geliefert.', { upstreamStatus: status, retryable: false });
      }
      let body;
      try {
        body = await readBodyLimited(response, effMax);
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (timedOut || isAbortError(err)) throw timeoutError(err);
        throw new UpstreamError('Die Verbindung zur Datenquelle wurde unterbrochen.', { code: 'UPSTREAM_NETWORK', retryable: true, cause: err });
      }
      return {
        status,
        body,
        headers: headersToObject(response.headers),
        contentType: response.headers.get('content-type') || null,
      };
    } finally {
      clearTimeoutImpl(timer);
    }
  }

  /**
   * Führt einen GET-Request mit Wiederholungen aus und wendet `transform` auf die Rohantwort an.
   * Fehler aus `transform` (z. B. JSON-Parsing) werden nicht wiederholt.
   */
  async function request(url, options, transform) {
    const opts = options && typeof options === 'object' ? options : {};
    counters.requests += 1;
    let target;
    try {
      target = parseTarget(url);
    } catch (err) {
      counters.blocked += 1;
      counters.failures += 1;
      counters.lastErrorAt = now();
      counters.lastErrorCode = err.code;
      log.warn('Upstream-Anfrage blockiert', { code: err.code, reason: err.details?.reason ?? null, origin: err.details?.origin ?? null });
      throw err;
    }
    const logUrl = logUrlOf(target);
    const effTimeout = positiveNumber(opts.timeoutMs) ?? timeoutMs;
    const effMax = positiveNumber(opts.maxResponseBytes) ?? maxResponseBytes;
    const retryable = opts.retryable !== false;
    const maxAttempts = retryable ? retries + 1 : 1;
    const startedAt = now();
    counters.inFlight += 1;
    let attempt = 0;
    try {
      for (;;) {
        attempt += 1;
        const attemptStartedAt = now();
        try {
          const raw = await attemptOnce(target, { timeoutMs: effTimeout, headers: opts.headers, maxResponseBytes: effMax, accept: opts.accept });
          const durationMs = now() - attemptStartedAt;
          counters.bytesReceived += raw.body.byteLength;
          log.debug('Upstream-Antwort erhalten', { url: logUrl, status: raw.status, durationMs, bytes: raw.body.byteLength, attempt });
          const result = transform(raw); // kann UpstreamFormatError werfen (nicht wiederholbar)
          counters.successes += 1;
          counters.lastSuccessAt = now();
          return { ...result, durationMs: now() - startedAt };
        } catch (err) {
          const e = err instanceof AppError
            ? err
            : new UpstreamError('Unerwarteter Fehler beim Abruf der Datenquelle.', { code: 'UPSTREAM_NETWORK', retryable: true, cause: err });
          const durationMs = now() - attemptStartedAt;
          const delay = retryDelayFor(e, attempt, maxAttempts);
          const fields = { url: logUrl, code: e.code, upstreamStatus: e.upstreamStatus ?? null, attempt, durationMs, err: e };
          if (delay === null) {
            counters.failures += 1;
            counters.lastErrorAt = now();
            counters.lastErrorCode = e.code;
            if (e instanceof UpstreamFormatError) counters.formatErrors += 1;
            log.warn('Upstream-Anfrage fehlgeschlagen', fields);
            throw e;
          }
          counters.retries += 1;
          log.warn('Upstream-Anfrage fehlgeschlagen, erneuter Versuch folgt', { ...fields, retryInMs: delay });
          await doSleep(delay);
        }
      }
    } finally {
      counters.inFlight -= 1;
    }
  }

  function parseJsonBody(raw) {
    let text = raw.body.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.trim() === '') throw new UpstreamFormatError('Die Datenquelle hat eine leere Antwort geliefert.', { upstreamStatus: raw.status });
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new UpstreamFormatError(undefined, { upstreamStatus: raw.status, cause: err, details: { contentType: raw.contentType } });
    }
    return { status: raw.status, data, headers: raw.headers };
  }

  return {
    /**
     * GET mit JSON-Antwort.
     * @param {string|URL} url
     * @param {{timeoutMs?: number, headers?: Record<string,string>, retryable?: boolean, maxResponseBytes?: number}} [options]
     * @returns {Promise<{status: number, data: unknown, headers: Record<string,string>, durationMs: number}>}
     */
    getJson(url, options = {}) {
      return request(url, { ...options, accept: 'application/json' }, parseJsonBody);
    },

    /**
     * GET mit Binärantwort (z. B. Kartenkacheln).
     * @param {string|URL} url
     * @param {{timeoutMs?: number, headers?: Record<string,string>, retryable?: boolean, maxResponseBytes?: number, accept?: string}} [options]
     * @returns {Promise<{status: number, body: Buffer, contentType: string|null, headers: Record<string,string>, durationMs: number}>}
     */
    getBuffer(url, options = {}) {
      const accept = typeof options.accept === 'string' && options.accept !== '' ? options.accept : '*/*';
      return request(url, { ...options, accept }, (raw) => ({
        status: raw.status,
        body: raw.body,
        contentType: raw.contentType,
        headers: raw.headers,
      }));
    },

    /** True, wenn die URL die Allowlist passieren würde (ohne Request). */
    isAllowed(url) {
      try {
        parseTarget(url);
        return true;
      } catch {
        return false;
      }
    },

    stats() {
      return { ...counters, allowedOrigins: Array.from(allowed) };
    },
  };
}
