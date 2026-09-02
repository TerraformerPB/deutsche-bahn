/**
 * Fahrtenspeicher: hält alle bekannten Fahrten (Trips) samt Metadaten für den Poller
 * und die API.
 *
 * Ein Eintrag entsteht entweder als „Seed“ aus einer Abfahrts-/Ankunftstafel
 * (nur Trip-ID, Linie, Richtung, Halt und Zeit – `trip` ist dann `null`), oder
 * direkt mit einer vollständig geladenen Fahrt. Sobald die Fahrt geladen wird,
 * ersetzt sie den Seed; die Metadaten (Entdeckungszeitpunkt, Fehlerzähler …)
 * bleiben erhalten.
 *
 * Der Speicher hält keine Timer und macht keine Anfragen; die Zeitquelle ist
 * injizierbar (`now`). Die zurückgegebenen Einträge sind die gespeicherten
 * Objekte selbst (keine Kopien), damit der Poller Zähler fortschreiben kann –
 * Aufrufer außerhalb des Pollers behandeln sie als schreibgeschützt.
 */

/**
 * @typedef {import('./normalize.js').Trip} Trip
 * @typedef {{id:string|null, name:string, lat:number|null, lon:number|null}} Stop
 * @typedef {{direction:string|null, stop:Stop|null, when:string|null}} Seed
 * @typedef {{
 *   trip: object|null, id: string, lineName: string|null, product: string|null,
 *   discoveredAt: number, discoveredVia: 'departures'|'arrivals'|'manual',
 *   lastFetchedAt: number|null, lastSeenAt: number, fetchErrors: number,
 *   plannedDeparture: string|null, plannedArrival: string|null, seed: Seed|null,
 *   cancelled: boolean, departureMs: number|null, arrivalMs: number|null
 * }} TripRecord
 */

export const DISCOVERED_VIA = Object.freeze(['departures', 'arrivals', 'manual']);
const TRIP_ID_MIN = 5;
const TRIP_ID_MAX = 512;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
/** Seeds, deren Abfahrt länger als dieses Fenster zurückliegt und die nie geladen wurden, werden verworfen. */
export const DEFAULT_SEED_MAX_AGE_MS = 3 * 3600e3;
/** Einträge ohne verwertbare Ankunftszeit werden nach dieser Zeit ohne Sichtung verworfen. */
export const DEFAULT_UNSEEN_MAX_AGE_MS = 6 * 3600e3;

