/**
 * Poller: entdeckt Fernverkehrsfahrten über die Abfahrtstafeln der Knotenbahnhöfe
 * („Discovery“), lädt und aktualisiert die Fahrten („Refresh“) und räumt den
 * Fahrtenspeicher auf („Prune“). Alles geschieht in Ticks fester Länge.
 *
 * Budget: Der Token-Bucket gehört dem Upstream-Client; der Poller kennt ihn nicht
 * direkt. Er plant deshalb pro Tick höchstens `maxRpm · tickSec/60 · 0,8` Anfragen
 * (20 % Reserve für On-Demand-Abrufe der API), begrenzt zusätzlich durch das
 * gleitende Minutenfenster der eigenen Anfragen und – falls der Client es meldet –
 * durch dessen aktuell verfügbares Budget.
 *
 * Discovery: Knoten der Stufe 1 alle `hubPollIntervalSec`, Stufe 2 mit Faktor
 * `hubTier2Factor`. Fällige Knoten werden nach Fälligkeit (Round-Robin) und
 * budgetbegrenzt abgearbeitet, so dass die Abrufe über das Intervall verteilt
 * bleiben und nie alle auf einmal erfolgen.
 *
 * Refresh-Priorität: (1) nie geladene Fahrten, deren Abfahrt in ≤ `tripPrefetch-
 * BeforeDepartureMin` liegt oder vergangen ist; (2) laufende Fahrten, älteste
 * Aktualisierung zuerst; (3) übrige. Mindestabstand `tripRefreshMinSec`.
 *
 * Fehler: 429/Circuit-Breaker brechen den Tick ab und verdoppeln den Backoff
 * (bis 10 min); Fahrten werden nach `maxFetchErrors` Fehlern verworfen.
 *
 * Timer laufen ausschließlich über `setTimeoutImpl` (Standard: unref()t), so dass
 * Tests mit Fake-Uhr laufen und das Herunterfahren nicht blockiert wird.
 */
import { ValidationError, CircuitOpenError, RateLimitedError, UpstreamError, AppError } from '../lib/errors.js';
import { createTtlCache } from '../lib/ttl-cache.js';
import { silentLogger } from '../logger.js';
import { findStation } from '../data/stations.js';

const MINUTE_MS = 60_000;
const STATION_ID_RE = /^\d{5,12}$/;
const TRIP_ID_MIN = 5;
const TRIP_ID_MAX = 512;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
/** Anteil des Minutenbudgets, den der Poller einplant (Rest bleibt für On-Demand-Abrufe). */
export const BUDGET_SHARE = 0.8;
export const DEFAULT_TICK_INTERVAL_MS = 15_000;
export const DEFAULT_BACKOFF_BASE_MS = 30_000;
export const DEFAULT_BACKOFF_MAX_MS = 10 * MINUTE_MS;
export const DEFAULT_MAX_FETCH_ERRORS = 5;
/** Maximale Wartezeit auf einen Knoten nach einem fehlgeschlagenen Board-Abruf. */
const HUB_RETRY_MAX_MS = 2 * MINUTE_MS;

