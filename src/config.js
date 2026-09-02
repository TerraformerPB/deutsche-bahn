/**
 * Zentrale Konfiguration – ausschließlich über Umgebungsvariablen.
 *
 * Alle Werte werden validiert und mit sicheren Standardwerten belegt.
 * Es werden keine Geheimnisse benötigt (alle genutzten Datenquellen sind
 * öffentlich und ohne API-Schlüssel nutzbar).
 *
 * Verwendung:
 *   import { loadConfig } from './config.js';
 *   const config = loadConfig(process.env);
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const has = (env, key) => typeof env[key] === 'string' && env[key].trim() !== '';

function str(env, key, def) {
  return has(env, key) ? env[key].trim() : def;
}

function bool(env, key, def) {
  if (!has(env, key)) return def;
  const v = env[key].trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'ja'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'nein'].includes(v)) return false;
  throw new ConfigError(`${key} muss true/false sein, ist aber "${env[key]}"`);
}

function int(env, key, def, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!has(env, key)) return def;
  const n = Number.parseInt(env[key].trim(), 10);
  if (!Number.isInteger(n)) throw new ConfigError(`${key} muss eine ganze Zahl sein, ist aber "${env[key]}"`);
  if (n < min || n > max) throw new ConfigError(`${key} muss zwischen ${min} und ${max} liegen, ist aber ${n}`);
  return n;
}

function num(env, key, def, { min = -Infinity, max = Infinity } = {}) {
  if (!has(env, key)) return def;
  const n = Number(env[key].trim());
  if (!Number.isFinite(n)) throw new ConfigError(`${key} muss eine Zahl sein, ist aber "${env[key]}"`);
  if (n < min || n > max) throw new ConfigError(`${key} muss zwischen ${min} und ${max} liegen, ist aber ${n}`);
  return n;
}

function list(env, key, def) {
  if (!has(env, key)) return def;
  return env[key].split(',').map((s) => s.trim()).filter(Boolean);
}

function oneOf(env, key, def, allowed) {
  const v = str(env, key, def);
  if (!allowed.includes(v)) throw new ConfigError(`${key} muss eines von ${allowed.join(', ')} sein, ist aber "${v}"`);
  return v;
}

/** Validiert eine absolute http(s)-URL und gibt sie normalisiert (ohne Slash am Ende) zurück. */
function httpUrl(env, key, def, { allowHttp = true } = {}) {
  const v = str(env, key, def);
  if (v === null || v === undefined || v === '') return v;
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`${key} ist keine gültige URL: "${v}"`);
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    throw new ConfigError(`${key} muss eine http(s)-URL sein: "${v}"`);
  }
  if (u.username || u.password) throw new ConfigError(`${key} darf keine Zugangsdaten enthalten`);
  return u.toString().replace(/\/+$/, '');
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Konfiguration für den Proxy-Vertrauensmodus von Express ("trust proxy"). */
function trustProxy(env) {
  const v = str(env, 'TRUST_PROXY', 'false');
  const l = v.toLowerCase();
  if (/^\d+$/.test(l)) return Number.parseInt(l, 10); // Anzahl vertrauenswürdiger Proxy-Hops
  if (['false', 'no', 'off'].includes(l)) return false;
  if (['true', 'yes', 'on'].includes(l)) return true;
  // z. B. "loopback", "loopback, 10.0.0.0/8"
  return v;
}

const VALID_PRODUCTS = ['nationalExpress', 'national', 'regionalExpress', 'regional', 'suburban', 'bus', 'ferry', 'subway', 'tram', 'taxi'];
const VALID_WEATHER = ['brightsky', 'open-meteo'];

