/**
 * Zentrale Fehlerklassen der Anwendung.
 *
 * Jede Fehlerklasse trägt einen HTTP-Status (`statusCode`) für die eigene API
 * und einen maschinenlesbaren Code (`code`). Interne Details (`details`,
 * `cause`, Stacktraces, Upstream-URLs) verlassen den Server nie – nach außen
 * geht ausschließlich `toPublicJson(err)`.
 *
 * Hierarchie:
 *   AppError
 *   ├─ ValidationError        400 VALIDATION
 *   ├─ NotFoundError          404 NOT_FOUND
 *   ├─ CircuitOpenError       503 CIRCUIT_OPEN
 *   └─ UpstreamError          502 UPSTREAM_ERROR   (upstreamStatus, retryable)
 *      ├─ UpstreamTimeoutError   504 UPSTREAM_TIMEOUT
 *      ├─ RateLimitedError       503 UPSTREAM_RATE_LIMITED (retryAfterMs)
 *      └─ UpstreamFormatError    502 UPSTREAM_FORMAT
 *
 * Die Upstream-Unterklassen erben von `UpstreamError`, damit Aufrufer mit
 * `err instanceof UpstreamError` alle Probleme der Datenquelle gemeinsam
 * behandeln können; der `code` bleibt je Klasse eindeutig.
 */

/** Öffentliche Standardmeldung für unbekannte Fehler (nie interne Details). */
const INTERNAL_MESSAGE = 'Interner Fehler. Bitte versuchen Sie es später erneut.';

/**
 * @typedef {object} AppErrorOptions
 * @property {number} [statusCode] HTTP-Status für die eigene API
 * @property {string} [code] maschinenlesbarer Fehlercode
 * @property {unknown} [cause] ursprünglicher Fehler
 * @property {object} [details] interne Zusatzinformationen (nie an Clients)
 */

export class AppError extends Error {
  /**
   * @param {string} message
   * @param {AppErrorOptions} [options]
   */
  constructor(message, { statusCode = 500, code = 'INTERNAL', cause, details } = {}) {
    super(typeof message === 'string' && message !== '' ? message : INTERNAL_MESSAGE, cause !== undefined ? { cause } : undefined);
    this.name = 'AppError';
    this.statusCode = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 500;
    this.code = typeof code === 'string' && code !== '' ? code : 'INTERNAL';
    this.details = details && typeof details === 'object' ? details : null;
  }

  /** Serialisierung für Logs (ohne Stack – der Logger ergänzt ihn selbst). */
  toJSON() {
    return { name: this.name, code: this.code, statusCode: this.statusCode, message: this.message };
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Ungültige Eingabe.', options = {}) {
    super(message, { statusCode: 400, code: 'VALIDATION', ...options });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Nicht gefunden.', options = {}) {
    super(message, { statusCode: 404, code: 'NOT_FOUND', ...options });
    this.name = 'NotFoundError';
  }
}

/**
 * Fehler beim Abruf einer externen Datenquelle.
 * `retryable` signalisiert, ob ein erneuter Versuch sinnvoll ist (5xx, Netz, Timeout).
 */
export class UpstreamError extends AppError {
  /**
   * @param {string} message
   * @param {AppErrorOptions & {upstreamStatus?: number|null, retryable?: boolean}} [options]
   */
  constructor(message = 'Die Datenquelle hat einen Fehler gemeldet.', { upstreamStatus = null, retryable = false, ...options } = {}) {
    super(message, { statusCode: 502, code: 'UPSTREAM_ERROR', ...options });
    this.name = 'UpstreamError';
    this.upstreamStatus = Number.isInteger(upstreamStatus) ? upstreamStatus : null;
    this.retryable = retryable === true;
  }
}

export class UpstreamTimeoutError extends UpstreamError {
  constructor(message = 'Die Datenquelle hat nicht rechtzeitig geantwortet.', options = {}) {
    super(message, { statusCode: 504, code: 'UPSTREAM_TIMEOUT', retryable: true, ...options });
    this.name = 'UpstreamTimeoutError';
  }
}

/** Die Datenquelle drosselt uns (HTTP 429). `retryAfterMs` stammt aus `Retry-After`, sonst `null`. */
export class RateLimitedError extends UpstreamError {
  /**
   * @param {string} message
   * @param {AppErrorOptions & {upstreamStatus?: number|null, retryable?: boolean, retryAfterMs?: number|null}} [options]
   */
  constructor(message = 'Die Datenquelle ist derzeit ausgelastet (Anfragelimit erreicht).', { retryAfterMs = null, ...options } = {}) {
    super(message, { statusCode: 503, code: 'UPSTREAM_RATE_LIMITED', upstreamStatus: 429, retryable: true, ...options });
    this.name = 'RateLimitedError';
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? Math.round(retryAfterMs) : null;
  }
}

/** Der Circuit-Breaker blockiert Anfragen an die Datenquelle. */
export class CircuitOpenError extends AppError {
  /**
   * @param {string} message
   * @param {AppErrorOptions & {nextTryAt?: number|null}} [options]
   */
  constructor(message = 'Die Datenquelle ist vorübergehend nicht erreichbar. Anfragen werden derzeit zurückgehalten.', { nextTryAt = null, ...options } = {}) {
    super(message, { statusCode: 503, code: 'CIRCUIT_OPEN', ...options });
    this.name = 'CircuitOpenError';
    this.nextTryAt = Number.isFinite(nextTryAt) ? nextTryAt : null;
  }
}

/** Die Antwort der Datenquelle hat ein unerwartetes Format (kein JSON, falsche Struktur). */
export class UpstreamFormatError extends UpstreamError {
  constructor(message = 'Die Antwort der Datenquelle hat ein unerwartetes Format.', options = {}) {
    super(message, { statusCode: 502, code: 'UPSTREAM_FORMAT', retryable: false, ...options });
    this.name = 'UpstreamFormatError';
  }
}

/** True, wenn `err` ein AppError (oder eine Unterklasse) ist. */
export function isAppError(err) {
  return err instanceof AppError;
}

/** HTTP-Status, mit dem ein beliebiger Fehler an Clients beantwortet wird. */
export function httpStatusOf(err) {
  if (isAppError(err)) return err.statusCode;
  const s = err && typeof err === 'object' ? err.statusCode ?? err.status : undefined;
  return Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500;
}

/**
 * Öffentliche JSON-Darstellung eines Fehlers: `{error: {code, message}}`.
 * Nicht-AppErrors werden vollständig maskiert, damit keine internen
 * Informationen (Stack, URLs, Meldungen fremder Bibliotheken) nach außen gelangen.
 * @param {unknown} err
 * @returns {{error: {code: string, message: string}}}
 */
export function toPublicJson(err) {
  if (isAppError(err)) {
    return { error: { code: err.code, message: err.message } };
  }
  return { error: { code: 'INTERNAL', message: INTERNAL_MESSAGE } };
}
