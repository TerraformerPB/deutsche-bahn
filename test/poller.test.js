import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPoller, tickBudget, refreshPriority, prioritizeRecords, evictionOrder, recordPhase, isThrottleError, BUDGET_SHARE,
} from '../src/transport/poller.js';
import { createTripStore } from '../src/transport/trip-store.js';
import { ValidationError, CircuitOpenError, RateLimitedError, UpstreamError, UpstreamTimeoutError } from '../src/lib/errors.js';
import { createLogger } from '../src/logger.js';
import { createFakeClock } from './helpers/fake-clock.js';

const T0 = Date.parse('2026-09-02T10:00:00+02:00');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

const HUBS = [
  { id: '8011160', name: 'Berlin Hbf', lat: 52.525, lon: 13.369, tier: 1 },
  { id: '8002549', name: 'Hamburg Hbf', lat: 53.553, lon: 10.006, tier: 1 },
  { id: '8000261', name: 'München Hbf', lat: 48.140, lon: 11.558, tier: 1 },
  { id: '8000105', name: 'Frankfurt (Main) Hbf', lat: 50.107, lon: 8.663, tier: 1 },
  { id: '8000207', name: 'Köln Hbf', lat: 50.943, lon: 6.958, tier: 2 },
  { id: '8000152', name: 'Hannover Hbf', lat: 52.376, lon: 9.741, tier: 2 },
];

const BASE_CONFIG = {
  maxRpm: 40, // → 8 Anfragen pro 15-s-Tick
  concurrency: 2,
  products: ['nationalExpress', 'national'],
  hubPollIntervalSec: 600,
  hubBoardDurationMin: 60,
  hubIncludeArrivals: false,
  hubTier2Factor: 2,
  tripRefreshMinSec: 180,
  tripMaxTracked: 400,
  tripPrefetchBeforeDepartureMin: 20,
  tripRetainAfterArrivalMin: 10,
  boardCacheSec: 60,
};

function stop(id, name, lat = 52.5, lon = 13.4) {
  return { id, name, lat, lon };
}

function makeTrip(id, { depMs = T0, arrMs = T0 + 120 * MIN, cancelled = false, remarks = [] } = {}) {
  const mid = depMs + (arrMs - depMs) / 2;
  const so = (s, arr, dep) => ({
    stop: s,
    plannedArrival: arr === null ? null : iso(arr), arrival: arr === null ? null : iso(arr), arrivalDelaySec: 0,
    plannedDeparture: dep === null ? null : iso(dep), departure: dep === null ? null : iso(dep), departureDelaySec: 0,
    plannedArrivalPlatform: null, arrivalPlatform: null, plannedDeparturePlatform: null, departurePlatform: null,
    cancelled: false, loadFactor: null, remarks: [],
  });
  return {
    id, lineName: 'ICE 123', product: 'nationalExpress', productName: 'ICE', fahrtNr: '123', operator: 'DB Fernverkehr AG',
    direction: 'Hamburg Hbf', origin: stop('8011160', 'Berlin Hbf'), destination: stop('8002549', 'Hamburg Hbf'),
    plannedDeparture: iso(depMs), departure: iso(depMs), departureDelaySec: 0,
    plannedArrival: iso(arrMs), arrival: iso(arrMs), arrivalDelaySec: 0,
    cancelled, loadFactor: null,
    stopovers: [so(stop('8011160', 'Berlin Hbf'), null, depMs), so(stop('8010404', 'Wittenberge'), mid, mid + MIN), so(stop('8002549', 'Hamburg Hbf'), arrMs, null)],
    remarks, polyline: null, realtimeDataUpdatedAt: depMs, fetchedAt: depMs,
  };
}

function makeDeparture(tripId, whenMs, stationId = '8011160') {
  return {
    tripId, lineName: 'ICE 123', product: 'nationalExpress', fahrtNr: '123', direction: 'Hamburg Hbf',
    stop: stop(stationId, `Bahnhof ${stationId}`), plannedWhen: iso(whenMs), when: iso(whenMs), delaySec: 0,
    plannedPlatform: '3', platform: '3', cancelled: false, remarks: [],
  };
}

/**
 * Fake-Client: `boards` bildet Stations-IDs auf Abfahrtslisten (oder Fehler/Funktionen) ab,
 * `trips` Trip-IDs auf Fahrten (oder Fehler/Funktionen). Alle Aufrufe werden protokolliert.
 */
function fakeClient({ boards = {}, trips = {}, now, available = null, breakerState = 'closed', delayMs = 0, clock } = {}) {
  const calls = [];
  const settle = (value) => (delayMs > 0 && clock
    ? new Promise((resolve, reject) => clock.setTimeout(() => (value instanceof Error ? reject(value) : resolve(value)), delayMs))
    : (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)));
  const resolveEntry = async (entry, ...args) => (typeof entry === 'function' ? entry(...args) : entry);
  return {
    calls,
    boards,
    trips,
    async departures(stationId, options) {
      calls.push({ kind: 'departures', stationId, options, at: now() });
      const entry = boards[stationId];
      if (entry === undefined) return settle(new UpstreamError('unbekannt', { upstreamStatus: 404 }));
      const value = await resolveEntry(entry, stationId, options);
      if (value instanceof Error) return settle(value);
      const list = Array.isArray(value) ? value : value.departures;
      const result = { stationId, departures: list, realtimeDataUpdatedAt: now(), fetchedAt: now(), duration: options.duration, products: options.products };
      if (options.includeArrivals) result.arrivals = Array.isArray(value) ? [] : (value.arrivals ?? []);
      return settle(result);
    },
    async trip(tripId, options) {
      calls.push({ kind: 'trip', tripId, options, at: now() });
      const entry = trips[tripId];
      if (entry === undefined) return settle(new UpstreamError('Die Datenquelle kennt die angefragte Ressource nicht.', { upstreamStatus: 404 }));
      const value = await resolveEntry(entry, tripId, options);
      if (value instanceof Error) return settle(value);
      return settle({ trip: value, realtimeDataUpdatedAt: now(), fetchedAt: now() });
    },
    stats() {
      return { breaker: breakerState, budget: { available }, requests: calls.length };
    },
  };
}

function fakeDisruptions() {
  const trips = [];
  const boards = [];
  return { trips, boards, ingestTrip: (t) => trips.push(t), ingestDepartures: (s, d) => boards.push({ stop: s, count: d.length }) };
}

