/**
 * Wetteranbieter Open-Meteo (Fallback). Ein gebündelter Request für alle Punkte.
 * Quellenvermerk: „Wetterdaten: Open-Meteo.com (CC BY 4.0)“. Keine amtlichen Warnungen.
 */
import { wmoCodeToIcon, wmoCodeToCondition, iconLabelDe } from './icons.js';
import { UpstreamFormatError } from '../lib/errors.js';

export const OPEN_METEO_ATTRIBUTION = 'Wetterdaten: Open-Meteo.com (CC BY 4.0)';
const CURRENT_FIELDS = 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normalisiert einen Einzelstandort der Open-Meteo-Antwort. */
export function normalizeOpenMeteoItem(item) {
  if (!item || typeof item !== 'object' || !item.current || typeof item.current !== 'object') {
    throw new UpstreamFormatError('Open-Meteo lieferte keine aktuellen Werte.', { details: { reason: 'current fehlt' } });
  }
  const c = item.current;
  const isDay = c.is_day === undefined || c.is_day === null ? true : Number(c.is_day) === 1;
  const icon = wmoCodeToIcon(c.weather_code, isDay);
  return {
    timestamp: typeof c.time === 'string' ? c.time : null,
    temperature: num(c.temperature_2m),
    condition: wmoCodeToCondition(c.weather_code),
    icon,
    iconLabel: iconLabelDe(icon),
    windSpeedKmh: num(c.wind_speed_10m),
    windGustKmh: num(c.wind_gusts_10m),
    windDirection: num(c.wind_direction_10m),
    precipitationMm: num(c.precipitation),
    humidity: num(c.relative_humidity_2m),
    pressureHpa: null,
    visibilityM: null,
    cloudCover: null,
    source: { name: 'Open-Meteo', stationName: null, distanceM: null },
    provider: 'open-meteo',
  };
}

/**
 * @param {{httpClient:object, baseUrl:string, timeoutMs?:number}} deps
 */
export function createOpenMeteoProvider({ httpClient, baseUrl, timeoutMs = 10000 }) {
  if (!httpClient || typeof httpClient.getJson !== 'function') throw new TypeError('httpClient mit getJson() ist erforderlich');
  const base = String(baseUrl || '').replace(/\/+$/, '');

  return {
    name: 'open-meteo',
    attribution: OPEN_METEO_ATTRIBUTION,
    /** @param {Array<{key:string, lat:number, lon:number}>} points */
    async current(points) {
      const results = new Map();
      if (!points.length) return results;
      const lats = points.map((p) => p.lat.toFixed(4)).join(',');
      const lons = points.map((p) => p.lon.toFixed(4)).join(',');
      const url = `${base}/v1/forecast?latitude=${lats}&longitude=${lons}&current=${CURRENT_FIELDS}&wind_speed_unit=kmh&timezone=Europe%2FBerlin`;
      const r = await httpClient.getJson(url, { timeoutMs });
      const items = Array.isArray(r.data) ? r.data : [r.data];
      if (items.length !== points.length) {
        throw new UpstreamFormatError('Open-Meteo lieferte eine unerwartete Anzahl von Standorten.', { details: { expected: points.length, received: items.length } });
      }
      items.forEach((item, i) => {
        results.set(points[i].key, normalizeOpenMeteoItem(item));
      });
      return results;
    },
  };
}
