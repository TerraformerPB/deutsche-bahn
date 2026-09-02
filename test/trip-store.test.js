import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTripStore, tripDepartureMs, tripArrivalMs, isoToMs, DISCOVERED_VIA, DEFAULT_SEED_MAX_AGE_MS,
} from '../src/transport/trip-store.js';

const T0 = Date.parse('2026-09-02T10:00:00+02:00');
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

function stop(id, name, lat = 52.5, lon = 13.4) {
  return { id, name, lat, lon };
}

/** Kleine normalisierte Fahrt mit drei Halten. */
function makeTrip(id, { depMs = T0, arrMs = T0 + 120 * MIN, cancelled = false, realtime = true } = {}) {
  const mid = depMs + (arrMs - depMs) / 2;
  const stopover = (s, arr, dep) => ({
    stop: s,
    plannedArrival: arr === null ? null : iso(arr),
    arrival: arr === null || !realtime ? null : iso(arr),
    arrivalDelaySec: realtime ? 0 : null,
    plannedDeparture: dep === null ? null : iso(dep),
    departure: dep === null || !realtime ? null : iso(dep),
    departureDelaySec: realtime ? 0 : null,
    plannedArrivalPlatform: null, arrivalPlatform: null, plannedDeparturePlatform: null, departurePlatform: null,
    cancelled: false, loadFactor: null, remarks: [],
  });
  return {
    id,
    lineName: 'ICE 123',
    product: 'nationalExpress',
    productName: 'ICE',
    fahrtNr: '123',
    operator: 'DB Fernverkehr AG',
    direction: 'Hamburg Hbf',
    origin: stop('8011160', 'Berlin Hbf'),
    destination: stop('8002549', 'Hamburg Hbf', 53.55, 10.0),
    plannedDeparture: iso(depMs),
    departure: realtime ? iso(depMs) : null,
    departureDelaySec: realtime ? 0 : null,
    plannedArrival: iso(arrMs),
    arrival: realtime ? iso(arrMs) : null,
    arrivalDelaySec: realtime ? 0 : null,
    cancelled,
    loadFactor: null,
    stopovers: [
      stopover(stop('8011160', 'Berlin Hbf'), null, depMs),
      stopover(stop('8010404', 'Wittenberge', 53.0, 11.75), mid, mid + 2 * MIN),
      stopover(stop('8002549', 'Hamburg Hbf', 53.55, 10.0), arrMs, null),
    ],
    remarks: [],
    polyline: null,
    realtimeDataUpdatedAt: T0,
    fetchedAt: T0,
  };
}

function makeDeparture(tripId, whenMs, { direction = 'Hamburg Hbf', lineName = 'ICE 123', product = 'nationalExpress' } = {}) {
  return {
    tripId,
    lineName,
    product,
    fahrtNr: '123',
    direction,
    stop: stop('8011160', 'Berlin Hbf'),
    plannedWhen: iso(whenMs),
    when: iso(whenMs + 3 * MIN),
    delaySec: 180,
    plannedPlatform: '3', platform: '3', cancelled: false, remarks: [],
  };
}

test('createTripStore: validiert now', () => {
  assert.throws(() => createTripStore({ now: 'x' }), TypeError);
});

test('isoToMs / tripDepartureMs / tripArrivalMs', () => {
  assert.equal(isoToMs('2026-09-02T10:00:00+02:00'), T0);
  assert.equal(isoToMs('kein datum'), null);
  assert.equal(isoToMs(42), null);
  assert.equal(isoToMs('x'.repeat(50)), null);
  const trip = makeTrip('1|1|0|80|2092026', { depMs: T0, arrMs: T0 + 60 * MIN });
  assert.equal(tripDepartureMs(trip), T0);
  assert.equal(tripArrivalMs(trip), T0 + 60 * MIN);
  // Echtzeit vor Plan
  trip.departure = iso(T0 + 5 * MIN);
  trip.arrival = iso(T0 + 70 * MIN);
  assert.equal(tripDepartureMs(trip), T0 + 5 * MIN);
  assert.equal(tripArrivalMs(trip), T0 + 70 * MIN);
  // Fallback über Halte, wenn die Kopffelder fehlen
  const bare = { ...trip, departure: null, plannedDeparture: null, arrival: null, plannedArrival: null };
  assert.equal(tripDepartureMs(bare), T0);
  assert.equal(tripArrivalMs(bare), T0 + 60 * MIN);
  assert.equal(tripDepartureMs({ stopovers: [] }), null);
  assert.equal(tripArrivalMs(null), null);
  assert.equal(tripArrivalMs({ stopovers: [null, { plannedArrival: 'x' }] }), null);
});