/**
 * Baut die vollständige, eingefrorene Konfiguration aus `env`.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const nodeEnv = oneOf(env, 'NODE_ENV', 'production', ['production', 'development', 'test']);
  const demo = bool(env, 'DEMO_MODE', false);

  const map = {
    mode: oneOf(env, 'MAP_MODE', 'vector', ['vector', 'raster']),
    styleUrl: httpUrl(env, 'MAP_STYLE_URL', 'https://maps.paulbartsch.de/style/style.json'),
    /** Zusätzliche Origins, von denen die Karte Daten laden darf (Glyphen, Kacheln), falls abweichend. */
    extraOrigins: list(env, 'MAP_EXTRA_ORIGINS', []),
    /** Nur MAP_MODE=raster: Vorlage für den serverseitigen Kachel-Proxy (Zugriff ist auf den Server beschränkt). */
    rasterUrlTemplate: str(env, 'MAP_RASTER_URL_TEMPLATE', 'http://127.0.0.1:8080/raster/{z}/{x}/{y}.png'),
    rasterMaxZoom: int(env, 'MAP_RASTER_MAX_ZOOM', 14, { min: 1, max: 22 }),
    rasterCacheEntries: int(env, 'MAP_RASTER_CACHE_ENTRIES', 2000, { min: 0, max: 100000 }),
    rasterCacheTtlSec: int(env, 'MAP_RASTER_CACHE_TTL_SEC', 86400, { min: 0, max: 30 * 86400 }),
    /** Zusätzlicher Quellenhinweis, der in der Kartenattribution angezeigt wird. */
    attribution: str(env, 'MAP_ATTRIBUTION', '© OpenStreetMap-Mitwirkende'),
    center: [num(env, 'MAP_CENTER_LON', 10.45, { min: -180, max: 180 }), num(env, 'MAP_CENTER_LAT', 51.16, { min: -90, max: 90 })],
    zoom: num(env, 'MAP_ZOOM', 5.6, { min: 0, max: 22 }),
  };
  for (const o of map.extraOrigins) {
    if (!originOf(o) || originOf(o) !== o) throw new ConfigError(`MAP_EXTRA_ORIGINS enthält keinen gültigen Origin: "${o}"`);
  }
  /** Alle Origins, die die Browser-CSP für Kartenressourcen freigibt. */
  map.origins = Array.from(new Set([originOf(map.styleUrl), ...map.extraOrigins].filter(Boolean)));
  if (!/\{z\}.*\{x\}.*\{y\}/.test(map.rasterUrlTemplate)) throw new ConfigError('MAP_RASTER_URL_TEMPLATE muss {z}, {x} und {y} enthalten');
  map.rasterOrigin = originOf(map.rasterUrlTemplate.replace(/\{[zxy]\}/g, '0'));
  if (!map.rasterOrigin) throw new ConfigError('MAP_RASTER_URL_TEMPLATE ist keine gültige URL');

  const products = list(env, 'TRACK_PRODUCTS', ['nationalExpress']);
  for (const p of products) {
    if (!VALID_PRODUCTS.includes(p)) throw new ConfigError(`TRACK_PRODUCTS enthält unbekanntes Produkt "${p}" (erlaubt: ${VALID_PRODUCTS.join(', ')})`);
  }

  const transport = {
    baseUrl: httpUrl(env, 'TRANSPORT_API_BASE_URL', 'https://v6.db.transport.rest'),
    /** db-vendo-client-Profil (dbnav|db|dbweb) oder leer für den Server-Standard. */
    profile: oneOf(env, 'TRANSPORT_PROFILE', '', ['', 'dbnav', 'db', 'dbweb']),
    userAgent: str(env, 'USER_AGENT', `${pkg.name}/${pkg.version} (+https://github.com/terraformerpb/deutsche-bahn)`),
    maxRpm: int(env, 'UPSTREAM_MAX_RPM', 40, { min: 1, max: 1000 }),
    concurrency: int(env, 'UPSTREAM_CONCURRENCY', 2, { min: 1, max: 16 }),
    timeoutMs: int(env, 'UPSTREAM_TIMEOUT_MS', 12000, { min: 1000, max: 120000 }),
    maxResponseBytes: int(env, 'UPSTREAM_MAX_RESPONSE_BYTES', 5 * 1024 * 1024, { min: 1024, max: 64 * 1024 * 1024 }),
    products,
    language: 'de',
    hubPollIntervalSec: int(env, 'HUB_POLL_INTERVAL_SEC', 600, { min: 30, max: 86400 }),
    hubBoardDurationMin: int(env, 'HUB_BOARD_DURATION_MIN', 60, { min: 5, max: 720 }),
    hubIncludeArrivals: bool(env, 'HUB_INCLUDE_ARRIVALS', false),
    hubTier2Factor: int(env, 'HUB_TIER2_FACTOR', 2, { min: 1, max: 20 }),
    tripRefreshMinSec: int(env, 'TRIP_REFRESH_MIN_SEC', 180, { min: 30, max: 3600 }),
    tripMaxTracked: int(env, 'TRIP_MAX_TRACKED', 400, { min: 10, max: 5000 }),
    tripPrefetchBeforeDepartureMin: int(env, 'TRIP_PREFETCH_BEFORE_DEPARTURE_MIN', 20, { min: 0, max: 240 }),
    tripRetainAfterArrivalMin: int(env, 'TRIP_RETAIN_AFTER_ARRIVAL_MIN', 10, { min: 0, max: 240 }),
    boardCacheSec: int(env, 'BOARD_CACHE_SEC', 60, { min: 5, max: 3600 }),
    circuitBreakerCooldownSec: int(env, 'UPSTREAM_CIRCUIT_COOLDOWN_SEC', 60, { min: 5, max: 3600 }),
  };

  const weatherProviders = list(env, 'WEATHER_PROVIDERS', ['brightsky', 'open-meteo']).filter((p) => p !== 'none');
  for (const p of weatherProviders) {
    if (!VALID_WEATHER.includes(p)) throw new ConfigError(`WEATHER_PROVIDERS enthält unbekannten Anbieter "${p}" (erlaubt: ${VALID_WEATHER.join(', ')}, none)`);
  }
  const weather = {
    enabled: weatherProviders.length > 0,
    providers: weatherProviders,
    brightskyBaseUrl: httpUrl(env, 'BRIGHTSKY_BASE_URL', 'https://api.brightsky.dev'),
    openMeteoBaseUrl: httpUrl(env, 'OPEN_METEO_BASE_URL', 'https://api.open-meteo.com'),
    refreshSec: int(env, 'WEATHER_REFRESH_SEC', 600, { min: 60, max: 86400 }),
    alerts: bool(env, 'WEATHER_ALERTS', true),
    timeoutMs: int(env, 'WEATHER_TIMEOUT_MS', 10000, { min: 1000, max: 60000 }),
    /** Anfragen für "Wetter am Zug" (Punktabfragen) pro Minute, serverweit. */
    pointQueriesPerMin: int(env, 'WEATHER_POINT_QUERIES_PER_MIN', 30, { min: 0, max: 600 }),
  };

  const security = {
    rateLimitPerMin: int(env, 'RATE_LIMIT_PER_MIN', 120, { min: 1, max: 100000 }),
    /** Serverweites Kontingent für Upstream-Abrufe, die direkt durch Client-Anfragen ausgelöst werden (Abfahrtstafeln, Detail-Aktualisierung). */
    clientUpstreamPerMin: int(env, 'CLIENT_UPSTREAM_PER_MIN', 12, { min: 1, max: 1000 }),
    /** Hosts, die der HTTP-Client kontaktieren darf (SSRF-Schutz). Wird aus den Basis-URLs abgeleitet. */
    allowedUpstreamOrigins: Array.from(new Set([
      originOf(transport.baseUrl),
      originOf(weather.brightskyBaseUrl),
      originOf(weather.openMeteoBaseUrl),
      map.mode === 'raster' ? map.rasterOrigin : null,
    ].filter(Boolean))),
    hstsEnabled: bool(env, 'HSTS_ENABLED', false),
  };

  const config = {
    app: { name: pkg.name, version: pkg.version, description: pkg.description },
    env: nodeEnv,
    demo,
    server: {
      port: int(env, 'PORT', 3000, { min: 1, max: 65535 }),
      host: str(env, 'HOST', '0.0.0.0'),
      trustProxy: trustProxy(env),
      publicBaseUrl: httpUrl(env, 'PUBLIC_BASE_URL', ''),
      shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_MS', 10000, { min: 0, max: 120000 }),
    },
    log: {
      level: oneOf(env, 'LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error', 'silent']),
      format: oneOf(env, 'LOG_FORMAT', 'json', ['json', 'pretty']),
    },
    map,
    transport,
    weather,
    security,
  };
  return deepFreeze(config);
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

/**
 * Öffentlich sichtbarer Teil der Konfiguration (für GET /api/config).
 * Enthält bewusst keine internen URLs außer der Kartenquelle.
 */
export function publicConfig(config) {
  return {
    app: { name: config.app.name, version: config.app.version },
    demo: config.demo,
    map: {
      mode: config.map.mode,
      styleUrl: config.map.mode === 'vector' ? config.map.styleUrl : null,
      attribution: config.map.attribution,
      center: config.map.center,
      zoom: config.map.zoom,
      rasterMaxZoom: config.map.rasterMaxZoom,
    },
    transport: {
      products: config.transport.products,
      hubPollIntervalSec: config.transport.hubPollIntervalSec,
      tripRefreshMinSec: config.transport.tripRefreshMinSec,
    },
    weather: { enabled: config.weather.enabled, alerts: config.weather.alerts, refreshSec: config.weather.refreshSec },
  };
}