function setup({ config = {}, hubs = HUBS, client: clientOpts = {}, pollerOpts = {}, logLines } = {}) {
  const clock = createFakeClock(T0);
  const client = fakeClient({ now: clock.now, clock, ...clientOpts });
  const store = createTripStore({ now: clock.now });
  const disruptions = fakeDisruptions();
  const lines = logLines ?? [];
  const logger = createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l)) });
  const poller = createPoller({
    config: { ...BASE_CONFIG, ...config },
    client,
    store,
    disruptions,
    hubs,
    logger,
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    random: () => 0.5,
    ...pollerOpts,
  });
  return { clock, client, store, disruptions, poller, lines };
}

const boardCalls = (client) => client.calls.filter((c) => c.kind === 'departures');
const tripCalls = (client) => client.calls.filter((c) => c.kind === 'trip');

// ---------------------------------------------------------------------------
// Reine Hilfsfunktionen
// ---------------------------------------------------------------------------

test('tickBudget: maxRpm · tickSec/60 · 0.8, mindestens 1', () => {
  assert.equal(BUDGET_SHARE, 0.8);
  assert.equal(tickBudget(40, 15_000), 8);
  assert.equal(tickBudget(600, 15_000), 120);
  assert.equal(tickBudget(1, 15_000), 1);
  assert.equal(tickBudget(100, 60_000), 80);
});

test('isThrottleError', () => {
  assert.equal(isThrottleError(new RateLimitedError()), true);
  assert.equal(isThrottleError(new CircuitOpenError()), true);
  assert.equal(isThrottleError(new UpstreamTimeoutError()), false);
  assert.equal(isThrottleError(new Error('x')), false);
  assert.equal(isThrottleError(null), false);
});

test('recordPhase / refreshPriority / prioritizeRecords / evictionOrder', () => {
  const opts = { prefetchMs: 20 * MIN, minIntervalMs: 180e3 };
  const rec = (over) => ({ id: 'x', trip: null, lastFetchedAt: null, lastSeenAt: T0, discoveredAt: T0, departureMs: null, arrivalMs: null, ...over });
  assert.equal(recordPhase(rec(), T0), 'unknown');
  assert.equal(recordPhase(rec({ departureMs: T0 + 1 }), T0), 'scheduled');
  assert.equal(recordPhase(rec({ departureMs: T0 - 1, arrivalMs: T0 + 1 }), T0), 'active');
  assert.equal(recordPhase(rec({ departureMs: T0 - 2, arrivalMs: T0 - 1 }), T0), 'finished');

  // Klasse 0: Seed mit naher/vergangener Abfahrt oder ohne Zeit
  assert.equal(refreshPriority(rec({ departureMs: T0 + 10 * MIN }), T0, opts).cls, 0);
  assert.equal(refreshPriority(rec({ departureMs: T0 - 10 * MIN }), T0, opts).cls, 0);
  assert.equal(refreshPriority(rec(), T0, opts).cls, 0);
  // Klasse 2: Seed mit ferner Abfahrt
  assert.equal(refreshPriority(rec({ departureMs: T0 + 60 * MIN }), T0, opts).cls, 2);
  // Klasse 1: laufend, geladen
  const active = rec({ trip: {}, lastFetchedAt: T0 - 10 * MIN, departureMs: T0 - 30 * MIN, arrivalMs: T0 + 30 * MIN });
  assert.deepEqual(refreshPriority(active, T0, opts), { cls: 1, key: T0 - 10 * MIN });
  // Mindestabstand
  assert.equal(refreshPriority({ ...active, lastFetchedAt: T0 - 60e3 }, T0, opts), null);
  // geladen, geplant und weit weg → nicht fällig; nah → Klasse 2
  assert.equal(refreshPriority(rec({ trip: {}, lastFetchedAt: T0 - 60 * MIN, departureMs: T0 + 60 * MIN, arrivalMs: T0 + 120 * MIN }), T0, opts), null);
  assert.equal(refreshPriority(rec({ trip: {}, lastFetchedAt: T0 - 60 * MIN, departureMs: T0 + 5 * MIN, arrivalMs: T0 + 120 * MIN }), T0, opts).cls, 2);
  // beendet: einmal nachprüfen, wenn seit Ankunft nicht geladen
  const fin = rec({ trip: {}, lastFetchedAt: T0 - 30 * MIN, departureMs: T0 - 120 * MIN, arrivalMs: T0 - 5 * MIN });
  assert.equal(refreshPriority(fin, T0, opts).cls, 2);
  assert.equal(refreshPriority({ ...fin, lastFetchedAt: T0 - 4 * MIN }, T0, opts), null);

  const list = [
    rec({ id: 'far-seed', departureMs: T0 + 60 * MIN }),
    rec({ id: 'active-old', trip: {}, lastFetchedAt: T0 - 20 * MIN, departureMs: T0 - 30 * MIN, arrivalMs: T0 + 30 * MIN }),
    rec({ id: 'near-seed', departureMs: T0 + 5 * MIN }),
    rec({ id: 'active-new', trip: {}, lastFetchedAt: T0 - 5 * MIN, departureMs: T0 - 30 * MIN, arrivalMs: T0 + 30 * MIN }),
    rec({ id: 'past-seed', departureMs: T0 - 5 * MIN }),
    rec({ id: 'fresh', trip: {}, lastFetchedAt: T0 - 1000, departureMs: T0 - 30 * MIN, arrivalMs: T0 + 30 * MIN }),
  ];
  assert.deepEqual(prioritizeRecords(list, T0, opts).map((r) => r.id), ['past-seed', 'near-seed', 'active-old', 'active-new', 'far-seed']);
  assert.deepEqual(evictionOrder(list.concat([rec({ id: 'done', trip: {}, departureMs: T0 - 90 * MIN, arrivalMs: T0 - MIN })]), T0, opts).map((r) => r.id).slice(0, 3),
    ['done', 'far-seed', 'near-seed']);
});

// ---------------------------------------------------------------------------
// Factory-Validierung
// ---------------------------------------------------------------------------