test('upsert: Seed aus Abfahrtstafel', () => {
  let t = T0;
  const store = createTripStore({ now: () => t });
  const dep = makeDeparture('1|100|0|80|2092026', T0 + 30 * MIN);
  const rec = store.upsert(dep, { discoveredVia: 'departures' });
  assert.equal(rec.id, dep.tripId);
  assert.equal(rec.trip, null);
  assert.equal(rec.lineName, 'ICE 123');
  assert.equal(rec.product, 'nationalExpress');
  assert.equal(rec.discoveredAt, T0);
  assert.equal(rec.discoveredVia, 'departures');
  assert.equal(rec.lastFetchedAt, null);
  assert.equal(rec.lastSeenAt, T0);
  assert.equal(rec.fetchErrors, 0);
  assert.equal(rec.plannedDeparture, iso(T0 + 30 * MIN));
  assert.equal(rec.departureMs, T0 + 30 * MIN);
  assert.equal(rec.plannedArrival, null);
  assert.deepEqual(rec.seed, { direction: 'Hamburg Hbf', stop: stop('8011160', 'Berlin Hbf'), when: iso(T0 + 30 * MIN) });
  assert.equal(store.size(), 1);
  assert.equal(store.has(dep.tripId), true);
  assert.equal(store.get(dep.tripId), rec);

  // Erneute Sichtung: Seed aktualisiert, Entdeckung bleibt
  t = T0 + 5 * MIN;
  const rec2 = store.upsert(makeDeparture(dep.tripId, T0 + 31 * MIN), { discoveredVia: 'arrivals' });
  assert.equal(rec2, rec);
  assert.equal(rec.discoveredVia, 'departures');
  assert.equal(rec.discoveredAt, T0);
  assert.equal(rec.lastSeenAt, T0 + 5 * MIN);
  assert.equal(rec.seed.when, iso(T0 + 31 * MIN));
  assert.equal(store.size(), 1);
});

test('upsert: Departure ohne discoveredVia wird als departures geführt, Seed-Objekt als manual', () => {
  const store = createTripStore({ now: () => T0 });
  assert.equal(store.upsert(makeDeparture('1|101|0|80|2092026', T0)).discoveredVia, 'departures');
  const seed = store.upsert({ id: '1|102|0|80|2092026', lineName: 'IC 2020', product: 'national', direction: 'Köln', when: iso(T0 + MIN) });
  assert.equal(seed.discoveredVia, 'manual');
  assert.equal(seed.lineName, 'IC 2020');
  assert.equal(seed.product, 'national');
  assert.equal(seed.seed.direction, 'Köln');
  assert.equal(seed.seed.stop, null);
  assert.equal(seed.departureMs, T0 + MIN);
  // Departure mit Rohstruktur `line.name` (tolerant)
  const raw = store.upsert({ tripId: '1|103|0|80|2092026', line: { name: 'ICE 9' }, stop: { id: '8000105', name: 'Frankfurt', lat: 50.1, lon: 8.66 }, when: iso(T0) });
  assert.equal(raw.lineName, 'ICE 9');
  assert.equal(raw.seed.when, iso(T0));
});

