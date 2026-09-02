/**
 * Minimaler Zustandsspeicher mit Abonnements (ohne DOM-Abhängigkeit, testbar in Node).
 */
export function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();

  function get() {
    return state;
  }

  /** Aktualisiert den Zustand (Objekt oder Funktion) und benachrichtigt Abonnenten über geänderte Schlüssel. */
  function set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next || typeof next !== 'object') return;
    const changed = [];
    for (const [k, v] of Object.entries(next)) {
      if (state[k] !== v) changed.push(k);
    }
    if (changed.length === 0) return;
    state = { ...state, ...next };
    for (const l of [...listeners]) {
      if (!l.keys || changed.some((k) => l.keys.has(k))) {
        try {
          l.fn(state, changed);
        } catch (err) {
          // Fehler einzelner Abonnenten dürfen andere nicht blockieren
          if (typeof console !== 'undefined' && console.error) console.error('Store-Abonnent fehlgeschlagen', err);
        }
      }
    }
  }

  /**
   * @param {(state:object, changed:string[]) => void} fn
   * @param {string[]} [keys] nur bei Änderung dieser Schlüssel aufrufen
   * @returns {() => void} Abmeldefunktion
   */
  function subscribe(fn, keys) {
    const l = { fn, keys: keys ? new Set(keys) : null };
    listeners.add(l);
    return () => listeners.delete(l);
  }

  return { get, set, subscribe, listenerCount: () => listeners.size };
}

/** Sicherer Zugriff auf localStorage (kann in privaten Fenstern/Vorschauen fehlen). */
export function createPrefs(storage, prefix = 'dbkarte.') {
  function read(key, fallback) {
    try {
      const raw = storage && storage.getItem(prefix + key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function write(key, value) {
    try {
      if (!storage) return false;
      storage.setItem(prefix + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
  return { read, write };
}