test('createPoller: validiert Pflichtparameter und Knoten', () => {
  const store = createTripStore();
  const client = fakeClient({ now: () => T0 });
  assert.throws(() => createPoller({ client, store, hubs: HUBS }), TypeError);
  assert.throws(() => createPoller({ config: BASE_CONFIG, store, hubs: HUBS }), TypeError);
  assert.throws(() => createPoller({ config: BASE_CONFIG, client, hubs: HUBS }), TypeError);
  assert.throws(() => createPoller({ config: BASE_CONFIG, client, store, hubs: 'x' }), TypeError);
  assert.throws(() => createPoller({ config: BASE_CONFIG, client, store, hubs: HUBS, now: 5 }), TypeError);
  assert.throws(() => createPoller({ config: BASE_CONFIG, client, store, hubs: HUBS, random: 'x' }), TypeError);
  const lines = [];
  const logger = createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l)) });
  const p = createPoller({
    config: {}, client, store, hubs: [{ id: 'abc' }, null, { id: '8011160', name: 'Berlin' }, { id: '8011160' }, { id: 8002549, tier: 2 }], logger,
  });
  assert.equal(p.stats().hubs.total, 2);
  assert.ok(lines.some((l) => l.msg.includes('Knotenbahnhöfe übersprungen') && l.skipped === 3));
  // Standardwerte bei leerer Konfiguration
  assert.equal(p.stats().budget.rpm, 40);
  assert.equal(p.stats().budget.perTick, 8);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('Discovery: fällige Knoten budgetbegrenzt im Round-Robin, Verteilung über das Intervall', async () => {
  // Budget 2 pro Tick (maxRpm 10, Tick 15 s) und sechs Knoten → drei Ticks für die erste Runde.
  // Leere Boards, damit kein Refresh das Budget teilt (Aufteilung wird separat geprüft).
  const boards = Object.fromEntries(HUBS.map((h) => [h.id, []]));
  const { clock, client, poller, disruptions } = setup({ config: { maxRpm: 10 }, client: { boards } });
  assert.equal(poller.stats().budget.perTick, 2);

  await poller.tick();
  assert.deepEqual(boardCalls(client).map((c) => c.stationId), ['8011160', '8002549']);
  assert.equal(disruptions.boards.length, 2);
  assert.deepEqual(disruptions.boards[0].stop, { id: '8011160', name: 'Berlin Hbf', lat: 52.525, lon: 13.369 });
  const first = boardCalls(client)[0];
  assert.equal(first.options.duration, 60);
  assert.deepEqual(first.options.products, ['nationalExpress', 'national']);
  assert.equal(first.options.includeArrivals, false);

  clock.advance(15_000);
  await poller.tick();
  assert.deepEqual(boardCalls(client).map((c) => c.stationId).slice(2), ['8000261', '8000105']);
  clock.advance(15_000);
  await poller.tick();
  assert.deepEqual(boardCalls(client).map((c) => c.stationId).slice(4), ['8000207', '8000152']);
  assert.equal(poller.stats().hubs.polled, 6);

  // Nichts mehr fällig
  clock.advance(15_000);
  await poller.tick();
  assert.equal(boardCalls(client).length, 6);
  assert.equal(client.calls.length, 6);

  // Nach dem Intervall (600 s) werden die Knoten in derselben Staffelung erneut fällig – nicht alle auf einmal.
  clock.advance(600_000 - 45_000 - 1000);
  await poller.tick();
  assert.equal(boardCalls(client).length, 6, 'noch nicht fällig');
  clock.advance(1000);
  await poller.tick();
  assert.deepEqual(boardCalls(client).map((c) => c.stationId).slice(6), ['8011160', '8002549']);
  clock.advance(15_000);
  await poller.tick();
  assert.deepEqual(boardCalls(client).map((c) => c.stationId).slice(8), ['8000261', '8000105']);
  // Stufe 2 mit Faktor 2 (1200 s): nach weiteren 15 s nicht fällig
  clock.advance(15_000);
  await poller.tick();
  assert.equal(boardCalls(client).length, 10);
  assert.ok(poller.stats().lastDiscoveryAt !== null);
});

test('Discovery: Stufe-2-Knoten werden mit hubTier2Factor seltener abgefragt', async () => {
  const hubs = [{ id: '8011160', name: 'Berlin Hbf', tier: 1 }, { id: '8000207', name: 'Köln Hbf', tier: 2 }];
  const { clock, client, poller } = setup({ hubs, config: { hubPollIntervalSec: 60, hubTier2Factor: 3, maxRpm: 600 }, client: { boards: { 8011160: [], 8000207: [] } } });
  await poller.tick();
  assert.equal(boardCalls(client).length, 2);
  for (let i = 1; i <= 3; i += 1) {
    clock.advance(60_000);
    await poller.tick();
  }
  const perHub = (id) => boardCalls(client).filter((c) => c.stationId === id).length;
  assert.equal(perHub('8011160'), 4);
  assert.equal(perHub('8000207'), 2);
});

test('Discovery und Refresh teilen sich das Tick-Budget (Reserve je zur Hälfte, Rest wandert)', async () => {
  const boards = { 8011160: [makeDeparture('1|q1|0|80|2092026', T0 + 5 * MIN)], 8002549: [], 8000261: [] };
  const trips = {};
  for (let i = 0; i < 5; i += 1) trips[`1|p${i}|0|80|2092026`] = makeTrip(`1|p${i}|0|80|2092026`, { depMs: T0 - 10 * MIN, arrMs: T0 + 60 * MIN });
  const { clock, client, store, poller } = setup({ hubs: HUBS.slice(0, 3), config: { maxRpm: 10 }, client: { boards, trips } }); // Budget 2
  for (const id of Object.keys(trips)) store.upsert(makeDeparture(id, T0 - 10 * MIN));
  await poller.tick();
  assert.equal(boardCalls(client).length, 1);
  assert.equal(tripCalls(client).length, 1);
  // Ohne fällige Knoten bekommt der Refresh das ganze Budget
  clock.advance(15_000);
  await poller.tick();
  clock.advance(15_000);
  await poller.tick();
  assert.equal(boardCalls(client).length, 3);
  assert.equal(tripCalls(client).length, 3);
  clock.advance(15_000);
  await poller.tick();
  assert.equal(boardCalls(client).length, 3);
  assert.equal(tripCalls(client).length, 5);
  assert.equal(store.size(), 6);
});

