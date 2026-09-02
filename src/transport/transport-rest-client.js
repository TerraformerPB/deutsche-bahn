/**
 * Upstream-Adapter für transport.rest (v6, REST-Wrapper um die DB-APIs).
 *
 * Verantwortlichkeiten:
 *  - Aufbau der Anfrage-URLs (Abfahrten/Ankünfte, Fahrt, Ortssuche) mit
 *    expliziter Produktliste (alle zehn Produkte als true/false), Sprache,
 *    Remarks und optionalem Profil.
 *  - Strikte Validierung der Eingaben (Stations-ID, Trip-ID, Produkte,
 *    Zeitfenster, Suchtext), bevor Budget verbraucht wird.
 *  - Schutz der Datenquelle: Circuit-Breaker vor jeder Anfrage, danach
 *    Token-Bucket (Anfragebudget). Erfolg/Fehler werden dem Breaker gemeldet;
 *    als Breaker-Fehler zählen 429, 5xx, Timeouts und Netzfehler – nicht
 *    jedoch 4xx (z. B. unbekannte Fahrt) oder Formatfehler, denn dabei ist die
 *    Datenquelle erreichbar.
 *  - Defensive Auswertung der Antwortstruktur und Normalisierung über
 *    `normalize.js`; einzelne unbrauchbare Einträge werden verworfen, eine
 *    falsche Grundstruktur ergibt `UpstreamFormatError`.
 *
 * Alle Abhängigkeiten werden injiziert (`httpClient`, `tokenBucket`, `breaker`,
 * `logger`, `now`); der Client selbst hält keine Timer und keinen Cache.
 */
import {
  AppError, ValidationError, CircuitOpenError, UpstreamError, UpstreamFormatError, RateLimitedError, UpstreamTimeoutError,
} from '../lib/errors.js';
import { silentLogger } from '../logger.js';
import { PRODUCTS, normalizeDeparture, normalizeTrip, normalizeStop, toEpochMs } from './normalize.js';

/** EVA-/IBNR-Nummern: 5–12 Ziffern. */
export const STATION_ID_RE = /^\d{5,12}$/;
/** Trip-IDs (HAFAS-Format mit `|`, `#`, `$`, `@`, `%`, Leerzeichen): 5–512 Zeichen, keine Steuerzeichen. */
export const TRIP_ID_MIN = 5;
export const TRIP_ID_MAX = 512;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const QUERY_MIN = 2;
const QUERY_MAX = 64;
const RESULTS_MAX = 20;
/** Zeitfenster der Abfahrtstafel in Minuten (der Upstream deckelt intern auf 60). */
const DURATION_MIN = 1;
const DURATION_MAX = 1440;
const DEFAULT_DURATION_MIN = 60;
const VALID_PROFILES = ['', 'dbnav', 'db', 'dbweb'];

/**
 * Prüft eine Stations-ID (EVA-Nummer). Zahlen werden akzeptiert und in Strings gewandelt.
 * @param {unknown} value
 * @returns {string}
 */
export function parseStationId(value) {
  const s = typeof value === 'number' && Number.isInteger(value) && value > 0 ? String(value) : value;
  if (typeof s !== 'string' || !STATION_ID_RE.test(s.trim())) {
    throw new ValidationError('Ungültige Bahnhofs-ID. Erwartet werden 5 bis 12 Ziffern.', { details: { field: 'stationId' } });
  }
  return s.trim();
}

/**
 * Prüft eine Trip-ID: String, 5–512 Zeichen, keine Steuerzeichen.
 * @param {unknown} value
 * @returns {string}
 */
export function parseTripId(value) {
  if (typeof value !== 'string') throw new ValidationError('Ungültige Fahrt-ID.', { details: { field: 'tripId' } });
  const s = value.trim();
  if (s.length < TRIP_ID_MIN || s.length > TRIP_ID_MAX || CONTROL_CHARS_RE.test(s)) {
    throw new ValidationError('Ungültige Fahrt-ID.', { details: { field: 'tripId', length: s.length } });
  }
  return s;
}

/**
 * Prüft eine Produktliste (Array oder kommagetrennter String) gegen die zehn bekannten Produkte.
 * @param {unknown} value
 * @param {string[]} fallback wird verwendet, wenn `value` undefined/null ist
 * @returns {string[]} dedupliziert, nicht leer
 */