function defaultSetTimeout(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function positiveInt(v, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = finiteOrNull(v);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isValidTripId(id) {
  return typeof id === 'string' && id.length >= TRIP_ID_MIN && id.length <= TRIP_ID_MAX && !CONTROL_CHARS_RE.test(id);
}

/** Kurzform einer Trip-ID für Logs. */
function shortId(id) {
  return typeof id === 'string' && id.length > 40 ? `${id.slice(0, 40)}…` : id;
}

/** True für Fehler, die den ganzen Tick abbrechen (Datenquelle drosselt oder ist gesperrt). */
export function isThrottleError(err) {
  return err instanceof RateLimitedError || err instanceof CircuitOpenError;
}

/**
 * Liefert den Fälligkeitszustand eines Eintrags für den Refresh.
 * @param {import('./trip-store.js').TripRecord} record
 * @param {number} nowMs
 * @returns {'active'|'scheduled'|'finished'|'unknown'}
 */
export function recordPhase(record, nowMs) {
  const dep = record.departureMs;
  const arr = record.arrivalMs;
  if (arr !== null && nowMs >= arr) return 'finished';
  if (dep !== null && nowMs < dep) return 'scheduled';
  if (dep !== null || arr !== null) return 'active';
  return 'unknown';
}

/**
 * Prioritätsklasse eines Eintrags für den Refresh (kleiner = wichtiger), `null` = nicht fällig.
 * Klasse 0: nie geladen und Abfahrt in ≤ prefetchMs oder vergangen.
 * Klasse 1: geladen und laufend (Abfahrt vorbei, Ankunft noch nicht).
 * Klasse 2: übrige (Seeds mit ferner Abfahrt, geladene aber noch nicht gestartete Fahrten,
 *           beendete Fahrten, die seit der Ankunft nicht mehr geprüft wurden).
 * @param {import('./trip-store.js').TripRecord} record
 * @param {number} nowMs
 * @param {{prefetchMs:number, minIntervalMs:number}} options
 * @returns {{cls:number, key:number}|null}
 */
export function refreshPriority(record, nowMs, { prefetchMs, minIntervalMs }) {
  if (record.lastFetchedAt !== null && nowMs - record.lastFetchedAt < minIntervalMs) return null;
  const phase = recordPhase(record, nowMs);
  if (record.trip === null) {
    if (record.departureMs === null || record.departureMs - nowMs <= prefetchMs) {
      return { cls: 0, key: record.departureMs ?? record.discoveredAt };
    }
    return { cls: 2, key: record.departureMs };
  }
  if (phase === 'active' || phase === 'unknown') return { cls: 1, key: record.lastFetchedAt ?? 0 };
  if (phase === 'finished') {
    // Nach der (planmäßigen) Ankunft genau einmal nachprüfen – der Zug könnte verspätet noch fahren.
    if (record.lastFetchedAt !== null && record.lastFetchedAt >= record.arrivalMs) return null;
    return { cls: 2, key: (record.lastFetchedAt ?? 0) + Number.MAX_SAFE_INTEGER / 4 };
  }
  // scheduled, aber geladen: erst kurz vor Abfahrt wieder interessant
  if (record.departureMs - nowMs > prefetchMs) return null;
  return { cls: 2, key: record.lastFetchedAt ?? 0 };
}

/**
 * Sortiert die fälligen Einträge nach Priorität (Klasse, dann Schlüssel aufsteigend).
 * @returns {import('./trip-store.js').TripRecord[]}
 */
export function prioritizeRecords(records, nowMs, options) {
  const out = [];
  for (const r of records) {
    const p = refreshPriority(r, nowMs, options);
    if (p) out.push({ r, p });
  }
  out.sort((a, b) => a.p.cls - b.p.cls || a.p.key - b.p.key || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
  return out.map((x) => x.r);
}

/**
 * Rangfolge für die Größenbegrenzung des Speichers: niedrigste Priorität zuerst
 * (beendet → ferne Seeds → geplante → laufende Fahrten; innerhalb einer Klasse am längsten nicht gesehen zuerst).
 */
export function evictionOrder(records, nowMs, { prefetchMs }) {
  const rank = (r) => {
    const phase = recordPhase(r, nowMs);
    if (phase === 'finished') return 0;
    if (r.trip === null && r.departureMs !== null && r.departureMs - nowMs > prefetchMs) return 1;
    if (phase === 'scheduled') return 2;
    if (phase === 'unknown') return 3;
    return 4;
  };
  return records
    .map((r) => ({ r, rank: rank(r) }))
    .sort((a, b) => a.rank - b.rank || a.r.lastSeenAt - b.r.lastSeenAt || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0))
    .map((x) => x.r);
}

/** Zahl der Anfragen, die der Poller in einem Tick einplanen darf. */
export function tickBudget(maxRpm, tickIntervalMs) {
  return Math.max(1, Math.floor((maxRpm * tickIntervalMs) / MINUTE_MS * BUDGET_SHARE));
}

/**
 * @param {object} options
 * @param {object} options.config `config.transport`
 * @param {object} options.client Upstream-Adapter (`departures`, `trip`, `stats`)
 * @param {object} options.store Fahrtenspeicher (`createTripStore`)
 * @param {object} [options.disruptions] Störungsaggregator (`ingestTrip`, `ingestDepartures`)
 * @param {Array<{id:string, name:string, lat:number, lon:number, tier:1|2}>} options.hubs Knotenbahnhöfe
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimeoutImpl]
 * @param {(handle: unknown) => void} [options.clearTimeoutImpl]
 * @param {() => number} [options.random] Zufallsquelle für Jitter (0 ≤ x < 1)
 * @param {number} [options.tickIntervalMs]
 * @param {number} [options.maxFetchErrors]
 * @param {number} [options.backoffBaseMs]
 * @param {number} [options.backoffMaxMs]
 * @param {(nameOrId: string) => object|null} [options.resolveStation]
 */
export function createPoller({
  config,
  client,
  store,
  disruptions = null,
  hubs = [],
  logger = silentLogger,
  now = () => Date.now(),
  setTimeoutImpl = defaultSetTimeout,
  clearTimeoutImpl = clearTimeout,
  random = Math.random,
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
  maxFetchErrors = DEFAULT_MAX_FETCH_ERRORS,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  resolveStation = findStation,
} = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('config (config.transport) ist erforderlich');
  if (!client || typeof client.departures !== 'function' || typeof client.trip !== 'function') {
    throw new TypeError('client mit departures() und trip() ist erforderlich');
  }
  if (!store || typeof store.upsert !== 'function' || typeof store.all !== 'function') throw new TypeError('store ist erforderlich');
  if (!Array.isArray(hubs)) throw new TypeError('hubs muss ein Array sein');
  if (typeof now !== 'function') throw new TypeError('now muss eine Funktion sein');
  if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') throw new TypeError('Timer-Funktionen müssen Funktionen sein');
  if (typeof random !== 'function') throw new TypeError('random muss eine Funktion sein');

  const log = logger && typeof logger.info === 'function' ? logger : silentLogger;
  const cfg = {
    maxRpm: positiveInt(config.maxRpm, 40, { max: 100_000 }),
    concurrency: positiveInt(config.concurrency, 2, { max: 64 }),
    products: Array.isArray(config.products) && config.products.length > 0 ? [...config.products] : ['nationalExpress'],
    hubPollIntervalMs: positiveInt(config.hubPollIntervalSec, 600) * 1000,
    hubBoardDurationMin: positiveInt(config.hubBoardDurationMin, 60, { max: 1440 }),
    hubIncludeArrivals: config.hubIncludeArrivals === true,
    hubTier2Factor: positiveInt(config.hubTier2Factor, 2, { max: 100 }),
    tripRefreshMinMs: positiveInt(config.tripRefreshMinSec, 180) * 1000,
    tripMaxTracked: positiveInt(config.tripMaxTracked, 400),
    prefetchMs: positiveInt(config.tripPrefetchBeforeDepartureMin, 20, { min: 0 }) * MINUTE_MS,
    retainAfterArrivalMs: positiveInt(config.tripRetainAfterArrivalMin, 10, { min: 0 }) * MINUTE_MS,
    boardCacheMs: positiveInt(config.boardCacheSec, 60) * 1000,
  };
  const tickMs = positiveInt(tickIntervalMs, DEFAULT_TICK_INTERVAL_MS, { min: 100 });
  const maxErrors = positiveInt(maxFetchErrors, DEFAULT_MAX_FETCH_ERRORS);
  const backoffBase = positiveInt(backoffBaseMs, DEFAULT_BACKOFF_BASE_MS);
  const backoffMax = Math.max(backoffBase, positiveInt(backoffMaxMs, DEFAULT_BACKOFF_MAX_MS));
  const perTickBudget = tickBudget(cfg.maxRpm, tickMs);
  const perMinuteBudget = Math.max(1, Math.floor(cfg.maxRpm * BUDGET_SHARE));
  const ingest = disruptions && typeof disruptions === 'object' ? disruptions : null;

  /** Knoten mit Fälligkeit; ungültige Einträge werden (mit Warnung) übersprungen. */
  const hubStates = [];
  {
    const seen = new Set();
    let skipped = 0;
    hubs.forEach((h, index) => {
      const id = h && typeof h.id === 'string' ? h.id : (Number.isInteger(h?.id) ? String(h.id) : null);
      if (!id || !STATION_ID_RE.test(id) || seen.has(id)) {
        skipped += 1;
        return;
      }
      seen.add(id);
      const tier = h.tier === 2 ? 2 : 1;
      hubStates.push({
        id,
        name: typeof h.name === 'string' ? h.name : id,
        lat: finiteOrNull(h.lat),
        lon: finiteOrNull(h.lon),
        tier,
        index,
        intervalMs: tier === 2 ? cfg.hubPollIntervalMs * cfg.hubTier2Factor : cfg.hubPollIntervalMs,
        nextDueAt: 0, // sofort fällig; Reihenfolge ergibt sich aus tier/index
        lastFetchedAt: null,
        fetchCount: 0,
        errors: 0,
      });
    });
    if (skipped > 0) log.warn('Ungültige oder doppelte Knotenbahnhöfe übersprungen', { skipped });
  }
  const hubById = new Map(hubStates.map((h) => [h.id, h]));

  const boardCache = createTtlCache({ maxEntries: Math.max(50, hubStates.length * 2), defaultTtlMs: cfg.boardCacheMs, now });
  /** @type {Map<string, Promise<object>>} laufende On-Demand-Abrufe (Zusammenfassung gleichzeitiger Anfragen) */
  const inFlightBoards = new Map();
  const inFlightTrips = new Map();
  /** Zeitstempel der eigenen Anfragen (gleitendes Minutenfenster). */
  let requestTimes = [];

  const state = {
    running: false,
    stopRequested: false,
    timer: null,
    tickPromise: null,
    tickCount: 0,
    lastDiscoveryAt: null,
    lastRefreshAt: null,
    lastTickAt: null,
    lastTickDurationMs: null,
    nextTickAt: null,
    backoffMs: 0,
    backoffUntil: null,
    upstream: { lastSuccessAt: null, lastErrorAt: null, lastErrorCode: null, consecutiveErrors: 0 },
    counters: { boards: 0, trips: 0, boardErrors: 0, tripErrors: 0, dropped: 0, pruned: 0, evicted: 0, abortedTicks: 0 },
  };

  function jitter(ms, spread = 0.2) {
    const r = Math.min(Math.max(random(), 0), 0.999999);
    return Math.round(ms * (1 - spread / 2 + r * spread));
  }

  function noteRequest(t) {
    requestTimes.push(t);
    if (requestTimes.length > 4 * perMinuteBudget + 64) pruneRequestTimes(t);
  }

  function pruneRequestTimes(t) {
    const cutoff = t - MINUTE_MS;
    requestTimes = requestTimes.filter((x) => x > cutoff);
  }

  function requestsLastMinute() {
    pruneRequestTimes(now());
    return requestTimes.length;
  }

  function noteSuccess(t) {
    state.upstream.lastSuccessAt = t;
    state.upstream.consecutiveErrors = 0;
    if (state.backoffMs !== 0) {
      state.backoffMs = 0;
      state.backoffUntil = null;
      log.info('Datenquelle wieder erreichbar, Backoff aufgehoben');
    }
  }

  function noteError(err, t) {
    state.upstream.lastErrorAt = t;
    state.upstream.lastErrorCode = err instanceof AppError ? err.code : 'INTERNAL';
    state.upstream.consecutiveErrors += 1;
  }

  /** Verdoppelnder Backoff nach Drosselung/offenem Breaker (bis `backoffMax`). */
  function applyBackoff(err, t) {
    const retryAfter = err instanceof RateLimitedError ? finiteOrNull(err.retryAfterMs) : null;
    const next = state.backoffMs === 0 ? backoffBase : Math.min(backoffMax, state.backoffMs * 2);
    state.backoffMs = Math.min(backoffMax, Math.max(next, retryAfter ?? 0));
    state.backoffUntil = t + state.backoffMs;
    log.warn('Datenquelle drosselt oder ist gesperrt – Poller pausiert', { code: err.code, backoffMs: state.backoffMs });
  }

  /** Verfügbares Budget des Clients (falls gemeldet), sonst `null`. */
  function clientAvailable() {
    if (typeof client.stats !== 'function') return null;
    try {
      const s = client.stats();
      const a = s && s.budget ? finiteOrNull(s.budget.available) : null;
      return a === null ? null : Math.floor(a);
    } catch {
      return null;
    }
  }

  function upstreamState() {
    if (typeof client.stats !== 'function') return 'unknown';
    try {
      const s = client.stats();
      if (s && typeof s.breaker === 'string') return s.breaker;
      if (s && s.breaker && typeof s.breaker.state === 'string') return s.breaker.state;
      if (s && s.upstream && typeof s.upstream.state === 'string') return s.upstream.state;
    } catch {
      // Statistik ist optional.
    }
    return 'unknown';
  }

  /** Anfragen, die in diesem Tick eingeplant werden dürfen (Tick-Budget, Minutenfenster, Client-Budget). */
  function availableBudget() {
    let n = Math.min(perTickBudget, perMinuteBudget - requestsLastMinute());
    const avail = clientAvailable();
    if (avail !== null) n = Math.min(n, avail);
    return Math.max(0, n);
  }

  function stationNameOf(stationId, departures) {
    const hub = hubById.get(stationId);
    if (hub) return hub.name;
    for (const d of departures) {
      if (d && d.stop && typeof d.stop.name === 'string' && d.stop.name !== '') return d.stop.name;
    }
    try {
      const s = typeof resolveStation === 'function' ? resolveStation(stationId) : null;
      if (s && typeof s.name === 'string') return s.name;
    } catch {
      // Namensauflösung ist optional.
    }
    return null;
  }

  function stopRefOf(stationId, board) {
    const hub = hubById.get(stationId);
    if (hub) return { id: hub.id, name: hub.name, lat: hub.lat, lon: hub.lon };
    const first = board.departures.find((d) => d && d.stop);
    if (first && first.stop) {
      return { id: first.stop.id ?? stationId, name: first.stop.name ?? board.stationName ?? '', lat: first.stop.lat ?? null, lon: first.stop.lon ?? null };
    }
    return { id: stationId, name: board.stationName ?? '', lat: null, lon: null };
  }

  function safeIngest(method, ...args) {
    if (!ingest || typeof ingest[method] !== 'function') return;
    try {
      ingest[method](...args);
    } catch (err) {
      log.warn('Störungsaggregator hat einen Fehler gemeldet', { method, err });
    }
  }

  /** Übernimmt neue Trip-IDs eines Boards als Seeds in den Speicher. */
  function discoverFrom(board, t) {
    let added = 0;
    const lists = [['departures', board.departures], ['arrivals', board.arrivals]];
    for (const [via, list] of lists) {
      if (!Array.isArray(list)) continue;
      for (const d of list) {
        if (!d || typeof d.tripId !== 'string' || !isValidTripId(d.tripId)) continue;
        if (store.has(d.tripId)) {
          if (typeof store.touch === 'function') store.touch(d.tripId, t);
          else store.upsert(d, { seenAt: t });
          continue;
        }
        try {
          store.upsert(d, { discoveredVia: via, seenAt: t });
          added += 1;
        } catch (err) {
          log.debug('Eintrag der Abfahrtstafel konnte nicht übernommen werden', { err });
        }
      }
    }
    return added;
  }

  /**
   * Holt eine Abfahrtstafel, legt sie im Cache ab, entdeckt Fahrten und meldet Störungen.
   * @returns {Promise<{stationId:string, stationName:string|null, fetchedAt:number, departures:Array, arrivals?:Array}>}
   */
  async function fetchBoard(stationId, { includeArrivals }) {
    const startedAt = now();
    noteRequest(startedAt);
    if (includeArrivals) noteRequest(startedAt);
    let result;
    try {
      result = await client.departures(stationId, {
        duration: cfg.hubBoardDurationMin,
        products: cfg.products,
        includeArrivals,
      });
    } catch (err) {
      const t = now();
      noteError(err, t);
      throw err;
    }
    const t = now();
    noteSuccess(t);
    const departures = result && Array.isArray(result.departures) ? result.departures : [];
    const board = {
      stationId,
      stationName: stationNameOf(stationId, departures),
      fetchedAt: finiteOrNull(result && result.fetchedAt) ?? t,
      departures,
    };
    if (includeArrivals) board.arrivals = result && Array.isArray(result.arrivals) ? result.arrivals : [];
    boardCache.set(stationId, board);
    state.counters.boards += 1;
    const added = discoverFrom(board, t);
    safeIngest('ingestDepartures', stopRefOf(stationId, board), board.departures);
    log.debug('Abfahrtstafel geladen', { stationId, departures: departures.length, newTrips: added });
    return board;
  }

  /**
   * Lädt eine Fahrt, aktualisiert den Speicher und meldet Störungen.
   * @returns {Promise<import('./trip-store.js').TripRecord>}
   */
  async function fetchTrip(tripId, { discoveredVia = 'manual' } = {}) {
    const startedAt = now();
    noteRequest(startedAt);
    let result;
    try {
      result = await client.trip(tripId, { polyline: true });
    } catch (err) {
      const t = now();
      noteError(err, t);
      throw err;
    }
    const t = now();
    noteSuccess(t);
    const trip = result && result.trip && typeof result.trip === 'object' ? result.trip : null;
    if (!trip || !Array.isArray(trip.stopovers)) {
      throw new UpstreamError('Die Datenquelle hat keine verwertbare Fahrt geliefert.', { code: 'UPSTREAM_FORMAT', retryable: false });
    }
    if (trip.id !== tripId) trip.id = tripId;
    const record = store.upsert(trip, { discoveredVia, fetchedAt: finiteOrNull(result.fetchedAt) ?? t, seenAt: t });
    state.counters.trips += 1;
    safeIngest('ingestTrip', trip);
    log.debug('Fahrt geladen', { tripId: shortId(tripId), line: record.lineName, stopovers: trip.stopovers.length });
    return record;
  }

  /** Verbucht einen fehlgeschlagenen Fahrtabruf; verwirft die Fahrt nach `maxErrors` Fehlern. */
  function handleTripError(tripId, err) {
    state.counters.tripErrors += 1;
    const record = store.get(tripId);
    if (!record) return;
    const notFound = err instanceof UpstreamError && err.upstreamStatus === 404;
    const invalid = err instanceof ValidationError;
    record.fetchErrors += 1;
    if (invalid || record.fetchErrors >= maxErrors || (notFound && record.trip === null && record.fetchErrors >= 2)) {
      store.remove(tripId);
      state.counters.dropped += 1;
      log.info('Fahrt nach wiederholten Fehlern verworfen', { tripId: shortId(tripId), errors: record.fetchErrors, code: err.code ?? null });
    }
  }

  /**
   * Führt Aufgaben mit begrenzter Nebenläufigkeit aus. `stopOnThrottle` beendet die
   * Abarbeitung, sobald eine Drosselung erkannt wurde (verbleibende Aufgaben entfallen).
   * @param {Array<() => Promise<void>>} tasks
   * @returns {Promise<{done:number, skipped:number, throttled:Error|null}>}
   */
  async function runLimited(tasks) {
    let next = 0;
    let done = 0;
    let throttled = null;
    const worker = async () => {
      for (;;) {
        if (throttled || state.stopRequested) return;
        const i = next;
        if (i >= tasks.length) return;
        next += 1;
        try {
          await tasks[i]();
        } catch (err) {
          if (isThrottleError(err) && !throttled) throttled = err;
        }
        done += 1;
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(cfg.concurrency, tasks.length); i += 1) workers.push(worker());
    await Promise.all(workers);
    return { done, skipped: tasks.length - done, throttled };
  }

  /** Discovery-Aufgaben für fällige Knoten (Round-Robin nach Fälligkeit), höchstens `limit`. */
  function planDiscovery(t, limit) {
    const due = hubStates.filter((h) => h.nextDueAt <= t);
    due.sort((a, b) => a.nextDueAt - b.nextDueAt || a.tier - b.tier || a.index - b.index);
    const costPerBoard = cfg.hubIncludeArrivals ? 2 : 1;
    const picked = due.slice(0, Math.max(0, Math.floor(limit / costPerBoard)));
    return picked.map((hub) => async () => {
      // Fälligkeit sofort fortschreiben, damit ein Fehler nicht zu sofortigen Wiederholungen führt.
      hub.nextDueAt = t + jitter(hub.intervalMs, 0.1);
      try {
        await fetchBoard(hub.id, { includeArrivals: cfg.hubIncludeArrivals });
        hub.lastFetchedAt = now();
        hub.fetchCount += 1;
        hub.errors = 0;
        state.lastDiscoveryAt = hub.lastFetchedAt;
      } catch (err) {
        hub.errors += 1;
        state.counters.boardErrors += 1;
        if (isThrottleError(err)) {
          hub.nextDueAt = t; // bleibt fällig und wird nach dem Backoff erneut versucht
        } else {
          hub.nextDueAt = now() + Math.min(hub.intervalMs, HUB_RETRY_MAX_MS * hub.errors);
          log.warn('Abfahrtstafel konnte nicht geladen werden', { stationId: hub.id, code: err.code ?? null, errors: hub.errors });
        }
        throw err;
      }
    });
  }

  /** Refresh-Aufgaben nach Priorität, höchstens `limit`. */
  function planRefresh(t, limit) {
    const candidates = prioritizeRecords(store.all(), t, { prefetchMs: cfg.prefetchMs, minIntervalMs: cfg.tripRefreshMinMs })
      .filter((r) => !inFlightTrips.has(r.id));
    return candidates.slice(0, Math.max(0, limit)).map((record) => async () => {
      const id = record.id;
      const via = record.discoveredVia;
      const p = fetchTrip(id, { discoveredVia: via }).then((rec) => {
        state.lastRefreshAt = now();
        return rec;
      });
      inFlightTrips.set(id, p);
      try {
        await p;
      } catch (err) {
        if (isThrottleError(err)) throw err;
        handleTripError(id, err);
        if (!(err instanceof AppError)) log.warn('Unerwarteter Fehler beim Laden einer Fahrt', { tripId: shortId(id), err });
      } finally {
        if (inFlightTrips.get(id) === p) inFlightTrips.delete(id);
      }
    });
  }

  /** Prune: beendete Fahrten entfernen, Größe begrenzen (niedrigste Priorität zuerst). */
  function prune(t) {
    let pruned = 0;
    try {
      pruned = store.prune(t, { retainAfterArrivalMs: cfg.retainAfterArrivalMs }) || 0;
    } catch (err) {
      log.warn('Bereinigung des Fahrtenspeichers fehlgeschlagen', { err });
    }
    state.counters.pruned += pruned;
    let evicted = 0;
    const excess = store.size() - cfg.tripMaxTracked;
    if (excess > 0) {
      const order = evictionOrder(store.all(), t, { prefetchMs: cfg.prefetchMs });
      for (let i = 0; i < excess && i < order.length; i += 1) {
        if (inFlightTrips.has(order[i].id)) continue;
        store.remove(order[i].id);
        evicted += 1;
      }
      state.counters.evicted += evicted;
    }
    boardCache.prune();
    if (pruned > 0 || evicted > 0) log.debug('Fahrtenspeicher bereinigt', { pruned, evicted, tracked: store.size() });
  }

  async function runTick() {
    const t = now();
    state.lastTickAt = t;
    state.tickCount += 1;
    try {
      if (state.backoffUntil !== null && t < state.backoffUntil) {
        prune(t);
        return;
      }
      const budget = availableBudget();
      const dueHubs = hubStates.filter((h) => h.nextDueAt <= t).length;
      const refreshDue = prioritizeRecords(store.all(), t, { prefetchMs: cfg.prefetchMs, minIntervalMs: cfg.tripRefreshMinMs }).length;
      // Aufteilung: beide Seiten bekommen mindestens die Hälfte, ungenutzte Anteile wandern zur anderen Seite.
      const refreshReserve = Math.min(refreshDue, Math.floor(budget / 2));
      const discoveryTasks = planDiscovery(t, budget - refreshReserve);
      const refreshTasks = planRefresh(t, budget - discoveryTasks.length * (cfg.hubIncludeArrivals ? 2 : 1));
      const tasks = [...discoveryTasks, ...refreshTasks];
      log.debug('Tick geplant', { budget, dueHubs, refreshDue, discovery: discoveryTasks.length, refresh: refreshTasks.length });
      if (tasks.length > 0) {
        const result = await runLimited(tasks);
        if (result.throttled) {
          state.counters.abortedTicks += 1;
          applyBackoff(result.throttled, now());
        }
      }
      prune(now());
    } catch (err) {
      log.error('Unerwarteter Fehler im Poller-Tick', { err });
    } finally {
      state.lastTickDurationMs = now() - t;
    }
  }

  function schedule(delayMs) {
    if (!state.running) return;
    if (state.timer !== null) clearTimeoutImpl(state.timer);
    const delay = Math.max(1, Math.round(delayMs));
    state.nextTickAt = now() + delay;
    state.timer = setTimeoutImpl(() => {
      state.timer = null;
      poller.tick().finally(() => {
        if (!state.running) return;
        const t = now();
        const wait = state.backoffUntil !== null && state.backoffUntil > t ? Math.min(state.backoffUntil - t, tickMs) : tickMs;
        schedule(wait);
      });
    }, delay);
  }

  const poller = {
    /** Startet den Tick-Zyklus (idempotent). Der erste Tick folgt unmittelbar. */
    start() {
      if (state.running) return;
      state.running = true;
      state.stopRequested = false;
      log.info('Poller gestartet', {
        hubs: hubStates.length, tickMs, perTickBudget, perMinuteBudget, products: cfg.products, hubPollIntervalSec: cfg.hubPollIntervalMs / 1000,
      });
      schedule(1);
    },

    /** Stoppt den Zyklus; ein laufender Tick wird abgewartet. */
    async stop() {
      if (!state.running) return;
      state.running = false;
      state.stopRequested = true;
      if (state.timer !== null) {
        clearTimeoutImpl(state.timer);
        state.timer = null;
      }
      state.nextTickAt = null;
      if (state.tickPromise) {
        try {
          await state.tickPromise;
        } catch {
          // Tick-Fehler werden im Tick selbst protokolliert.
        }
      }
      state.stopRequested = false; // manuelle Ticks (z. B. in Tests) bleiben nach dem Stopp möglich
      log.info('Poller gestoppt', { trackedTrips: store.size() });
    },

    /** Eine Iteration (Discovery + Refresh + Prune). Läuft bereits ein Tick, wird dessen Promise geliefert. */
    tick() {
      if (state.tickPromise) return state.tickPromise;
      const p = runTick().finally(() => {
        if (state.tickPromise === p) state.tickPromise = null;
      });
      state.tickPromise = p;
      return p;
    },

    /** Abfahrtstafel aus dem Cache oder `null`. */
    getBoard(stationId) {
      const id = typeof stationId === 'number' ? String(stationId) : stationId;
      if (typeof id !== 'string' || !STATION_ID_RE.test(id)) return null;
      return boardCache.get(id) ?? null;
    },

    /**
     * Abfahrtstafel (Cache, falls jünger als `maxAgeMs`, sonst frischer Abruf; gleichzeitige Anfragen werden gebündelt).
     * @param {string} stationId
     * @param {{maxAgeMs?: number, includeArrivals?: boolean}} [options]
     */
    requestBoard(stationId, options = {}) {
      const id = typeof stationId === 'number' && Number.isInteger(stationId) ? String(stationId) : stationId;
      if (typeof id !== 'string' || !STATION_ID_RE.test(id)) {
        return Promise.reject(new ValidationError('Ungültige Bahnhofs-ID. Erwartet werden 5 bis 12 Ziffern.', { details: { field: 'stationId' } }));
      }
      const opts = options && typeof options === 'object' ? options : {};
      const maxAge = Math.max(0, finiteOrNull(opts.maxAgeMs) ?? cfg.boardCacheMs);
      const includeArrivals = opts.includeArrivals === true || (opts.includeArrivals !== false && cfg.hubIncludeArrivals);
      const cached = boardCache.get(id);
      if (cached && now() - cached.fetchedAt <= maxAge && (!includeArrivals || Array.isArray(cached.arrivals))) {
        return Promise.resolve(cached);
      }
      const running = inFlightBoards.get(id);
      if (running) return running;
      const p = fetchBoard(id, { includeArrivals }).finally(() => {
        if (inFlightBoards.get(id) === p) inFlightBoards.delete(id);
      });
      inFlightBoards.set(id, p);
      return p;
    },

    /**
     * Fahrt aus dem Speicher (falls jünger als `maxAgeMs`), sonst frischer Abruf.
     * Fehler werden dem Eintrag angerechnet und weitergereicht.
     * @param {string} tripId
     * @param {{maxAgeMs?: number}} [options]
     * @returns {Promise<import('./trip-store.js').TripRecord>}
     */
    refreshTrip(tripId, options = {}) {
      if (!isValidTripId(typeof tripId === 'string' ? tripId.trim() : tripId)) {
        return Promise.reject(new ValidationError('Ungültige Fahrt-ID.', { details: { field: 'tripId' } }));
      }
      const id = tripId.trim();
      const opts = options && typeof options === 'object' ? options : {};
      const maxAge = Math.max(0, finiteOrNull(opts.maxAgeMs) ?? cfg.tripRefreshMinMs);
      const record = store.get(id);
      if (record && record.trip !== null && record.lastFetchedAt !== null && now() - record.lastFetchedAt <= maxAge) {
        return Promise.resolve(record);
      }
      const running = inFlightTrips.get(id);
      if (running) return running;
      const p = fetchTrip(id, { discoveredVia: record ? record.discoveredVia : 'manual' })
        .then((rec) => {
          state.lastRefreshAt = now();
          return rec;
        })
        .catch((err) => {
          if (!isThrottleError(err)) handleTripError(id, err);
          throw err;
        })
        .finally(() => {
          if (inFlightTrips.get(id) === p) inFlightTrips.delete(id);
        });
      inFlightTrips.set(id, p);
      return p;
    },

    stats() {
      const t = now();
      let tracked = 0;
      let active = 0;
      let pending = 0;
      for (const r of store.all()) {
        tracked += 1;
        if (r.trip === null) pending += 1;
        else if (recordPhase(r, t) === 'active') active += 1;
      }
      const avail = clientAvailable();
      const planLeft = Math.max(0, perMinuteBudget - requestsLastMinute());
      return {
        running: state.running,
        trackedTrips: tracked,
        activeTrips: active,
        pendingTrips: pending,
        lastDiscoveryAt: state.lastDiscoveryAt,
        lastRefreshAt: state.lastRefreshAt,
        lastTickAt: state.lastTickAt,
        lastTickDurationMs: state.lastTickDurationMs,
        nextTickAt: state.nextTickAt,
        tickCount: state.tickCount,
        requestsLastMinute: requestsLastMinute(),
        boardsCached: boardCache.size(),
        hubs: { total: hubStates.length, due: hubStates.filter((h) => h.nextDueAt <= t).length, polled: hubStates.filter((h) => h.fetchCount > 0).length },
        backoffMs: state.backoffMs,
        backoffUntil: state.backoffUntil,
        counters: { ...state.counters },
        upstream: { state: upstreamState(), ...state.upstream },
        budget: { rpm: cfg.maxRpm, perTick: perTickBudget, available: avail === null ? planLeft : Math.min(avail, planLeft) },
      };
    },
  };

  return poller;
}