test('Discovery: Boards mit Ankünften kosten zwei Anfragen; Seeds aus Ankünften werden als arrivals geführt', async () => {
  const boards = {
    8011160: { departures: [makeDeparture('1|1|0|80|2092026', T0 + 5 * MIN)], arrivals: [makeDeparture('1|2|0|80|2092026', T0 + 5 * MIN)] },
    8002549: { departures: [], arrivals: [] },
    8000261: { departures: [], arrivals: [] },
  };
  const { client, store, poller } = setup({ hubs: HUBS.slice(0, 3), config: { hubIncludeArrivals: true, maxRpm: 12 }, client: { boards } });
  await poller.tick(); // Budget 2 → genau ein Board (2 Anfragen)
  assert.equal(boardCalls(client).length, 1);
  assert.equal(boardCalls(client)[0].options.includeArrivals, true);
  assert.equal(store.get('1|1|0|80|2092026').discoveredVia, 'departures');
  assert.equal(store.get('1|2|0|80|2092026').discoveredVia, 'arrivals');
  assert.ok(Array.isArray(poller.getBoard('8011160').arrivals));
  assert.equal(poller.stats().requestsLastMinute, 2);
});

test('Discovery: Fehler eines Boards wird protokolliert, Knoten später erneut versucht, Tick läuft weiter', async () => {
  const boards = { 8011160: new UpstreamTimeoutError(), 8002549: [makeDeparture('1|3|0|80|2092026', T0)] };
  const { clock, client, poller, lines, store } = setup({ hubs: HUBS.slice(0, 2), client: { boards } });
  await poller.tick();
  assert.equal(boardCalls(client).length, 2);
  assert.equal(store.size(), 1);
  assert.ok(lines.some((l) => l.msg.includes('Abfahrtstafel konnte nicht geladen werden') && l.stationId === '8011160'));
  assert.equal(poller.stats().upstream.lastErrorCode, 'UPSTREAM_TIMEOUT');
  assert.equal(poller.stats().counters.boardErrors, 1);
  // erneuter Versuch nach spätestens 2 min, nicht sofort
  clock.advance(15_000);
  await poller.tick();
  assert.equal(boardCalls(client).filter((c) => c.stationId === '8011160').length, 1);
  clock.advance(2 * MIN);
  await poller.tick();
  assert.equal(boardCalls(client).filter((c) => c.stationId === '8011160').length, 2);
});

// ---------------------------------------------------------------------------
// Refresh: Budget, Prioritäten, Mindestabstand
// ---------------------------------------------------------------------------

test('Refresh: Budget pro Tick wird eingehalten (Tick-Budget, Minutenfenster, Client-Budget)', async () => {
  const trips = {};
  const store = createTripStore({ now: () => T0 });
  for (let i = 0; i < 20; i += 1) {
    const id = `1|${2000 + i}|0|80|2092026`;
    trips[id] = makeTrip(id, { depMs: T0 - 10 * MIN, arrMs: T0 + 60 * MIN });
  }
  const clock = createFakeClock(T0);
  const client = fakeClient({ now: clock.now, trips });
  const poller = createPoller({ config: BASE_CONFIG, client, store, hubs: [], now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout });
  for (const id of Object.keys(trips)) store.upsert(makeDeparture(id, T0 - 10 * MIN));

  await poller.tick();
  assert.equal(tripCalls(client).length, 8, 'höchstens maxRpm·tickSec/60·0.8 = 8 Anfragen');
  assert.equal(poller.stats().requestsLastMinute, 8);
  assert.equal(poller.stats().budget.available, 32 - 8);
  // Weitere Ticks in derselben Minute: gleitendes Fenster (32/min) hält die Summe unter 0,8·maxRpm
  clock.advance(15_000); await poller.tick();
  clock.advance(15_000); await poller.tick();
  clock.advance(15_000); await poller.tick();
  assert.equal(tripCalls(client).length, 20);
  assert.ok(poller.stats().requestsLastMinute <= 32);

  // Client meldet knappes Budget → Planung wird zusätzlich begrenzt
  const client2 = fakeClient({ now: clock.now, trips, available: 3 });
  const store2 = createTripStore({ now: clock.now });
  for (const id of Object.keys(trips)) store2.upsert(makeDeparture(id, T0 - 10 * MIN));
  const poller2 = createPoller({ config: BASE_CONFIG, client: client2, store: store2, hubs: [], now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout });
  await poller2.tick();
  assert.equal(tripCalls(client2).length, 3);
  assert.equal(poller2.stats().budget.available, 3);
  // Kein Budget → keine Anfragen, aber kein Fehler
  const client3 = fakeClient({ now: clock.now, trips, available: 0 });
  const poller3 = createPoller({ config: BASE_CONFIG, client: client3, store: store2, hubs: [], now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout });
  await poller3.tick();
  assert.equal(tripCalls(client3).length, 0);
});

test('Refresh: Prioritäten – nahe Seeds vor laufenden (älteste zuerst) vor übrigen; Discovery und Refresh teilen sich das Budget', async () => {
  const trips = {};
  const ids = { pastSeed: '1|a1|0|80|2092026', nearSeed: '1|a2|0|80|2092026', farSeed: '1|a3|0|80|2092026', activeOld: '1|a4|0|80|2092026', activeNew: '1|a5|0|80|2092026' };
  for (const id of Object.values(ids)) trips[id] = makeTrip(id, { depMs: T0 - 30 * MIN, arrMs: T0 + 90 * MIN });
  const { clock, client, store, poller } = setup({ hubs: [], config: { maxRpm: 15 }, client: { trips } }); // Budget 3
  store.upsert(makeDeparture(ids.farSeed, T0 + 60 * MIN));
  store.upsert(makeDeparture(ids.nearSeed, T0 + 15 * MIN));
  store.upsert(makeDeparture(ids.pastSeed, T0 - 5 * MIN));
  const oldRec = store.upsert(makeTrip(ids.activeOld, { depMs: T0 - 30 * MIN, arrMs: T0 + 90 * MIN }), { fetchedAt: T0 - 20 * MIN });
  store.upsert(makeTrip(ids.activeNew, { depMs: T0 - 30 * MIN, arrMs: T0 + 90 * MIN }), { fetchedAt: T0 - 4 * MIN });
  assert.equal(oldRec.lastFetchedAt, T0 - 20 * MIN);

  await poller.tick();
  assert.deepEqual(tripCalls(client).map((c) => c.tripId), [ids.pastSeed, ids.nearSeed, ids.activeOld]);
  assert.equal(store.get(ids.pastSeed).trip.id, ids.pastSeed);
  assert.equal(store.get(ids.pastSeed).lastFetchedAt, T0);
  assert.equal(store.get(ids.pastSeed).discoveredVia, 'departures');
  clock.advance(15_000);
  await poller.tick();
  assert.deepEqual(tripCalls(client).map((c) => c.tripId).slice(3), [ids.activeNew, ids.farSeed]);
  assert.equal(poller.stats().lastRefreshAt, T0 + 15_000);
});