test('upsert: vollständige Fahrt ersetzt Seed und setzt Zeiten', () => {
  let t = T0;
  const store = createTripStore({ now: () => t });
  const id = '1|200|0|80|2092026';
  const rec = store.upsert(makeDeparture(id, T0 + 30 * MIN, { lineName: 'ICE 999' }), { discoveredVia: 'departures' });
  rec.fetchErrors = 2;
  t = T0 + 10 * MIN;
  const trip = makeTrip(id, { depMs: T0 + 30 * MIN, arrMs: T0 + 150 * MIN });
  trip.fetchedAt = t;
  const rec2 = store.upsert(trip);
  assert.equal(rec2, rec);
  assert.equal(rec.trip, trip);
  assert.equal(rec.lineName, 'ICE 123'); // Fahrt hat Vorrang vor dem Seed
  assert.equal(rec.lastFetchedAt, t);
  assert.equal(rec.lastSeenAt, t);
  assert.equal(rec.fetchErrors, 0);
  assert.equal(rec.discoveredVia, 'departures');
  assert.equal(rec.plannedDeparture, iso(T0 + 30 * MIN));
  assert.equal(rec.plannedArrival, iso(T0 + 150 * MIN));
  assert.equal(rec.departureMs, T0 + 30 * MIN);
  assert.equal(rec.arrivalMs, T0 + 150 * MIN);
  assert.equal(rec.cancelled, false);
  assert.equal(rec.seed.when, iso(T0 + 30 * MIN)); // Seed bleibt erhalten
  // Spätere Sichtung auf einer Tafel verändert weder Zeiten noch Seed
  t = T0 + 20 * MIN;
  store.upsert(makeDeparture(id, T0 + 45 * MIN));
  assert.equal(rec.departureMs, T0 + 30 * MIN);
  assert.equal(rec.lastSeenAt, T0 + 20 * MIN);
});

test('upsert: Fahrt ohne Seed erzeugt Seed aus Ursprung; meta.fetchedAt/seenAt haben Vorrang', () => {
  const store = createTripStore({ now: () => T0 + 99 });
  const id = '1|201|0|80|2092026';
  const trip = makeTrip(id, { realtime: false });
  const rec = store.upsert(trip, { discoveredVia: 'manual', fetchedAt: T0 + 5, seenAt: T0 + 7 });
  assert.equal(rec.discoveredVia, 'manual');
  assert.equal(rec.lastFetchedAt, T0 + 5);
  assert.equal(rec.lastSeenAt, T0 + 7);
  assert.equal(rec.discoveredAt, T0 + 7);
  assert.deepEqual(rec.seed, { direction: 'Hamburg Hbf', stop: stop('8011160', 'Berlin Hbf'), when: trip.plannedDeparture });
  // ohne Echtzeit: Planzeiten
  assert.equal(rec.departureMs, T0);
  assert.equal(rec.arrivalMs, T0 + 120 * MIN);
  // ausgefallene Fahrt
  const c = store.upsert(makeTrip('1|202|0|80|2092026', { cancelled: true }));
  assert.equal(c.cancelled, true);
});

test('upsert: ungültige Eingaben', () => {
  const store = createTripStore({ now: () => T0 });
  assert.throws(() => store.upsert(null), TypeError);
  assert.throws(() => store.upsert('abc'), TypeError);
  assert.throws(() => store.upsert({ tripId: 'abc' }), TypeError); // zu kurz
  assert.throws(() => store.upsert({ tripId: 'abc defg' }), TypeError); // Steuerzeichen
  assert.throws(() => store.upsert({ id: 'x'.repeat(513), stopovers: [] }), TypeError);
  assert.throws(() => store.upsert({ id: 12345678 }), TypeError);
  assert.throws(() => store.upsert(makeDeparture('1|1|0|80|2092026', T0), { discoveredVia: 'radar' }), TypeError);
  assert.equal(store.size(), 0);
  assert.deepEqual(DISCOVERED_VIA, ['departures', 'arrivals', 'manual']);
});

test('get/has/remove/all/clear/touch/recordFetchError', () => {
  let t = T0;
  const store = createTripStore({ now: () => t });
  const a = store.upsert(makeDeparture('1|300|0|80|2092026', T0));
  const b = store.upsert(makeDeparture('1|301|0|80|2092026', T0));
  assert.deepEqual(store.all().map((r) => r.id), [a.id, b.id]);
  assert.equal(store.get('unbekannt'), null);
  assert.equal(store.get(undefined), null);
  assert.equal(store.has(42), false);
  t = T0 + MIN;
  assert.equal(store.touch(a.id), a);
  assert.equal(a.lastSeenAt, T0 + MIN);
  assert.equal(store.touch(a.id, T0), a); // ältere Sichtung verringert lastSeenAt nicht
  assert.equal(a.lastSeenAt, T0 + MIN);
  assert.equal(store.touch('unbekannt'), null);
  assert.equal(store.recordFetchError(a.id), 1);
  assert.equal(store.recordFetchError(a.id), 2);
  assert.equal(store.recordFetchError('unbekannt'), 0);
  assert.equal(store.remove(a.id), true);
  assert.equal(store.remove(a.id), false);
  assert.equal(store.remove(null), false);
  assert.equal(store.size(), 1);
  store.clear();
  assert.equal(store.size(), 0);
});

