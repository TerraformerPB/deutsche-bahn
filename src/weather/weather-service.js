/**
 * Wetterdienst: periodische Aktualisierung für feste Punkte (Landeshauptstädte) über eine
 * Provider-Kette (Bright Sky → Open-Meteo), amtliche Warnungen, Punktabfragen mit Budget und Cache.
 */
import { createBrightSkyProvider } from './brightsky.js';
import { createOpenMeteoProvider } from './open-meteo.js';
import { createTtlCache } from '../lib/ttl-cache.js';
import { createTokenBucket } from '../lib/token-bucket.js';
import { AppError } from '../lib/errors.js';
import { silentLogger } from '../logger.js';

export const STALE_MAX_MS = 3 * 3600e3;
export const POINT_CACHE_TTL_MS = 10 * 60e3;
export const POINT_GRID_DEG = 0.05;

const defaultSetTimeout = (fn, ms) => {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};

function buildProviders(config, httpClient, logger, now) {
  const out = [];
  for (const name of config.providers || []) {
    if (name === 'brightsky') out.push(createBrightSkyProvider({ httpClient, baseUrl: config.brightskyBaseUrl, timeoutMs: config.timeoutMs, logger, now }));
    else if (name === 'open-meteo') out.push(createOpenMeteoProvider({ httpClient, baseUrl: config.openMeteoBaseUrl, timeoutMs: config.timeoutMs }));
  }
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.config `config.weather`
 * @param {object} deps.httpClient
 * @param {object} [deps.logger]
 * @param {() => number} [deps.now]
 * @param {Array<{key:string, stationId?:string, city?:string, state?:string, lat:number, lon:number}>} deps.points
 * @param {Function} [deps.setTimeoutImpl]
 * @param {Function} [deps.clearTimeoutImpl]
 * @param {Array<object>} [deps.providers] Ersatz für die konfigurierte Provider-Kette (Tests)
 */
export function createWeatherService({
  config, httpClient, logger = silentLogger, now = () => Date.now(), points = [],
  setTimeoutImpl = defaultSetTimeout, clearTimeoutImpl = clearTimeout, providers,
}) {
  if (!config || typeof config !== 'object') throw new TypeError('config (config.weather) ist erforderlich');
  const chain = Array.isArray(providers) ? providers : buildProviders(config, httpClient, logger, now);
  const refreshMs = Math.max(60_000, (Number(config.refreshSec) || 600) * 1000);
  const pointBucket = createTokenBucket({ ratePerMin: Math.max(1, Number(config.pointQueriesPerMin) || 30), now });
  const pointCache = createTtlCache({ maxEntries: 500, defaultTtlMs: POINT_CACHE_TTL_MS, now });

  const state = {
    items: points.map((p) => ({ key: p.key, stationId: p.stationId ?? p.key, city: p.city ?? null, state: p.state ?? null, lat: p.lat, lon: p.lon, weather: null, alerts: [] })),
    provider: null,
    attribution: null,
    updatedAt: null,
    alertsUpdatedAt: null,
    lastError: null,
    lastErrorAt: null,
    refreshes: 0,
    failures: 0,
    timer: null,
    running: false,
    inFlight: null,
  };

  function isStale(t) {
    return state.updatedAt !== null && t - state.updatedAt > STALE_MAX_MS;
  }

  async function doRefresh() {
    const t = now();
    let winner = null;
    let results = null;
    let lastErr = null;
    for (const p of chain) {
      try {
        const r = await p.current(state.items.map(({ key, lat, lon }) => ({ key, lat, lon })));
        if (r && r.size > 0) { winner = p; results = r; break; }
        lastErr = new AppError(`Anbieter ${p.name} lieferte keine Werte.`, { statusCode: 502, code: 'UPSTREAM_EMPTY' });
      } catch (err) {
        lastErr = err;
        logger.warn('Wetteranbieter fehlgeschlagen', { provider: p.name, code: err && err.code, message: err && err.message });
      }
    }
    if (!winner) {
      state.failures += 1;
      state.lastError = lastErr ? { code: lastErr.code || 'UPSTREAM_ERROR', message: lastErr.message } : { code: 'NO_PROVIDER', message: 'Kein Wetteranbieter konfiguriert.' };
      state.lastErrorAt = t;
      if (isStale(t)) {
        for (const item of state.items) { item.weather = null; item.alerts = []; }
      }
      return state.items;
    }
    for (const item of state.items) {
      const w = results.get(item.key);
      if (w) item.weather = w;
    }
    state.provider = winner.name;
    state.attribution = winner.attribution || null;
    state.updatedAt = t;
    state.refreshes += 1;
    state.lastError = null;

    if (config.alerts && typeof winner.alerts === 'function') {
      try {
        const alerts = await winner.alerts(state.items.map(({ key, lat, lon }) => ({ key, lat, lon })));
        for (const item of state.items) item.alerts = alerts.get(item.key) || [];
        state.alertsUpdatedAt = now();
      } catch (err) {
        logger.warn('Wetterwarnungen konnten nicht geladen werden', { provider: winner.name, code: err && err.code, message: err && err.message });
      }
    }
    logger.info('Wetter aktualisiert', { provider: winner.name, points: state.items.length, withData: state.items.filter((i) => i.weather).length });
    return state.items;
  }

  function refresh() {
    if (state.inFlight) return state.inFlight;
    const p = doRefresh().finally(() => { if (state.inFlight === p) state.inFlight = null; });
    state.inFlight = p;
    return p;
  }

  function schedule(ms) {
    if (!state.running) return;
    state.timer = setTimeoutImpl(async () => {
      state.timer = null;
      try { await refresh(); } catch (err) { logger.error('Wetteraktualisierung fehlgeschlagen', { err }); }
      schedule(refreshMs);
    }, ms);
  }

  function gridKey(lat, lon) {
    const g = POINT_GRID_DEG;
    return `${(Math.round(lat / g) * g).toFixed(2)},${(Math.round(lon / g) * g).toFixed(2)}`;
  }

  return {
    start() {
      if (state.running) return;
      state.running = true;
      schedule(0);
    },
    stop() {
      state.running = false;
      if (state.timer !== null) { clearTimeoutImpl(state.timer); state.timer = null; }
    },
    refresh,
    current() {
      const t = now();
      return {
        updatedAt: state.updatedAt,
        alertsUpdatedAt: state.alertsUpdatedAt,
        provider: state.provider,
        attribution: state.attribution,
        stale: isStale(t),
        items: state.items.map((i) => ({ ...i, alerts: [...i.alerts] })),
      };
    },
    /** Wetter an einer beliebigen Koordinate (budgetiert, gerastert gecacht). */
    async pointWeather(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const key = gridKey(lat, lon);
      const cached = pointCache.get(key);
      if (cached !== undefined) return cached;
      if (!pointBucket.tryTake(1)) {
        throw new AppError('Das Kontingent für Wetter-Punktabfragen ist vorübergehend erschöpft.', { statusCode: 429, code: 'RATE_LIMITED' });
      }
      let lastErr = null;
      for (const p of chain) {
        try {
          const r = await p.current([{ key, lat, lon }]);
          const w = r.get(key) || null;
          pointCache.set(key, w);
          return w;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;
      return null;
    },
    stats() {
      return {
        enabled: chain.length > 0,
        providers: chain.map((p) => p.name),
        provider: state.provider,
        updatedAt: state.updatedAt,
        alertsUpdatedAt: state.alertsUpdatedAt,
        stale: isStale(now()),
        refreshes: state.refreshes,
        failures: state.failures,
        lastError: state.lastError,
        lastErrorAt: state.lastErrorAt,
        pointCache: pointCache.stats(),
        pointBudget: pointBucket.stats(),
      };
    },
  };
}