test('Refresh: Mindestabstand tripRefreshMinSec', async () => {
  const id = '1|b1|0|80|2092026';
  const trips = { [id]: makeTrip(id, { depMs: T0 - 30 * MIN, arrMs: T0 + 90 * MIN }) };
  const { clock, client, store, poller } = setup({ hubs: [], client: { trips } });
  store.upsert(makeDeparture(id, T0 - 30 * MIN));
  await poller.tick();
  assert.equal(tripCalls(client).length, 1);
  clock.advance(60_000);
  await poller.tick();
  assert.equal(tripCalls(client).length, 1, 'innerhalb von 180 s kein erneuter Abruf');
  clock.advance(120_000);
  await poller.tick();
  assert.equal(tripCalls(client).length, 2);
});

test('Refresh: Fahrten werden an disruptions.ingestTrip gemeldet; abweichende ID wird auf die angefragte gesetzt', async () => {
  const id = '1|c1|0|80|2092026';
  const trips = { [id]: makeTrip('andere-id-vom-upstream', { depMs: T0 - 30 * MIN, arrMs: T0 + 90 * MIN }) };
  const { store, poller, disruptions } = setup({ hubs: [], client: { trips } });
  store.upsert(makeDeparture(id, T0 - 30 * MIN));
  await poller.tick();
  assert.equal(disruptions.trips.length, 1);
  assert.equal(disruptions.trips[0].id, id);
  assert.equal(store.get(id).trip.id, id);
  assert.equal(store.size(), 1);
});

test('Refresh: Fehler zählen, nach 5 Fehlern wird die Fahrt verworfen; Fehler des Aggregators stören nicht', async () => {
  const id = '1|d1|0|80|2092026';
  const trips = { [id]: new UpstreamError('Serverfehler', { upstreamStatus: 500, retryable: true }) };
  const { clock, client, store, poller, lines, disruptions } = setup({ hubs: [], config: { tripRefreshMinSec: 30 }, client: { trips } });
  disruptions.ingestTrip = () => { throw new Error('kaputt'); };
  store.upsert(makeDeparture(id, T0 - 30 * MIN));
  for (let i = 1; i <= 4; i += 1) {
    await poller.tick();
    assert.equal(store.get(id).fetchErrors, i);
    assert.equal(store.get(id).lastFetchedAt, null);
    clock.advance(30_000);
  }
  await poller.tick();
  assert.equal(store.has(id), false);
  assert.equal(tripCalls(client).length, 5);
  assert.ok(lines.some((l) => l.msg.includes('verworfen')));
  assert.equal(poller.stats().counters.dropped, 1);
  assert.equal(poller.stats().counters.tripErrors, 5);

  // 404 für einen nie geladenen Seed: nach zwei Versuchen verwerfen
  const id2 = '1|d2|0|80|2092026';
  store.upsert(makeDeparture(id2, T0 - 30 * MIN));
  await poller.tick();
  assert.equal(store.get(id2).fetchErrors, 1);
  clock.advance(30_000);
  await poller.tick();
  assert.equal(store.has(id2), false);

  // Erfolgreich geladene Fahrt mit Aggregator-Fehler wird trotzdem gespeichert
  const id3 = '1|d3|0|80|2092026';
  client.trips[id3] = makeTrip(id3, { depMs: T0 - 30 * MIN, arrMs: T0 + 90 * MIN });
  store.upsert(makeDeparture(id3, T0 - 30 * MIN));
  clock.advance(30_000);
  await poller.tick();
  assert.ok(store.get(id3).trip);
  assert.ok(lines.some((l) => l.msg.includes('Störungsaggregator')));
});

test('Refresh: Client-Antwort ohne verwertbare Fahrt gilt als Fehler', async () => {
  const id = '1|e1|0|80|2092026';
  const { client, store, poller } = setup({ hubs: [], client: { trips: { [id]: 'unsinn' } } });
  client.trip = async () => ({ trip: null });
  store.upsert(makeDeparture(id, T0));
  await poller.tick();
  assert.equal(store.get(id).fetchErrors, 1);
  assert.equal(store.get(id).trip, null);
});

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

test('Prune: beendete Fahrten nach tripRetainAfterArrivalMin, Größe auf tripMaxTracked (niedrigste Priorität zuerst)', async () => {
  const { clock, store, poller, lines } = setup({ hubs: [], config: { tripMaxTracked: 10, tripRetainAfterArrivalMin: 10 } });
  const finished = store.upsert(makeTrip('1|f0|0|80|2092026', { depMs: T0 - 180 * MIN, arrMs: T0 - 11 * MIN }));
  const justDone = store.upsert(makeTrip('1|f1|0|80|2092026', { depMs: T0 - 180 * MIN, arrMs: T0 - 5 * MIN }));
  for (let i = 0; i < 6; i += 1) store.upsert(makeTrip(`1|g${i}|0|80|2092026`, { depMs: T0 - 30 * MIN, arrMs: T0 + 60 * MIN }), { fetchedAt: T0 });
  for (let i = 0; i < 5; i += 1) store.upsert(makeDeparture(`1|h${i}|0|80|2092026`, T0 + (100 + i) * MIN)); // ferne Seeds
  assert.equal(store.size(), 13);
  await poller.tick();
  assert.equal(store.has(finished.id), false, 'beendet und Aufbewahrung abgelaufen');
  assert.equal(store.size(), 10);
  // Verdrängt wurden: die gerade beendete Fahrt (niedrigste Priorität) und der älteste ferne Seed
  assert.equal(store.has(justDone.id), false);
  assert.equal(store.has('1|h0|0|80|2092026'), false);
  for (let i = 1; i < 5; i += 1) assert.equal(store.has(`1|h${i}|0|80|2092026`), true);
  for (let i = 0; i < 6; i += 1) assert.equal(store.has(`1|g${i}|0|80|2092026`), true);
  assert.equal(poller.stats().counters.pruned, 1);
  assert.equal(poller.stats().counters.evicted, 2);
  // store.prune-Fehler wird abgefangen und protokolliert, der Tick läuft weiter
  store.prune = () => { throw new Error('kaputt'); };
  clock.advance(15_000);
  await poller.tick();
  assert.equal(poller.stats().lastTickAt, T0 + 15_000);
  assert.ok(lines.some((l) => l.msg.includes('Bereinigung des Fahrtenspeichers fehlgeschlagen')));
  assert.equal(poller.stats().counters.pruned, 1);
});

