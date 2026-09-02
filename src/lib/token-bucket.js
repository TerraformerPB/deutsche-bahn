/**
 * Token-Bucket zur Begrenzung der Anfragerate an externe Datenquellen.
 *
 * Der Eimer füllt sich kontinuierlich mit `ratePerMin` Token pro Minute bis
 * zur Kapazität `burst`. `tryTake` entnimmt sofort oder gar nicht, `take`
 * wartet fair (FIFO), bis genügend Token vorhanden sind.
 *
 * Zeit und Timer sind injizierbar (`now`, `setTimeoutImpl`, `clearTimeoutImpl`),
 * damit Tests mit einer Fake-Uhr laufen und der Prozess beim Herunterfahren
 * nicht durch anstehende Timer blockiert wird (`unref`).
 */

const MINUTE_MS = 60_000;

function defaultSetTimeout(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

/**
 * @param {object} options
 * @param {number} options.ratePerMin Nachfüllrate (Token pro Minute), > 0
 * @param {number} [options.burst] Kapazität des Eimers (Standard: ratePerMin), ≥ 1
 * @param {() => number} [options.now] Zeitquelle in Epoch-Millisekunden
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimeoutImpl]
 * @param {(handle: unknown) => void} [options.clearTimeoutImpl]
 */
export function createTokenBucket({
  ratePerMin,
  burst = ratePerMin,
  now = () => Date.now(),
  setTimeoutImpl = defaultSetTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!Number.isFinite(ratePerMin) || ratePerMin <= 0) throw new RangeError('ratePerMin muss eine positive Zahl sein');
  if (!Number.isFinite(burst) || burst < 1) throw new RangeError('burst muss eine Zahl ≥ 1 sein');
  if (typeof now !== 'function') throw new TypeError('now muss eine Funktion sein');

  const ratePerMs = ratePerMin / MINUTE_MS;
  let tokens = burst; // voller Eimer zum Start
  let lastRefillAt = now();
  /** @type {Array<{n:number, resolve:() => void, reject:(e:Error) => void}>} */
  const waiters = [];
  let timer = null;
  const counters = { taken: 0, denied: 0, waited: 0 };

  function validateCount(n) {
    if (!Number.isInteger(n) || n < 1) throw new RangeError('Anzahl der Token muss eine ganze Zahl ≥ 1 sein');
    if (n > burst) throw new RangeError(`Anzahl der Token (${n}) übersteigt die Kapazität (${burst})`);
    return n;
  }

  function refill() {
    const t = now();
    if (t > lastRefillAt) {
      tokens = Math.min(burst, tokens + (t - lastRefillAt) * ratePerMs);
      lastRefillAt = t;
    } else if (t < lastRefillAt) {
      // Uhr wurde zurückgestellt: nicht negativ verrechnen, nur Bezugspunkt anpassen.
      lastRefillAt = t;
    }
  }

  function msUntil(n) {
    refill();
    if (tokens >= n) return 0;
    return Math.ceil((n - tokens) / ratePerMs);
  }

  function takeNow(n) {
    refill();
    if (tokens >= n) {
      tokens -= n;
      counters.taken += n;
      return true;
    }
    return false;
  }

  /** Bedient die Warteschlange in Reihenfolge; plant bei Bedarf den nächsten Timer. */
  function drain() {
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    while (waiters.length > 0) {
      const head = waiters[0];
      if (!takeNow(head.n)) break;
      waiters.shift();
      head.resolve();
    }
    if (waiters.length > 0) {
      const wait = Math.max(1, msUntil(waiters[0].n));
      timer = setTimeoutImpl(() => {
        timer = null;
        drain();
      }, wait);
    }
  }

  return {
    /** Entnimmt `n` Token sofort, falls verfügbar. */
    tryTake(n = 1) {
      validateCount(n);
      // Wartende haben Vorrang, damit die Reihenfolge fair bleibt.
      if (waiters.length > 0 || !takeNow(n)) {
        counters.denied += 1;
        return false;
      }
      return true;
    },

    /** Wartet, bis `n` Token verfügbar sind, und entnimmt sie dann (FIFO). */
    take(n = 1) {
      try {
        validateCount(n);
      } catch (err) {
        return Promise.reject(err);
      }
      if (waiters.length === 0 && takeNow(n)) return Promise.resolve();
      counters.waited += 1;
      return new Promise((resolve, reject) => {
        waiters.push({ n, resolve, reject });
        if (waiters.length === 1) drain();
      });
    },

    /** Aktuell verfügbare Token (ohne Berücksichtigung Wartender). */
    available() {
      refill();
      return tokens;
    },

    /** Millisekunden bis `n` Token verfügbar sind (0 = sofort). */
    msUntilAvailable(n = 1) {
      validateCount(n);
      return msUntil(n);
    },

    stats() {
      refill();
      return {
        ratePerMin,
        burst,
        available: tokens,
        waiting: waiters.length,
        taken: counters.taken,
        denied: counters.denied,
        waited: counters.waited,
      };
    },

    /** Weist alle Wartenden ab und stoppt den Timer (für geordnetes Herunterfahren). */
    close() {
      if (timer !== null) {
        clearTimeoutImpl(timer);
        timer = null;
      }
      const pending = waiters.splice(0, waiters.length);
      for (const w of pending) w.reject(new Error('Token-Bucket wurde geschlossen'));
    },
  };
}