export function parseProducts(value, fallback) {
  const input = value === undefined || value === null ? fallback : value;
  const list = typeof input === 'string' ? input.split(',') : input;
  if (!Array.isArray(list)) throw new ValidationError('Ungültige Produktliste.', { details: { field: 'products' } });
  const out = [];
  for (const p of list) {
    const s = typeof p === 'string' ? p.trim() : '';
    if (!PRODUCTS.includes(s)) {
      throw new ValidationError('Unbekanntes Produkt in der Produktliste.', { details: { field: 'products', value: typeof p === 'string' ? p.slice(0, 40) : typeof p } });
    }
    if (!out.includes(s)) out.push(s);
  }
  if (out.length === 0) throw new ValidationError('Die Produktliste darf nicht leer sein.', { details: { field: 'products' } });
  return out;
}

function parseDuration(value, fallback) {
  const input = value === undefined || value === null ? fallback : value;
  const n = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
  if (!Number.isInteger(n) || n < DURATION_MIN || n > DURATION_MAX) {
    throw new ValidationError('Ungültiges Zeitfenster (Minuten).', { details: { field: 'duration' } });
  }
  return n;
}

function parseQueryText(value) {
  if (typeof value !== 'string') throw new ValidationError('Ungültiger Suchtext.', { details: { field: 'query' } });
  const s = value.replace(/\s+/g, ' ').trim();
  if (s.length < QUERY_MIN || s.length > QUERY_MAX || CONTROL_CHARS_RE.test(s)) {
    throw new ValidationError(`Der Suchtext muss ${QUERY_MIN} bis ${QUERY_MAX} Zeichen lang sein.`, { details: { field: 'query', length: s.length } });
  }
  return s;
}

function parseResults(value, fallback = 5) {
  const input = value === undefined || value === null ? fallback : value;
  const n = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
  if (!Number.isInteger(n) || n < 1 || n > RESULTS_MAX) {
    throw new ValidationError(`Die Ergebniszahl muss zwischen 1 und ${RESULTS_MAX} liegen.`, { details: { field: 'results' } });
  }
  return n;
}

/**
 * True, wenn ein Fehler als Ausfall der Datenquelle in den Circuit-Breaker
 * einfließen soll: Rate-Limit (429), Timeout, Netzfehler, 5xx bzw. allgemein
 * als wiederholbar markierte Upstream-Fehler. Formatfehler und 4xx zählen nicht.
 * @param {unknown} err
 */
export function isBreakerFailure(err) {
  if (err instanceof UpstreamFormatError) return false;
  if (err instanceof RateLimitedError || err instanceof UpstreamTimeoutError) return true;
  if (err instanceof UpstreamError) {
    if (err.retryable) return true;
    if (Number.isInteger(err.upstreamStatus)) return err.upstreamStatus >= 500 || err.upstreamStatus === 429;
    return err.code === 'UPSTREAM_NETWORK';
  }
  return false;
}

function validateBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('config.baseUrl muss eine http(s)-URL sein');
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    throw new TypeError('config.baseUrl ist keine gültige URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError('config.baseUrl muss eine http(s)-URL sein');
  if (u.username !== '' || u.password !== '') throw new TypeError('config.baseUrl darf keine Zugangsdaten enthalten');
  if (u.search !== '' || u.hash !== '') throw new TypeError('config.baseUrl darf keinen Query-String oder Fragment enthalten');
  return u.toString().replace(/\/+$/, '');
}

/** Token-Bucket-Ersatz ohne Begrenzung (falls kein Budget injiziert wird). */
const passThroughBucket = Object.freeze({ take: () => Promise.resolve(), available: () => Infinity });
/** Breaker-Ersatz, der nie öffnet (falls kein Breaker injiziert wird). */
const passThroughBreaker = Object.freeze({
  canRequest: () => true, recordSuccess: () => {}, recordFailure: () => {}, state: () => 'closed', snapshot: () => ({ state: 'closed', nextTryAt: null }),
});

/**
 * @typedef {object} TransportClientConfig
 * @property {string} baseUrl z. B. `https://v6.db.transport.rest`
 * @property {''|'dbnav'|'db'|'dbweb'} [profile]
 * @property {string} [language]
 * @property {number} [timeoutMs]
 * @property {string[]} [products] Standard-Produkte für Abfahrtstafeln
 * @property {number} [hubBoardDurationMin] Standard-Zeitfenster der Abfahrtstafel
 */