// ---------------------------------------------------------------------------
// Circuit-Breaker / 429 → Tick-Abbruch und Backoff
// ---------------------------------------------------------------------------

test('Backoff: 429/Circuit bricht den Tick ab, Backoff verdoppelt sich bis 10 min, Erfolg setzt zurück', async () => {
  const trips = {};
  for (let i = 0; i < 6; i += 1) trips[`1|i${i}|0|80|2092026`] = new RateLimitedError(undefined, { retryAfterMs: null });
  const { clock, client, store, poller, lines } = setup({ hubs: HUBS.slice(0, 1), config: { concurrency: 1 }, client: { trips, boards: { 8011160: new CircuitOpenError() } } });
  for (const id of Object.keys(trips)) store.upsert(makeDeparture(id, T0 - 10 * MIN));

  await poller.tick();
  // Discovery-Board Berlin wirft CircuitOpen → Rest des Ticks entfällt
  assert.equal(client.calls.length, 1);
  assert.equal(poller.stats().backoffMs, 30_000);
  assert.equal(poller.stats().backoffUntil, T0 + 30_000);
  assert.equal(poller.stats().counters.abortedTicks, 1);
  assert.ok(lines.some((l) => l.msg.includes('Poller pausiert') && l.code === 'CIRCUIT_OPEN'));
  // Während des Backoffs: keine Anfragen
  clock.advance(15_000);
  await poller.tick();
  assert.equal(client.calls.length, 1);
  // Nach dem Backoff: erneuter Versuch, wieder Drosselung → 60 s
  clock.advance(15_000);
  await poller.tick();
  assert.equal(client.calls.length, 2);
  assert.equal(poller.stats().backoffMs, 60_000);
  // Verdopplung bis 600 s
  let expected = 60_000;
  for (let i = 0; i < 6; i += 1) {
    clock.advance(expected);
    await poller.tick();
    expected = Math.min(600_000, expected * 2);
    assert.equal(poller.stats().backoffMs, expected);
  }
  assert.equal(poller.stats().backoffMs, 600_000);
  // Erfolg hebt den Backoff auf
  client.boards['8011160'] = [];
  for (const id of Object.keys(trips)) client.trips[id] = makeTrip(id, { depMs: T0 - 10 * MIN, arrMs: T0 + 60 * MIN });
  clock.advance(600_000);
  await poller.tick();
  assert.equal(poller.stats().backoffMs, 0);
  assert.equal(poller.stats().backoffUntil, null);
  assert.equal(poller.stats().upstream.consecutiveErrors, 0);
  assert.ok(lines.some((l) => l.msg.includes('Backoff aufgehoben')));
});

test('Backoff: Retry-After der Drosselung wird berücksichtigt; Fahrten werden bei Drosselung nicht belastet', async () => {
  const id = '1|j1|0|80|2092026';
  const { client, store, poller } = setup({ hubs: [], client: { trips: { [id]: new RateLimitedError(undefined, { retryAfterMs: 90_000 }) } } });
  store.upsert(makeDeparture(id, T0 - 10 * MIN));
  await poller.tick();
  assert.equal(poller.stats().backoffMs, 90_000);
  assert.equal(store.get(id).fetchErrors, 0);
  assert.equal(client.calls.length, 1);
  assert.equal(poller.stats().upstream.lastErrorCode, 'UPSTREAM_RATE_LIMITED');
});

// ---------------------------------------------------------------------------
// requestBoard / getBoard
// ---------------------------------------------------------------------------

test('requestBoard: Cache nach maxAgeMs, Bündelung gleichzeitiger Anfragen, Discovery, Validierung', async () => {
  const boards = { 8011160: [makeDeparture('1|k1|0|80|2092026', T0 + 10 * MIN)], 8000105: [makeDeparture('1|k2|0|80|2092026', T0 + 10 * MIN, '8000105')], 8002549: [] };
  const { clock, client, store, poller, disruptions } = setup({ hubs: [], client: { boards, delayMs: 50 } });
  assert.equal(poller.getBoard('8011160'), null);
  assert.equal(poller.getBoard('abc'), null);

  const p1 = poller.requestBoard('8011160', { maxAgeMs: 60_000 });
  const p2 = poller.requestBoard('8011160', { maxAgeMs: 60_000 });
  assert.equal(p1, p2, 'gleichzeitige Anfragen werden gebündelt');
  await clock.advanceAsync(50);
  const board = await p1;
  assert.equal(board.stationId, '8011160');
  assert.equal(board.stationName, 'Bahnhof 8011160'); // Name der Abfahrtstafel (kein Knoten übergeben)
  assert.equal(board.fetchedAt, T0); // fetchedAt des Clients hat Vorrang
  assert.equal(board.departures.length, 1);
  assert.equal(board.arrivals, undefined);
  assert.equal(boardCalls(client).length, 1);
  assert.equal(store.has('1|k1|0|80|2092026'), true);
  assert.equal(disruptions.boards.length, 1);
  assert.equal(disruptions.boards[0].stop.id, '8011160');
  assert.equal(poller.getBoard('8011160'), board);
  assert.equal(poller.getBoard(8011160), board);
  assert.equal(poller.stats().boardsCached, 1);

  // Innerhalb von maxAgeMs aus dem Cache
  clock.advance(30_000);
  assert.equal(await poller.requestBoard('8011160', { maxAgeMs: 60_000 }), board);
  assert.equal(boardCalls(client).length, 1);
  // maxAgeMs 0 → frischer Abruf
  const fresh = poller.requestBoard('8011160', { maxAgeMs: 0 });
  await clock.advanceAsync(50);
  assert.notEqual(await fresh, board);
  assert.equal(boardCalls(client).length, 2);
  // Nach Ablauf des Cache-TTL (60 s) ist getBoard leer
  clock.advance(61_000);
  assert.equal(poller.getBoard('8011160'), null);
  // Nicht-Knoten: Name aus der Abfahrtstafel, bei leerer Tafel über findStation
  const p3 = poller.requestBoard('8000105', { maxAgeMs: 60_000 });
  await clock.advanceAsync(50);
  assert.equal((await p3).stationName, 'Bahnhof 8000105');
  const pEmpty = poller.requestBoard('8002549', { maxAgeMs: 60_000 });
  await clock.advanceAsync(50);
  assert.equal((await pEmpty).stationName, 'Hamburg Hbf');
  // Ankünfte explizit anfordern
  const p4 = poller.requestBoard('8000105', { maxAgeMs: 60_000, includeArrivals: true });
  await clock.advanceAsync(50);
  assert.deepEqual((await p4).arrivals, []);
  assert.equal(boardCalls(client).length, 5);
  // Validierung
  await assert.rejects(poller.requestBoard('12'), ValidationError);
  await assert.rejects(poller.requestBoard(null), ValidationError);
  await assert.rejects(poller.requestBoard('8011160; DROP'), ValidationError);
  // Upstream-Fehler wird weitergereicht, nichts gecacht
  const pErr = assert.rejects(poller.requestBoard('8000261', { maxAgeMs: 0 }), UpstreamError);
  await clock.advanceAsync(50);
  await pErr;
  assert.equal(poller.getBoard('8000261'), null);
});

