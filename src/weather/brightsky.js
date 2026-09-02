/**
 * Wetteranbieter Bright Sky (JSON-API über DWD-Open-Data). Ein Request je Punkt
 * (`/current_weather`) sowie amtliche Warnungen (`/alerts`).
 * Quellenvermerk: „Datenbasis: Deutscher Wetterdienst (DWD), bereitgestellt über Bright Sky“.
 */
import { normalizeIcon, iconLabelDe } from './icons.js';
import { UpstreamError, UpstreamFormatError } from '../lib/errors.js';
import { silentLogger } from '../logger.js';

export const BRIGHTSKY_ATTRIBUTION = 'Datenbasis: Deutscher Wetterdienst (DWD), bereitgestellt über Bright Sky';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 500) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);

/** Normalisiert die Antwort von `/current_weather`. */
export function normalizeBrightSkyCurrent(data) {
  if (!data || typeof data !== 'object' || !data.weather || typeof data.weather !== 'object') {
    throw new UpstreamFormatError('Bright Sky lieferte keine Wetterdaten.', { details: { reason: 'weather fehlt' } });
  }
  const w = data.weather;
  const source = Array.isArray(data.sources) && data.sources[0] && typeof data.sources[0] === 'object' ? data.sources[0] : null;
  const icon = normalizeIcon(str(w.icon, 40));
  return {
    timestamp: str(w.timestamp, 40),
    temperature: num(w.temperature),
    condition: str(w.condition, 40),
    icon,
    iconLabel: icon ? iconLabelDe(icon) : null,
    windSpeedKmh: num(w.wind_speed_10),
    windGustKmh: num(w.wind_gust_speed_10),
    windDirection: num(w.wind_direction_10),
    precipitationMm: num(w.precipitation_60) ?? num(w.precipitation_10),
    humidity: num(w.relative_humidity),
    pressureHpa: num(w.pressure_msl),
    visibilityM: num(w.visibility),
    cloudCover: num(w.cloud_cover),
    source: { name: 'DWD', stationName: source ? str(source.station_name, 120) : null, distanceM: source ? num(source.distance) : null },
    provider: 'brightsky',
  };
}

const SEVERITIES = ['minor', 'moderate', 'severe', 'extreme'];

/** Normalisiert die Antwort von `/alerts`; abgelaufene Warnungen werden entfernt. */
export function normalizeBrightSkyAlerts(data, nowMs = Date.now()) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.alerts)) {
    throw new UpstreamFormatError('Bright Sky lieferte keine Warnungen.', { details: { reason: 'alerts fehlt' } });
  }
  const region = data.location && typeof data.location === 'object' ? str(data.location.name, 120) : null;
  const out = [];
  for (const a of data.alerts) {
    if (!a || typeof a !== 'object') continue;
    const expires = str(a.expires, 40);
    if (expires) {
      const t = Date.parse(expires);
      if (Number.isFinite(t) && t < nowMs) continue;
    }
    const severity = SEVERITIES.includes(a.severity) ? a.severity : 'moderate';
    out.push({
      id: str(String(a.id ?? a.alert_id ?? ''), 120) || `${severity}-${expires || ''}`,
      severity,
      urgency: str(a.urgency, 40),
      event: str(a.event_de, 200) || str(a.event_en, 200),
      headline: str(a.headline_de, 300) || str(a.headline_en, 300),
      description: str(a.description_de, 2000) || str(a.description_en, 2000),
      instruction: str(a.instruction_de, 1000) || str(a.instruction_en, 1000),
      onset: str(a.onset, 40),
      expires,
      regionName: region,
    });
  }
  return out;
}

/**
 * @param {{httpClient:object, baseUrl:string, timeoutMs?:number, concurrency?:number, logger?:object, now?:() => number}} deps
 */
export function createBrightSkyProvider({ httpClient, baseUrl, timeoutMs = 10000, concurrency = 2, logger = silentLogger, now = () => Date.now() }) {
  if (!httpClient || typeof httpClient.getJson !== 'function') throw new TypeError('httpClient mit getJson() ist erforderlich');
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const limit = Math.max(1, Math.min(8, Number(concurrency) || 2));

  async function mapLimited(points, fn) {
    const results = new Map();
    let failures = 0;
    let lastError = null;
    const queue = [...points];
    async function worker() {
      while (queue.length) {
        const p = queue.shift();
        try {
          const value = await fn(p);
          if (value !== null && value !== undefined) results.set(p.key, value);
        } catch (err) {
          failures += 1;
          lastError = err;
          logger.warn('Bright Sky: Punktabfrage fehlgeschlagen', { key: p.key, code: err && err.code, message: err && err.message });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, points.length) }, worker));
    if (points.length > 0 && results.size === 0) {
      throw lastError instanceof Error ? lastError : new UpstreamError('Bright Sky: alle Punktabfragen fehlgeschlagen.', { retryable: true, code: 'UPSTREAM_ERROR' });
    }
    return { results, failures };
  }

  const url = (path, p) => `${base}${path}?lat=${encodeURIComponent(p.lat.toFixed(4))}&lon=${encodeURIComponent(p.lon.toFixed(4))}`;

  return {
    name: 'brightsky',
    attribution: BRIGHTSKY_ATTRIBUTION,
    /** @param {Array<{key:string, lat:number, lon:number}>} points */
    async current(points) {
      const { results } = await mapLimited(points, async (p) => {
        const r = await httpClient.getJson(url('/current_weather', p), { timeoutMs });
        return normalizeBrightSkyCurrent(r.data);
      });
      return results;
    },
    /** @param {Array<{key:string, lat:number, lon:number}>} points */
    async alerts(points) {
      const { results } = await mapLimited(points, async (p) => {
        const r = await httpClient.getJson(url('/alerts', p), { timeoutMs });
        return normalizeBrightSkyAlerts(r.data, now());
      });
      return results;
    },
  };
}