/**
 * @param {object} options
 * @param {TransportClientConfig} options.config `config.transport`
 * @param {{getJson: Function}} options.httpClient
 * @param {{take: Function, available?: Function}} [options.tokenBucket]
 * @param {{canRequest: Function, recordSuccess: Function, recordFailure: Function, state?: Function, snapshot?: Function}} [options.breaker]
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 */
export function createTransportClient({
  config,
  httpClient,
  tokenBucket = passThroughBucket,
  breaker = passThroughBreaker,
  logger = silentLogger,
  now = () => Date.now(),
} = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('config (config.transport) ist erforderlich');
  const baseUrl = validateBaseUrl(config.baseUrl);
  if (!httpClient || typeof httpClient.getJson !== 'function') throw new TypeError('httpClient mit getJson() ist erforderlich');
  if (!tokenBucket || typeof tokenBucket.take !== 'function') throw new TypeError('tokenBucket mit take() ist erforderlich');
  if (!breaker || typeof breaker.canRequest !== 'function' || typeof breaker.recordSuccess !== 'function' || typeof breaker.recordFailure !== 'function') {
    throw new TypeError('breaker mit canRequest()/recordSuccess()/recordFailure() ist erforderlich');
  }
  if (typeof now !== 'function') throw new TypeError('now muss eine Funktion sein');
  const profile = typeof config.profile === 'string' && VALID_PROFILES.includes(config.profile) ? config.profile : '';
  const language = typeof config.language === 'string' && /^[a-z]{2}$/.test(config.language) ? config.language : 'de';
  const timeoutMs = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : undefined;
  const defaultProducts = parseProducts(config.products, ['nationalExpress']);
  const defaultDuration = parseDuration(config.hubBoardDurationMin, DEFAULT_DURATION_MIN);
  const log = logger && typeof logger.debug === 'function' ? logger : silentLogger;

  const endpointNames = ['departures', 'arrivals', 'trips', 'locations'];
  const counters = {
    requests: 0,
    successes: 0,
    failures: 0,
    circuitRejected: 0,
    budgetRejected: 0,
    validationErrors: 0,
    inFlight: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    endpoints: Object.fromEntries(endpointNames.map((n) => [n, { requests: 0, successes: 0, failures: 0 }])),
  };

  /** Baut eine Upstream-URL mit den Standardparametern. */
  function buildUrl(path, params) {
    const u = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
    if (profile !== '') u.searchParams.set('profile', profile);
    u.searchParams.set('pretty', 'false');
    return u;
  }

  function productParams(selected) {
    const out = {};
    for (const p of PRODUCTS) out[p] = selected.includes(p) ? 'true' : 'false';
    return out;
  }

  function boardUrl(kind, stationId, duration, products) {
    return buildUrl(`/stops/${stationId}/${kind}`, {
      duration,
      language,
      remarks: 'true',
      ...productParams(products),
    });
  }

  function markError(endpoint, err) {
    counters.failures += 1;
    counters.endpoints[endpoint].failures += 1;
    counters.lastErrorAt = now();
    counters.lastErrorCode = typeof err.code === 'string' ? err.code : 'INTERNAL';
  }

  /**
   * Führt eine Upstream-Anfrage mit Breaker- und Budgetprüfung aus und wendet
   * `parse` auf die Rohdaten an. Fehler aus `parse` (Formatfehler) zählen als
   * fehlgeschlagene Anfrage, aber nicht als Breaker-Fehler.
   * @template T
   * @param {'departures'|'arrivals'|'trips'|'locations'} endpoint
   * @param {URL} url
   * @param {object} logFields Kontext für Logs (ohne Query-Strings)
   * @param {(data: unknown, status: number) => T} parse
   * @returns {Promise<T>}
   */
  async function request(endpoint, url, logFields, parse) {
    counters.requests += 1;
    counters.endpoints[endpoint].requests += 1;

    if (!breaker.canRequest()) {
      counters.circuitRejected += 1;
      const snap = typeof breaker.snapshot === 'function' ? breaker.snapshot() : null;
      const err = new CircuitOpenError(undefined, { nextTryAt: snap && Number.isFinite(snap.nextTryAt) ? snap.nextTryAt : null });
      markError(endpoint, err);
      log.debug('Upstream-Anfrage vom Circuit-Breaker zurückgehalten', { endpoint, ...logFields, nextTryAt: err.nextTryAt });
      throw err;
    }
    // Ab hier ist im Zustand half-open ein Probeplatz belegt; jeder Ausgang muss
    // recordSuccess()/recordFailure() auslösen, sonst bleibt die Probe bis zur
    // Abkühlzeit belegt.
    try {
      await tokenBucket.take(1);
    } catch (cause) {
      counters.budgetRejected += 1;
      // Kein Urteil über die Datenquelle möglich – Probe freigeben, ohne den Breaker zu öffnen.
      breaker.recordSuccess();
      const err = new AppError('Das Anfragebudget für die Datenquelle steht derzeit nicht zur Verfügung.', {
        statusCode: 503,
        code: 'BUDGET_UNAVAILABLE',
        cause,
      });
      markError(endpoint, err);
      log.warn('Anfragebudget nicht verfügbar', { endpoint, ...logFields, err });
      throw err;
    }

    counters.inFlight += 1;
    const startedAt = now();
    try {
      let res;
      try {
        res = await httpClient.getJson(url, timeoutMs ? { timeoutMs } : {});
      } catch (raw) {
        const err = raw instanceof AppError
          ? raw
          : new UpstreamError('Unerwarteter Fehler beim Abruf der Datenquelle.', { code: 'UPSTREAM_NETWORK', retryable: true, cause: raw });
        if (isBreakerFailure(err)) breaker.recordFailure(err);
        else breaker.recordSuccess(); // Datenquelle erreichbar (4xx/Format) – Probe freigeben
        markError(endpoint, err);
        log.warn('Upstream-Anfrage fehlgeschlagen', {
          endpoint, ...logFields, code: err.code, upstreamStatus: err.upstreamStatus ?? null, durationMs: now() - startedAt, err,
        });
        throw err;
      }
      // Die Datenquelle hat geantwortet – für den Breaker ein Erfolg, unabhängig vom Inhalt.
      breaker.recordSuccess();
      const status = res && Number.isInteger(res.status) ? res.status : null;
      let value;
      try {
        value = parse(res ? res.data : undefined, status);
      } catch (raw) {
        const err = raw instanceof AppError
          ? raw
          : new UpstreamFormatError(undefined, { upstreamStatus: status, cause: raw });
        markError(endpoint, err);
        log.warn('Upstream-Antwort nicht verwertbar', { endpoint, ...logFields, code: err.code, status, durationMs: now() - startedAt, err });
        throw err;
      }
      counters.successes += 1;
      counters.endpoints[endpoint].successes += 1;
      counters.lastSuccessAt = now();
      log.debug('Upstream-Antwort verarbeitet', { endpoint, ...logFields, status, durationMs: now() - startedAt });
      return value;
    } finally {
      counters.inFlight -= 1;
    }
  }

  /** Liest die Liste einer Abfahrtstafel (`{departures:[…]}` bzw. `{arrivals:[…]}`, tolerant auch nacktes Array). */
  function extractList(data, key) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && Array.isArray(data[key])) return data[key];
    throw new UpstreamFormatError('Die Abfahrtstafel der Datenquelle hat ein unerwartetes Format.', { details: { expected: key } });
  }

  function realtimeOf(data) {
    return data && typeof data === 'object' && !Array.isArray(data) ? toEpochMs(data.realtimeDataUpdatedAt) : null;
  }

  function normalizeList(list, endpoint, logFields) {
    const out = [];
    let dropped = 0;
    for (const raw of list) {
      const n = normalizeDeparture(raw);
      if (n) out.push(n);
      else dropped += 1;
    }
    if (dropped > 0) log.debug('Unbrauchbare Einträge der Abfahrtstafel verworfen', { endpoint, ...logFields, dropped });
    return out;
  }

  async function fetchBoard(kind, stationId, options) {
    const id = parseStationId(stationId);
    const duration = parseDuration(options.duration, defaultDuration);
    const products = parseProducts(options.products, defaultProducts);
    const logFields = { stationId: id };
    const url = boardUrl(kind, id, duration, products);
    return request(kind, url, logFields, (data) => {
      const list = extractList(data, kind);
      return {
        stationId: id,
        [kind]: normalizeList(list, kind, logFields),
        realtimeDataUpdatedAt: realtimeOf(data),
        fetchedAt: now(),
        duration,
        products,
      };
    });
  }

  const client = {
    /**
     * Abfahrten eines Bahnhofs.
     * @param {string|number} stationId EVA-Nummer
     * @param {{duration?: number, products?: string[]|string, includeArrivals?: boolean}} [options]
     * @returns {Promise<{stationId:string, departures: Array, arrivals?: Array|null, arrivalsError?: string, realtimeDataUpdatedAt:number|null, fetchedAt:number}>}
     */
    async departures(stationId, options = {}) {
      const opts = options && typeof options === 'object' ? options : {};
      const result = await fetchBoard('departures', stationId, opts);
      if (opts.includeArrivals === true) {
        try {
          const a = await fetchBoard('arrivals', stationId, { duration: result.duration, products: result.products });
          result.arrivals = a.arrivals;
          if (result.realtimeDataUpdatedAt === null) result.realtimeDataUpdatedAt = a.realtimeDataUpdatedAt;
        } catch (err) {
          // Ankünfte sind Zusatzinformation: Abfahrten trotzdem liefern, Fehler kennzeichnen.
          result.arrivals = null;
          result.arrivalsError = err instanceof AppError ? err.code : 'INTERNAL';
          log.warn('Ankünfte konnten nicht geladen werden, Abfahrten werden ohne Ankünfte geliefert', { stationId: result.stationId, code: result.arrivalsError });
        }
      }
      return result;
    },

    /**
     * Ankünfte eines Bahnhofs (`direction` enthält die Herkunft/`provenance`).
     * @param {string|number} stationId
     * @param {{duration?: number, products?: string[]|string}} [options]
     * @returns {Promise<{stationId:string, arrivals: Array, realtimeDataUpdatedAt:number|null, fetchedAt:number}>}
     */
    arrivals(stationId, options = {}) {
      return fetchBoard('arrivals', stationId, options && typeof options === 'object' ? options : {});
    },

    /**
     * Eine Fahrt mit Zwischenhalten, Remarks und (optional) Polyline.
     * @param {string} tripId HAFAS-Trip-ID (wird URL-kodiert)
     * @param {{polyline?: boolean}} [options]
     * @returns {Promise<{trip: object, realtimeDataUpdatedAt:number|null, fetchedAt:number}>}
     */
    async trip(tripId, options = {}) {
      const id = parseTripId(tripId);
      const opts = options && typeof options === 'object' ? options : {};
      const withPolyline = opts.polyline !== false;
      const url = buildUrl(`/trips/${encodeURIComponent(id)}`, {
        stopovers: 'true',
        remarks: 'true',
        polyline: withPolyline ? 'true' : 'false',
        language,
      });
      const logFields = { tripId: id.length > 40 ? `${id.slice(0, 40)}…` : id };
      return request('trips', url, logFields, (data) => {
        const rawTrip = data && typeof data === 'object' && !Array.isArray(data)
          ? (data.trip && typeof data.trip === 'object' ? data.trip : (typeof data.id === 'string' ? data : null))
          : null;
        if (!rawTrip) throw new UpstreamFormatError('Die Fahrt der Datenquelle hat ein unerwartetes Format.', { details: { reason: 'trip fehlt' } });
        const fetchedAt = now();
        const trip = normalizeTrip(rawTrip, { fetchedAt, realtimeDataUpdatedAt: data.realtimeDataUpdatedAt });
        if (trip.id !== id) {
          // Die Datenquelle kann IDs umschreiben; die angefragte ID bleibt maßgeblich für Store und Clients.
          log.debug('Datenquelle lieferte abweichende Fahrt-ID, angefragte ID wird beibehalten', logFields);
          trip.id = id;
        }
        return { trip, realtimeDataUpdatedAt: trip.realtimeDataUpdatedAt, fetchedAt };
      });
    },

    /**
     * Ortssuche (nur Stationen/Haltestellen, keine Adressen/POIs).
     * @param {string} query 2–64 Zeichen
     * @param {{results?: number}} [options]
     * @returns {Promise<Array<{id:string, name:string, lat:number|null, lon:number|null}>>}
     */
    async locations(query, options = {}) {
      const q = parseQueryText(query);
      const opts = options && typeof options === 'object' ? options : {};
      const results = parseResults(opts.results, 5);
      const url = buildUrl('/locations', {
        query: q,
        results,
        stops: 'true',
        addresses: 'false',
        poi: 'false',
        language,
      });
      return request('locations', url, { results }, (data) => {
        const list = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray(data.locations) ? data.locations : null);
        if (!list) throw new UpstreamFormatError('Die Ortssuche der Datenquelle hat ein unerwartetes Format.');
        const out = [];
        const seen = new Set();
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          if (item.type !== 'station' && item.type !== 'stop') continue;
          const stop = normalizeStop(item);
          if (stop.id === null || seen.has(stop.id)) continue;
          seen.add(stop.id);
          out.push(stop);
          if (out.length >= results) break;
        }
        return out;
      });
    },

    /** Kennzahlen des Adapters (inkl. Breaker-Zustand und verfügbarem Budget). */
    stats() {
      let available = null;
      if (typeof tokenBucket.available === 'function') {
        const a = tokenBucket.available();
        available = Number.isFinite(a) ? Math.floor(a) : null;
      }
      return {
        ...counters,
        endpoints: Object.fromEntries(Object.entries(counters.endpoints).map(([k, v]) => [k, { ...v }])),
        breaker: typeof breaker.state === 'function' ? breaker.state() : 'closed',
        budget: { available },
        baseUrlHost: new URL(baseUrl).host,
        profile,
        products: [...defaultProducts],
      };
    },
  };

  return client;
}