// ---------------------------------------------------------------------------
// refreshTrip
// ---------------------------------------------------------------------------

test('refreshTrip: unbekannte Fahrt wird geladen (manual), maxAgeMs respektiert, Fehler weitergereicht', async () => {
  const id = '1|m1|0|80|2092026';
  const trips = { [id]: makeTrip(id, { depMs: T0 - 30 * MIN, arrMs: T0 + 90 * MIN }) };
  const { clock, client, store, poller, disruptions } = setup({ hubs: [], client: { trips, delayMs: 20 } });
  const p1 = poller.refreshTrip(id, { maxAgeMs: 60_000 });
  const p2 = poller.refreshTrip(id, { maxAgeMs: 60_000 });
  assert.equal(p1, p2);
  await clock.advanceAsync(20);
  const rec = await p1;
  assert.equal(rec.id, id);
  assert.equal(rec.discoveredVia, 'manual');
  assert.equal(rec.trip.id, id);
  assert.equal(rec.lastFetchedAt, T0); // fetchedAt des Clients
  assert.equal(tripCalls(client).length, 1);
  assert.equal(disruptions.trips.length, 1);
  assert.equal(poller.stats().lastRefreshAt, T0 + 20);
  // jünger als maxAgeMs → Cache
  clock.advance(30_000);
  assert.equal(await poller.refreshTrip(id, { maxAgeMs: 60_000 }), rec);
  assert.equal(tripCalls(client).length, 1);
  // älter → erneuter Abruf; Seed-Herkunft bleibt
  clock.advance(60_000);
  const p3 = poller.refreshTrip(id, { maxAgeMs: 60_000 });
  await clock.advanceAsync(20);
  assert.equal(await p3, rec);
  assert.equal(tripCalls(client).length, 2);
  // Fehler: Zähler steigt, Fehler wird weitergereicht, alte Daten bleiben
  client.trips[id] = new UpstreamTimeoutError();
  const p4 = assert.rejects(poller.refreshTrip(id, { maxAgeMs: 0 }), UpstreamTimeoutError);
  await clock.advanceAsync(20);
  await p4;
  assert.equal(rec.fetchErrors, 1);
  assert.ok(rec.trip);
  // Drosselung belastet den Eintrag nicht
  client.trips[id] = new CircuitOpenError();
  const p5 = assert.rejects(poller.refreshTrip(id, { maxAgeMs: 0 }), CircuitOpenError);
  await clock.advanceAsync(20);
  await p5;
  assert.equal(rec.fetchErrors, 1);
  // Validierung
  await assert.rejects(poller.refreshTrip('abc'), ValidationError);
  await assert.rejects(poller.refreshTrip(null), ValidationError);
  await assert.rejects(poller.refreshTrip('abcdefgh'), ValidationError);
  // Unbekannte Fahrt (404) → Fehler, kein Eintrag
  const p6 = assert.rejects(poller.refreshTrip('1|unbekannt|0|80|2092026'), (e) => e instanceof UpstreamError && e.upstreamStatus === 404);
  await clock.advanceAsync(20);
  await p6;
  assert.equal(store.has('1|unbekannt|0|80|2092026'), false);
  // Ein Seed wird per Standard-maxAge (tripRefreshMinSec) nicht als frisch angesehen, weil trip fehlt
  const seedId = '1|m2|0|80|2092026';
  store.upsert(makeDeparture(seedId, T0));
  client.trips[seedId] = makeTrip(seedId);
  const p7 = poller.refreshTrip(seedId);
  await clock.advanceAsync(20);
  assert.equal((await p7).discoveredVia, 'departures');
});

// ---------------------------------------------------------------------------
// Reentrancy, start/stop, stats
// ---------------------------------------------------------------------------

test('tick: Reentrancy-Schutz – paralleler Aufruf liefert dasselbe Promise', async () => {
  const boards = { 8011160: [] };
  const { clock, client, poller } = setup({ hubs: HUBS.slice(0, 1), client: { boards, delayMs: 100 } });
  const p1 = poller.tick();
  const p2 = poller.tick();
  assert.equal(p1, p2);
  await clock.advanceAsync(100);
  await p1;
  assert.equal(boardCalls(client).length, 1);
  const p3 = poller.tick();
  assert.notEqual(p3, p1);
  await clock.advanceAsync(100);
  await p3;
});