/** Epoch-Millisekunden aus einem ISO-String; `null` bei fehlendem/ungültigem Wert. */
export function isoToMs(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function isValidTripId(id) {
  return typeof id === 'string' && id.length >= TRIP_ID_MIN && id.length <= TRIP_ID_MAX && !CONTROL_CHARS_RE.test(id);
}

function strOrNull(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Erster nicht-null-Wert aus einer Liste (ISO-Strings). */
function firstIso(...values) {
  for (const v of values) {
    const s = strOrNull(v);
    if (s !== null && isoToMs(s) !== null) return s;
  }
  return null;
}

function stopoversOf(trip) {
  return trip && Array.isArray(trip.stopovers) ? trip.stopovers.filter((s) => s && typeof s === 'object') : [];
}

/**
 * Wirksame Abfahrtszeit einer Fahrt (Echtzeit vor Plan; Fallback erster Halt) in Millisekunden.
 * @param {object} trip
 * @returns {number|null}
 */
export function tripDepartureMs(trip) {
  if (!trip || typeof trip !== 'object') return null;
  const stops = stopoversOf(trip);
  const first = stops.length > 0 ? stops[0] : null;
  return isoToMs(firstIso(
    trip.departure, trip.plannedDeparture,
    first && first.departure, first && first.plannedDeparture, first && first.arrival, first && first.plannedArrival,
  ));
}

/**
 * Wirksame Ankunftszeit einer Fahrt (Echtzeit vor Plan; Fallback letzter Halt) in Millisekunden.
 * @param {object} trip
 * @returns {number|null}
 */
export function tripArrivalMs(trip) {
  if (!trip || typeof trip !== 'object') return null;
  const stops = stopoversOf(trip);
  const last = stops.length > 0 ? stops[stops.length - 1] : null;
  return isoToMs(firstIso(
    trip.arrival, trip.plannedArrival,
    last && last.arrival, last && last.plannedArrival, last && last.departure, last && last.plannedDeparture,
  ));
}

function normalizeStopRef(stop) {
  if (!stop || typeof stop !== 'object') return null;
  return {
    id: strOrNull(stop.id),
    name: typeof stop.name === 'string' ? stop.name : '',
    lat: finiteOrNull(stop.lat),
    lon: finiteOrNull(stop.lon),
  };
}

function seedFromDeparture(dep) {
  return {
    direction: strOrNull(dep.direction),
    stop: normalizeStopRef(dep.stop),
    when: firstIso(dep.plannedWhen, dep.when),
  };
}

function seedFromTrip(trip) {
  return {
    direction: strOrNull(trip.direction) ?? (trip.destination && strOrNull(trip.destination.name)) ?? null,
    stop: normalizeStopRef(trip.origin),
    when: firstIso(trip.plannedDeparture, trip.departure),
  };
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] Zeitquelle in Epoch-Millisekunden
 */
export function createTripStore({ now = () => Date.now() } = {}) {
  if (typeof now !== 'function') throw new TypeError('now muss eine Funktion sein');

  /** @type {Map<string, TripRecord>} */
  const records = new Map();

  function createRecord(id, t, via) {
    return {
      id,
      trip: null,
      lineName: null,
      product: null,
      discoveredAt: t,
      discoveredVia: via,
      lastFetchedAt: null,
      lastSeenAt: t,
      fetchErrors: 0,
      plannedDeparture: null,
      plannedArrival: null,
      seed: null,
      cancelled: false,
      departureMs: null,
      arrivalMs: null,
    };
  }

  function parseMeta(meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    const via = m.discoveredVia === undefined || m.discoveredVia === null ? null : m.discoveredVia;
    if (via !== null && !DISCOVERED_VIA.includes(via)) throw new TypeError(`discoveredVia muss eines von ${DISCOVERED_VIA.join(', ')} sein`);
    return {
      discoveredVia: via,
      fetchedAt: finiteOrNull(m.fetchedAt),
      seenAt: finiteOrNull(m.seenAt),
    };
  }

  function applyTrip(record, trip, meta, t) {
    record.trip = trip;
    record.lineName = strOrNull(trip.lineName) ?? record.lineName;
    record.product = strOrNull(trip.product) ?? record.product;
    record.lastFetchedAt = meta.fetchedAt ?? finiteOrNull(trip.fetchedAt) ?? t;
    record.fetchErrors = 0;
    record.cancelled = trip.cancelled === true;
    const stops = stopoversOf(trip);
    const first = stops[0] || null;
    const last = stops[stops.length - 1] || null;
    record.plannedDeparture = firstIso(trip.plannedDeparture, first && first.plannedDeparture, first && first.plannedArrival);
    record.plannedArrival = firstIso(trip.plannedArrival, last && last.plannedArrival, last && last.plannedDeparture);
    record.departureMs = tripDepartureMs(trip);
    record.arrivalMs = tripArrivalMs(trip);
    if (record.seed === null) record.seed = seedFromTrip(trip);
  }

  function applySeed(record, seed, lineName, product) {
    if (record.trip === null) {
      // Ohne geladene Fahrt ist der Seed die einzige Zeitinformation; neuere Sichtungen überschreiben.
      record.seed = seed;
      record.plannedDeparture = seed.when;
      record.departureMs = isoToMs(seed.when);
    } else if (record.seed === null) {
      record.seed = seed;
    }
    if (record.lineName === null) record.lineName = lineName;
    if (record.product === null) record.product = product;
  }

  const store = {
    /**
     * Legt einen Eintrag an oder aktualisiert ihn.
     *
     * `input` ist entweder eine normalisierte Fahrt (`Trip`, erkennbar am `stopovers`-Array),
     * ein Eintrag einer Abfahrtstafel (`Departure`, erkennbar an `tripId`) oder ein
     * Seed-Objekt `{id, lineName?, product?, direction?, stop?, when?}`.
     * @param {object} input
     * @param {{discoveredVia?: 'departures'|'arrivals'|'manual', fetchedAt?: number, seenAt?: number}} [meta]
     * @returns {TripRecord}
     */
    upsert(input, meta) {
      if (!input || typeof input !== 'object') throw new TypeError('upsert erwartet ein Objekt (Trip, Departure oder Seed)');
      const m = parseMeta(meta);
      const isTrip = Array.isArray(input.stopovers) && typeof input.id === 'string';
      const isDeparture = !isTrip && typeof input.tripId === 'string';
      const id = isDeparture ? input.tripId : input.id;
      if (!isValidTripId(id)) throw new TypeError('Ungültige Fahrt-ID im Fahrtenspeicher');
      const t = m.seenAt ?? now();
      let record = records.get(id);
      if (!record) {
        record = createRecord(id, t, m.discoveredVia ?? (isDeparture ? 'departures' : 'manual'));
        records.set(id, record);
      }
      record.lastSeenAt = Math.max(record.lastSeenAt, t);
      if (isTrip) {
        applyTrip(record, input, m, t);
      } else if (isDeparture) {
        const line = input.lineName ?? input.line?.name ?? null;
        applySeed(record, seedFromDeparture(input), strOrNull(line), strOrNull(input.product));
      } else {
        const seed = {
          direction: strOrNull(input.direction),
          stop: normalizeStopRef(input.stop),
          when: firstIso(input.when, input.plannedWhen, input.plannedDeparture),
        };
        applySeed(record, seed, strOrNull(input.lineName), strOrNull(input.product));
      }
      return record;
    },

    /** @returns {TripRecord|null} */
    get(id) {
      return typeof id === 'string' ? records.get(id) ?? null : null;
    },

    has(id) {
      return typeof id === 'string' && records.has(id);
    },

    /** Alle Einträge (Einfügereihenfolge). */
    all() {
      return Array.from(records.values());
    },

    /** Entfernt einen Eintrag; true, wenn er vorhanden war. */
    remove(id) {
      return typeof id === 'string' && records.delete(id);
    },

    size() {
      return records.size;
    },

    /** Vermerkt eine Sichtung (z. B. auf einer Abfahrtstafel) ohne weitere Änderung. */
    touch(id, seenAt) {
      const record = store.get(id);
      if (!record) return null;
      record.lastSeenAt = Math.max(record.lastSeenAt, finiteOrNull(seenAt) ?? now());
      return record;
    },

    /** Zählt einen fehlgeschlagenen Abruf; liefert den neuen Zählerstand (0, wenn unbekannt). */
    recordFetchError(id) {
      const record = store.get(id);
      if (!record) return 0;
      record.fetchErrors += 1;
      return record.fetchErrors;
    },

    /**
     * Entfernt beendete Fahrten (Ankunft + `retainAfterArrivalMs` liegt zurück), veraltete Seeds und
     * Einträge, die lange nicht mehr gesichtet wurden.
     * @param {number} nowMs
     * @param {{retainAfterArrivalMs?: number, seedMaxAgeMs?: number, unseenMaxAgeMs?: number}} [options]
     * @returns {number} Anzahl entfernter Einträge
     */
    prune(nowMs, options = {}) {
      const t = finiteOrNull(nowMs) ?? now();
      const opts = options && typeof options === 'object' ? options : {};
      const retain = Math.max(0, finiteOrNull(opts.retainAfterArrivalMs) ?? 0);
      const seedMaxAge = Math.max(0, finiteOrNull(opts.seedMaxAgeMs) ?? DEFAULT_SEED_MAX_AGE_MS);
      const unseenMaxAge = Math.max(0, finiteOrNull(opts.unseenMaxAgeMs) ?? DEFAULT_UNSEEN_MAX_AGE_MS);
      let removed = 0;
      for (const [id, r] of records) {
        let drop = false;
        if (r.trip === null) {
          // Seed: Abfahrt am Knoten lange vorbei oder seit langem nicht gesichtet.
          const ref = r.departureMs ?? r.lastSeenAt;
          drop = t - ref > seedMaxAge || t - r.lastSeenAt > unseenMaxAge;
        } else if (r.arrivalMs !== null) {
          drop = t - r.arrivalMs > retain;
        } else {
          drop = t - r.lastSeenAt > unseenMaxAge;
        }
        if (drop) {
          records.delete(id);
          removed += 1;
        }
      }
      return removed;
    },

    clear() {
      records.clear();
    },
  };

  return store;
}
