/**
 * Verdrahtung aller Dienste (Dependency Injection). Erzeugt HTTP-Client, Budget, Circuit-Breaker,
 * Upstream-Adapter, Fahrtenspeicher, Störungsaggregation, Poller, Korridor-Index und Wetterdienst.
 */
import { createHttpClient } from './lib/http-client.js';
import { createTokenBucket } from './lib/token-bucket.js';
import { createCircuitBreaker } from './lib/circuit-breaker.js';
import { createTransportClient } from './transport/transport-rest-client.js';
import { createTripStore } from './transport/trip-store.js';
import { createDisruptionAggregator } from './transport/disruptions.js';
import { createPoller } from './transport/poller.js';
import { createGeometryCache } from './transport/position.js';
import { createCorridorIndex } from './data/corridors.js';
import { hubs } from './data/hubs.js';
import { capitals } from './data/capitals.js';
import { silentLogger } from './logger.js';

let createWeatherService = null;
let weatherImportError = null;
try {
  ({ createWeatherService } = await import('./weather/weather-service.js'));
} catch (err) {
  weatherImportError = err;
}

/** Platzhalter, wenn das Wetter deaktiviert ist. */
export function createNullWeatherService() {
  const empty = () => ({ updatedAt: null, provider: null, attribution: null, items: [], alertsUpdatedAt: null });
  return {
    start() {},
    stop() {},
    async refresh() { return empty(); },
    current: empty,
    async pointWeather() { return null; },
    stats: () => ({ enabled: false }),
  };
}

/**
 * @param {{config:object, logger?:object, now?:() => number, fetchImpl?:typeof fetch}} deps
 */
export function createServices({ config, logger = silentLogger, now = () => Date.now(), fetchImpl }) {
  const child = (mod) => (logger.child ? logger.child({ mod }) : logger);

  const httpClient = createHttpClient({
    allowedOrigins: config.security.allowedUpstreamOrigins,
    userAgent: config.transport.userAgent,
    timeoutMs: config.transport.timeoutMs,
    maxResponseBytes: config.transport.maxResponseBytes,
    fetchImpl,
    logger: child('http-client'),
    now,
  });
  const tokenBucket = createTokenBucket({
    ratePerMin: config.transport.maxRpm,
    burst: Math.max(4, Math.ceil(config.transport.maxRpm / 5)),
    now,
  });
  const breaker = createCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: config.transport.circuitBreakerCooldownSec * 1000,
    now,
    onStateChange: (from, to) => child('breaker').warn('Circuit-Breaker wechselt Zustand', { from, to }),
  });
  const client = createTransportClient({ config: config.transport, httpClient, tokenBucket, breaker, logger: child('transport'), now });
  const store = createTripStore({ now });
  const disruptions = createDisruptionAggregator({ now, logger: child('disruptions') });
  const poller = createPoller({ config: config.transport, client, store, disruptions, hubs, logger: child('poller'), now });
  const corridors = createCorridorIndex();
  const geometryCache = createGeometryCache();

  let weather;
  if (!config.weather.enabled) {
    weather = createNullWeatherService();
  } else if (createWeatherService) {
    weather = createWeatherService({
      config: config.weather,
      httpClient,
      logger: child('weather'),
      now,
      points: capitals.map((c) => ({ key: c.stationId, stationId: c.stationId, city: c.city, state: c.state, lat: c.lat, lon: c.lon })),
    });
  } else {
    child('weather').warn('Wettermodul nicht verfügbar – Wetter deaktiviert', { err: weatherImportError });
    weather = createNullWeatherService();
  }

  let started = false;
  return {
    httpClient, tokenBucket, breaker, client, store, disruptions, poller, corridors, geometryCache, weather,
    async start() {
      if (started) return;
      started = true;
      poller.start();
      try {
        weather.start();
      } catch (err) {
        child('weather').error('Wetterdienst konnte nicht gestartet werden', { err });
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      try { weather.stop(); } catch { /* ignorieren */ }
      await poller.stop();
      if (typeof tokenBucket.close === 'function') tokenBucket.close();
    },
  };
}