test('prune: beendete Fahrten nach retainAfterArrivalMs, laufende bleiben', () => {
  const store = createTripStore({ now: () => T0 });
  const finished = store.upsert(makeTrip('1|400|0|80|2092026', { depMs: T0 - 3 * 60 * MIN, arrMs: T0 - 30 * MIN }));
  const running = store.upsert(makeTrip('1|401|0|80|2092026', { depMs: T0 - 60 * MIN, arrMs: T0 + 60 * MIN }));
  const justArrived = store.upsert(makeTrip('1|402|0|80|2092026', { depMs: T0 - 60 * MIN, arrMs: T0 - 5 * MIN }));
  assert.equal(store.prune(T0, { retainAfterArrivalMs: 10 * MIN }), 1);
  assert.equal(store.has(finished.id), false);
  assert.equal(store.has(running.id), true);
  assert.equal(store.has(justArrived.id), true);
  assert.equal(store.prune(T0 + 6 * MIN, { retainAfterArrivalMs: 10 * MIN }), 1);
  assert.equal(store.has(justArrived.id), false);
  // Verspätete Ankunft (Echtzeit) zählt statt Plan
  const late = makeTrip('1|403|0|80|2092026', { depMs: T0 - 60 * MIN, arrMs: T0 - 20 * MIN });
  late.arrival = iso(T0 + 10 * MIN);
  store.upsert(late);
  assert.equal(store.prune(T0, { retainAfterArrivalMs: 0 }), 0);
  assert.equal(store.prune(T0 + 11 * MIN, { retainAfterArrivalMs: 0 }), 1);
  // ohne Optionen: retain 0
  store.upsert(makeTrip('1|404|0|80|2092026', { depMs: T0 - 60 * MIN, arrMs: T0 - 1 }));
  assert.equal(store.prune(T0), 1);
});

test('prune: veraltete Seeds und lange nicht gesehene Einträge', () => {
  const store = createTripStore({ now: () => T0 });
  const oldSeed = store.upsert(makeDeparture('1|500|0|80|2092026', T0 - DEFAULT_SEED_MAX_AGE_MS - MIN));
  const freshSeed = store.upsert(makeDeparture('1|501|0|80|2092026', T0 + 10 * MIN));
  const noTimeSeed = store.upsert({ id: '1|502|0|80|2092026' });
  assert.equal(store.prune(T0, { retainAfterArrivalMs: 10 * MIN }), 1);
  assert.equal(store.has(oldSeed.id), false);
  assert.equal(store.has(freshSeed.id), true);
  assert.equal(store.has(noTimeSeed.id), true);
  // Seed ohne Zeit: nach unseenMaxAgeMs
  assert.equal(store.prune(T0 + 7 * 3600e3, { seedMaxAgeMs: 24 * 3600e3, unseenMaxAgeMs: 6 * 3600e3 }), 2);
  assert.equal(store.size(), 0);
  // Fahrt ohne verwertbare Ankunft: nach unseenMaxAgeMs
  const trip = makeTrip('1|503|0|80|2092026');
  trip.arrival = null; trip.plannedArrival = null; trip.stopovers = [];
  store.upsert(trip);
  assert.equal(store.get(trip.id).arrivalMs, null);
  assert.equal(store.prune(T0 + 5 * 3600e3, {}), 0);
  assert.equal(store.prune(T0 + 7 * 3600e3, {}), 1);
  // ungültiges nowMs → aktuelle Zeit; ungültige Optionen → Standardwerte
  store.upsert(makeDeparture('1|504|0|80|2092026', T0 - DEFAULT_SEED_MAX_AGE_MS - 1));
  assert.equal(store.prune('x', null), 1);
});
