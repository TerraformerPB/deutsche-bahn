/**
 * Stationsverzeichnis (EVA-Nummern, Namen, Koordinaten) auf Basis von
 * `db-stations` (DB Station Data / StaDa, Open Data, CC BY 4.0).
 *
 * Dient zur Auflösung von Bahnhofsnamen (auch in HAFAS-Schreibweise wie
 * "Frankfurt(Main)Hbf") auf EVA-Nummern und Koordinaten sowie für die Suche.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(__dirname, 'db-stations.json'), 'utf8'));

/** @typedef {{id:string,name:string,ril100:string|null,lat:number,lon:number,cat:number|null,state:string|null,w:number|null}} Station */

/** @type {Station[]} */
export const stations = raw.stations;
export const stationsMeta = raw._meta;

/** Normalisiert Bahnhofsnamen für Vergleiche (Umlaute, Klammern, Leerzeichen, Hbf/Hauptbahnhof). */
export function normalizeStationName(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/hauptbahnhof/g, 'hbf')
    .replace(/[^a-z0-9]/g, '');
}

const byId = new Map();
const byNorm = new Map();
for (const s of stations) {
  byId.set(s.id, s);
  const k = normalizeStationName(s.name);
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k).push(s);
}
const sorted = [...stations].sort((a, b) => (b.w || 0) - (a.w || 0));

export const stationsById = byId;

/** EVA-Nummer (IBNR) plausibel? */
export function isStationId(id) {
  return typeof id === 'string' && /^\d{6,9}$/.test(id);
}

function bestOf(list) {
  if (!list || list.length === 0) return null;
  return list.reduce((a, b) => ((b.w || 0) > (a.w || 0) ? b : a));
}

/**
 * Findet eine Station per EVA-Nummer oder Name (tolerant gegenüber Schreibweisen).
 * @param {string} nameOrId
 * @returns {Station|null}
 */
export function findStation(nameOrId) {
  if (typeof nameOrId !== 'string' || nameOrId.trim() === '') return null;
  const q = nameOrId.trim();
  if (byId.has(q)) return byId.get(q);
  if (/^\d+$/.test(q)) return byId.get(q.replace(/^0+/, '')) || null;
  const k = normalizeStationName(q);
  if (!k) return null;
  const exact = byNorm.get(k);
  if (exact) return bestOf(exact);
  // Varianten: "Pbf"/"Hbf"/"Bahnhof"-Suffixe
  for (const suffix of ['pbf', 'hbf', 'bahnhof', 'bf']) {
    if (byNorm.has(k + suffix)) return bestOf(byNorm.get(k + suffix));
    if (k.endsWith(suffix) && byNorm.has(k.slice(0, -suffix.length))) return bestOf(byNorm.get(k.slice(0, -suffix.length)));
  }
  return null;
}

/**
 * Suche nach Stationsnamen (Präfix, dann Teilstring), sortiert nach Bedeutung.
 * @param {string} query
 * @param {number} [limit]
 * @returns {Station[]}
 */
export function searchStations(query, limit = 10) {
  const k = normalizeStationName(query);
  if (!k || k.length < 2) return [];
  const prefix = [];
  const contains = [];
  for (const s of sorted) {
    const n = normalizeStationName(s.name);
    if (n.startsWith(k)) prefix.push(s);
    else if (n.includes(k)) contains.push(s);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...contains].slice(0, limit);
}

/** FPTF-ähnliche Repräsentation. */
export function stationToLocation(s) {
  if (!s) return null;
  return { type: 'station', id: s.id, name: s.name, location: { type: 'location', latitude: s.lat, longitude: s.lon } };
}