test('start/stop: Ticks laufen über injizierte Timer; stop wartet auf laufenden Tick und räumt Timer ab', async () => {
  const boards = Object.fromEntries(HUBS.map((h) => [h.id, []]));
  const { clock, client, poller, lines } = setup({ hubs: HUBS, config: { maxRpm: 600 }, client: { boards, delayMs: 10 } });
  assert.equal(poller.stats().running, false);
  poller.start();
  poller.start(); // idempotent
  assert.equal(poller.stats().running, true);
  assert.equal(clock.pending(), 1);
  // 6 Knoten, Nebenläufigkeit 2, je 10 ms → Tick dauert 30 ms
  await clock.advanceAsync(1 + 30);
  assert.equal(boardCalls(client).length, 6);
  assert.equal(poller.stats().tickCount, 1);
  assert.equal(poller.stats().lastTickDurationMs, 30);
  assert.equal(poller.stats().nextTickAt, T0 + 31 + 15_000);
  await clock.advanceAsync(15_000 + 30);
  assert.equal(poller.stats().tickCount, 2);
  // Stop während eines laufenden Ticks (Tick 3 hat begonnen, Boards noch offen)
  await clock.advanceAsync(15_000 + 5);
  const tickCountBefore = poller.stats().tickCount;
  assert.equal(tickCountBefore, 3);
  const stopped = poller.stop();
  assert.equal(poller.stats().running, false);
  await clock.advanceAsync(60);
  await stopped;
  assert.equal(clock.pending(), 0, 'keine offenen Timer nach stop()');
  assert.equal(poller.stats().tickCount, tickCountBefore);
  await clock.advanceAsync(60_000);
  assert.equal(poller.stats().tickCount, tickCountBefore, 'nach stop keine weiteren Ticks');
  await poller.stop(); // idempotent
  assert.ok(lines.some((l) => l.msg === 'Poller gestartet' && l.hubs === 6));
  assert.ok(lines.some((l) => l.msg === 'Poller gestoppt'));
  // Manuelle Ticks bleiben nach dem Stopp möglich
  await poller.tick();
  assert.equal(poller.stats().tickCount, tickCountBefore + 1);
});

test('start: während eines Backoffs wird der nächste Tick nicht später als tickMs geplant und Backoff eingehalten', async () => {
  const { clock, client, poller } = setup({ hubs: HUBS.slice(0, 1), client: { boards: { 8011160: new CircuitOpenError() } } });
  poller.start();
  await clock.advanceAsync(1);
  assert.equal(client.calls.length, 1);
  assert.equal(poller.stats().backoffMs, 30_000);
  await clock.advanceAsync(15_000);
  assert.equal(client.calls.length, 1, 'im Backoff keine Anfrage');
  await clock.advanceAsync(15_000);
  assert.equal(client.calls.length, 2, 'nach dem Backoff erneuter Versuch');
  await poller.stop();
});

test('stats: vollständige Struktur', async () => {
  const active = '1|s1|0|80|2092026';
  const trips = { [active]: makeTrip(active, { depMs: T0 - 30 * MIN, arrMs: T0 + 90 * MIN }) };
  const { store, poller } = setup({ hubs: HUBS.slice(0, 1), client: { boards: { 8011160: [makeDeparture('1|s2|0|80|2092026', T0 + 60 * MIN)] }, trips, available: 100, breakerState: 'half-open' } });
  store.upsert(makeDeparture(active, T0 - 30 * MIN));
  const before = poller.stats();
  assert.equal(before.lastTickAt, null);
  assert.equal(before.upstream.state, 'half-open');
  await poller.tick();
  const s = poller.stats();
  assert.equal(s.running, false);
  assert.equal(s.trackedTrips, 2);
  assert.equal(s.activeTrips, 1);
  assert.equal(s.pendingTrips, 1);
  assert.equal(s.lastDiscoveryAt, T0);
  assert.equal(s.lastRefreshAt, T0);
  assert.equal(s.lastTickAt, T0);
  assert.equal(s.lastTickDurationMs, 0);
  assert.equal(s.requestsLastMinute, 2);
  assert.equal(s.boardsCached, 1);
  assert.deepEqual(s.upstream, { state: 'half-open', lastSuccessAt: T0, lastErrorAt: null, lastErrorCode: null, consecutiveErrors: 0 });
  assert.deepEqual(s.budget, { rpm: 40, perTick: 8, available: 30 });
  assert.deepEqual(Object.keys(s.counters).sort(), ['abortedTicks', 'boardErrors', 'boards', 'dropped', 'evicted', 'pruned', 'trips', 'tripErrors'].sort());
  // Client ohne stats() → Zustand unbekannt, Budget aus eigener Zählung
  const clock = createFakeClock(T0);
  const bare = { departures: async () => ({ departures: [] }), trip: async () => ({ trip: makeTrip(active) }) };
  const p2 = createPoller({ config: BASE_CONFIG, client: bare, store: createTripStore({ now: clock.now }), hubs: [], now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout });
  assert.equal(p2.stats().upstream.state, 'unknown');
  assert.equal(p2.stats().budget.available, 32);
  // Client, dessen stats() wirft
  const throwing = { ...bare, stats: () => { throw new Error('x'); } };
  const p3 = createPoller({ config: BASE_CONFIG, client: throwing, store: createTripStore({ now: clock.now }), hubs: [], now: clock.now });
  assert.equal(p3.stats().upstream.state, 'unknown');
  assert.equal(p3.stats().budget.available, 32);
});

test('Nebenläufigkeit: höchstens `concurrency` Anfragen gleichzeitig', async () => {
  const trips = {};
  let inFlight = 0;
  let maxInFlight = 0;
  const clock = createFakeClock(T0);
  for (let i = 0; i < 6; i += 1) {
    const id = `1|n${i}|0|80|2092026`;
    trips[id] = () => new Promise((resolve) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      clock.setTimeout(() => { inFlight -= 1; resolve(makeTrip(id, { depMs: T0 - 30 * MIN, arrMs: T0 + 90 * MIN })); }, 10);
    });
  }
  const client = fakeClient({ now: clock.now, trips });
  const store = createTripStore({ now: clock.now });
  for (const id of Object.keys(trips)) store.upsert(makeDeparture(id, T0 - 30 * MIN));
  const poller = createPoller({ config: { ...BASE_CONFIG, concurrency: 2 }, client, store, hubs: [], now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout });
  const p = poller.tick();
  await clock.advanceAsync(100);
  await p;
  assert.equal(tripCalls(client).length, 6);
  assert.equal(maxInFlight, 2);
});
