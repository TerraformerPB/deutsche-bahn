/**
 * Circuit-Breaker für externe Datenquellen.
 *
 * Zustände:
 *   closed    – Anfragen erlaubt; aufeinanderfolgende Fehler werden gezählt.
 *   open      – nach `failureThreshold` Fehlern: Anfragen werden für `cooldownMs` blockiert.
 *   half-open – nach Ablauf der Abkühlzeit: höchstens `halfOpenMax` Probeanfragen;
 *               ein Erfolg schließt den Kreis, ein Fehler öffnet ihn erneut.
 *
 * Die Zeitquelle ist injizierbar (`now`), es laufen keine Timer; Übergänge
 * werden bei jedem Aufruf anhand der Uhr berechnet.
 */

function summarizeError(err, at) {
  if (err === undefined || err === null) return { name: 'Error', code: null, message: 'unbekannter Fehler', statusCode: null, at };
  if (err instanceof Error) {
    return {
      name: err.name,
      code: typeof err.code === 'string' ? err.code : null,
      message: err.message,
      statusCode: Number.isInteger(err.statusCode) ? err.statusCode : null,
      at,
    };
  }
  return { name: 'Error', code: null, message: String(err), statusCode: null, at };
}

/**
 * @param {object} options
 * @param {number} [options.failureThreshold] aufeinanderfolgende Fehler bis zum Öffnen (≥ 1)
 * @param {number} options.cooldownMs Sperrzeit im Zustand `open` (> 0)
 * @param {number} [options.halfOpenMax] gleichzeitige Probeanfragen im Zustand `half-open` (≥ 1)
 * @param {() => number} [options.now] Zeitquelle in Epoch-Millisekunden
 * @param {(from: string, to: string, snapshot: object) => void} [options.onStateChange] optionaler Hook (z. B. für Logs)
 */
export function createCircuitBreaker({
  failureThreshold = 3,
  cooldownMs,
  halfOpenMax = 1,
  now = () => Date.now(),
  onStateChange,
} = {}) {
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new RangeError('failureThreshold muss eine ganze Zahl ≥ 1 sein');
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) throw new RangeError('cooldownMs muss eine positive Zahl sein');
  if (!Number.isInteger(halfOpenMax) || halfOpenMax < 1) throw new RangeError('halfOpenMax muss eine ganze Zahl ≥ 1 sein');
  if (typeof now !== 'function') throw new TypeError('now muss eine Funktion sein');

  /** @type {'closed'|'open'|'half-open'} */
  let state = 'closed';
  let failures = 0; // aufeinanderfolgende Fehler
  let openedAt = null;
  let nextTryAt = null;
  let halfOpenInFlight = 0;
  let halfOpenSince = null;
  let lastError = null;
  let lastFailureAt = null;
  let lastSuccessAt = null;
  const counters = { opens: 0, successes: 0, failures: 0, rejected: 0 };

  function transition(to) {
    if (state === to) return;
    const from = state;
    state = to;
    if (typeof onStateChange === 'function') {
      try {
        onStateChange(from, to, snapshot());
      } catch {
        // Hook-Fehler dürfen den Breaker nicht beeinträchtigen.
      }
    }
  }

  function open(t) {
    failures = Math.max(failures, failureThreshold);
    openedAt = t;
    nextTryAt = t + cooldownMs;
    halfOpenInFlight = 0;
    halfOpenSince = null;
    counters.opens += 1;
    transition('open');
  }

  function close() {
    failures = 0;
    openedAt = null;
    nextTryAt = null;
    halfOpenInFlight = 0;
    halfOpenSince = null;
    transition('closed');
  }

  /** Wendet zeitabhängige Übergänge an (open → half-open nach Ablauf der Abkühlzeit). */
  function settle() {
    const t = now();
    if (state === 'open' && nextTryAt !== null && t >= nextTryAt) {
      halfOpenInFlight = 0;
      halfOpenSince = t;
      transition('half-open');
    }
    return t;
  }

  function snapshot() {
    return {
      state,
      failures,
      failureThreshold,
      cooldownMs,
      openedAt,
      nextTryAt,
      halfOpenInFlight,
      lastError,
      lastFailureAt,
      lastSuccessAt,
      opens: counters.opens,
      totalSuccesses: counters.successes,
      totalFailures: counters.failures,
      rejected: counters.rejected,
    };
  }

  return {
    /** True, wenn eine Anfrage gestellt werden darf. Im Zustand `half-open` wird ein Probeplatz belegt. */
    canRequest() {
      const t = settle();
      if (state === 'closed') return true;
      if (state === 'open') {
        counters.rejected += 1;
        return false;
      }
      // half-open: begrenzte Zahl an Probeanfragen. Bleibt eine Probe ohne Rückmeldung
      // (z. B. Aufrufer hat nie recordSuccess/recordFailure gerufen), wird nach einer
      // Abkühlzeit ein weiterer Versuch zugelassen, damit der Breaker nicht hängen bleibt.
      if (halfOpenInFlight >= halfOpenMax && halfOpenSince !== null && t - halfOpenSince >= cooldownMs) {
        halfOpenInFlight = 0;
        halfOpenSince = t;
      }
      if (halfOpenInFlight < halfOpenMax) {
        halfOpenInFlight += 1;
        return true;
      }
      counters.rejected += 1;
      return false;
    },

    recordSuccess() {
      const t = settle();
      counters.successes += 1;
      lastSuccessAt = t;
      if (state === 'half-open' || state === 'open') {
        // Erfolg einer Probe (oder verspätete Erfolgsmeldung): Kreis schließen.
        close();
        return;
      }
      failures = 0;
    },

    /** @param {unknown} [err] */
    recordFailure(err) {
      const t = settle();
      counters.failures += 1;
      lastFailureAt = t;
      lastError = summarizeError(err, t);
      if (state === 'half-open') {
        open(t);
        return;
      }
      if (state === 'open') {
        // Verspätete Fehlermeldung während der Sperre: Sperre nicht verlängern.
        return;
      }
      failures += 1;
      if (failures >= failureThreshold) open(t);
    },

    /** @returns {'closed'|'open'|'half-open'} */
    state() {
      settle();
      return state;
    },

    snapshot() {
      settle();
      return snapshot();
    },

    /** Setzt den Breaker manuell zurück (z. B. nach Konfigurationsänderung). */
    reset() {
      lastError = null;
      close();
    },
  };
}
