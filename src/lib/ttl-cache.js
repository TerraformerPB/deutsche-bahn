/**
 * Kleiner In-Memory-Cache mit Ablaufzeit (TTL) und LRU-Verdrängung.
 *
 * Grundlage ist eine `Map`, deren Einfügereihenfolge als LRU-Ordnung dient:
 * ein Treffer (`get`) verschiebt den Eintrag ans Ende, bei Überschreiten von
 * `maxEntries` wird der am längsten nicht genutzte Eintrag (am Anfang) entfernt.
 *
 * Die Zeitquelle ist injizierbar (`now`), es laufen keine Timer.
 */

/**
 * @template V
 * @param {object} [options]
 * @param {number} [options.maxEntries] Kapazität (≥ 1)
 * @param {number} [options.defaultTtlMs] Standard-Lebensdauer; ohne Angabe verfallen Einträge nicht
 * @param {() => number} [options.now] Zeitquelle in Epoch-Millisekunden
 */
export function createTtlCache({ maxEntries = 1000, defaultTtlMs = Infinity, now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries muss eine ganze Zahl ≥ 1 sein');
  if (!(defaultTtlMs > 0)) throw new RangeError('defaultTtlMs muss eine positive Zahl (oder Infinity) sein');
  if (typeof now !== 'function') throw new TypeError('now muss eine Funktion sein');

  /** @type {Map<unknown, {value: V, expiresAt: number, createdAt: number}>} */
  const entries = new Map();
  const counters = { hits: 0, misses: 0, evictions: 0, expired: 0 };

  function isExpired(entry, t) {
    return entry.expiresAt <= t;
  }

  /** Entfernt alle abgelaufenen Einträge; gibt die Anzahl zurück. */
  function prune() {
    const t = now();
    let removed = 0;
    for (const [key, entry] of entries) {
      if (isExpired(entry, t)) {
        entries.delete(key);
        removed += 1;
      }
    }
    counters.expired += removed;
    return removed;
  }

  function resolveTtl(ttlMs) {
    if (ttlMs === undefined || ttlMs === null) return defaultTtlMs;
    if (typeof ttlMs !== 'number' || Number.isNaN(ttlMs) || ttlMs < 0) throw new RangeError('ttlMs muss eine Zahl ≥ 0 sein');
    return ttlMs;
  }

  return {
    /**
     * Liefert den Wert oder `undefined` (fehlend/abgelaufen). Zählt als Treffer/Fehlschlag
     * und aktualisiert die LRU-Position.
     */
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) {
        counters.misses += 1;
        return undefined;
      }
      if (isExpired(entry, now())) {
        entries.delete(key);
        counters.expired += 1;
        counters.misses += 1;
        return undefined;
      }
      // LRU: ans Ende verschieben
      entries.delete(key);
      entries.set(key, entry);
      counters.hits += 1;
      return entry.value;
    },

    /** Wie `get`, aber ohne LRU-Aktualisierung und ohne Statistik (z. B. für Diagnose). */
    peek(key) {
      const entry = entries.get(key);
      if (entry === undefined || isExpired(entry, now())) return undefined;
      return entry.value;
    },

    /**
     * Speichert einen Wert. `ttlMs` 0 bedeutet „nicht speichern“ (ein vorhandener Eintrag wird entfernt).
     * @returns {V} der gespeicherte Wert
     */
    set(key, value, ttlMs) {
      const ttl = resolveTtl(ttlMs);
      if (ttl === 0) {
        entries.delete(key);
        return value;
      }
      const t = now();
      entries.delete(key); // vorhandenen Eintrag neu einreihen
      if (entries.size >= maxEntries) {
        // Zuerst Abgelaufene entfernen, dann notfalls den ältesten (LRU) verdrängen.
        if (prune() === 0 || entries.size >= maxEntries) {
          const oldestKey = entries.keys().next().value;
          entries.delete(oldestKey);
          counters.evictions += 1;
        }
      }
      entries.set(key, { value, expiresAt: Number.isFinite(ttl) ? t + ttl : Infinity, createdAt: t });
      return value;
    },

    /** True, wenn ein nicht abgelaufener Eintrag existiert (ohne LRU-/Statistik-Effekt). */
    has(key) {
      const entry = entries.get(key);
      if (entry === undefined) return false;
      if (isExpired(entry, now())) {
        entries.delete(key);
        counters.expired += 1;
        return false;
      }
      return true;
    },

    /** Entfernt einen Eintrag; true, wenn er vorhanden war. */
    delete(key) {
      return entries.delete(key);
    },

    clear() {
      entries.clear();
    },

    /** Anzahl der gültigen (nicht abgelaufenen) Einträge. */
    size() {
      prune();
      return entries.size;
    },

    /** Schlüssel der gültigen Einträge in LRU-Reihenfolge (älteste zuerst). */
    keys() {
      prune();
      return Array.from(entries.keys());
    },

    prune,

    stats() {
      return {
        hits: counters.hits,
        misses: counters.misses,
        evictions: counters.evictions,
        expired: counters.expired,
        size: entries.size,
        maxEntries,
      };
    },
  };
}
