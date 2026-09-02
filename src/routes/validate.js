/**
 * Strikte Validierung aller Client-Parameter (Whitelist-Prinzip). Jede Funktion wirft
 * `ValidationError` (HTTP 400) bei ungültiger Eingabe.
 */
import { ValidationError } from '../lib/errors.js';

export const PRODUCTS = Object.freeze(['nationalExpress', 'national', 'regionalExpress', 'regional', 'suburban', 'bus', 'ferry', 'subway', 'tram', 'taxi']);
const STATION_ID_RE = /^\d{5,12}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const fail = (message, field) => new ValidationError(message, { details: { field } });

function firstString(v) {
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' ? v : null;
}

/** EVA-Nummer (5–12 Ziffern). */
export function parseStationId(value, field = 'id') {
  const s = firstString(value);
  if (s === null || !STATION_ID_RE.test(s.trim())) throw fail('Ungültige Bahnhofs-ID (5–12 Ziffern erwartet).', field);
  return s.trim().replace(/^0+(?=\d)/, '');
}

/** Fahrt-ID: 5–512 druckbare Zeichen. */
export function parseTripId(value, field = 'tripId') {
  const s = firstString(value);
  if (s === null) throw fail('Fahrt-ID fehlt.', field);
  const t = s.trim();
  if (t.length < 5 || t.length > 512 || CONTROL_RE.test(t)) throw fail('Ungültige Fahrt-ID.', field);
  return t;
}

/** Kommagetrennte Produktliste; leer → `fallback`. */
export function parseProducts(value, fallback = null, field = 'product') {
  const s = firstString(value);
  if (s === null || s.trim() === '') return fallback;
  const list = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (list.length === 0 || list.length > PRODUCTS.length) throw fail('Ungültige Produktliste.', field);
  for (const p of list) if (!PRODUCTS.includes(p)) throw fail(`Unbekanntes Produkt "${p}".`, field);
  return Array.from(new Set(list));
}

/** Bounding-Box "west,süd,ost,nord" in Grad. */
export function parseBbox(value, field = 'bbox') {
  const s = firstString(value);
  if (s === null || s.trim() === '') return null;
  const parts = s.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw fail('bbox muss vier Zahlen enthalten: west,süd,ost,nord.', field);
  const [w, sth, e, n] = parts;
  if (w < -180 || e > 180 || sth < -90 || n > 90 || w >= e || sth >= n) throw fail('bbox außerhalb des gültigen Bereichs.', field);
  return [w, sth, e, n];
}

/** Koordinatenpaar aus Query-Parametern `lat`/`lon`. */
export function parseLatLon(query, latField = 'lat', lonField = 'lon') {
  const latS = firstString(query[latField]);
  const lonS = firstString(query[lonField]);
  const lat = latS === null || latS.trim() === '' ? NaN : Number(latS);
  const lon = lonS === null || lonS.trim() === '' ? NaN : Number(lonS);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw fail('lat muss zwischen -90 und 90 liegen.', latField);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw fail('lon muss zwischen -180 und 180 liegen.', lonField);
  return { lat, lon };
}

/** Boolescher Parameter (true/false/1/0), leer → `def`. */
export function parseBool(value, def = false, field = 'flag') {
  const s = firstString(value);
  if (s === null || s.trim() === '') return def;
  const v = s.trim().toLowerCase();
  if (['true', '1', 'yes', 'ja'].includes(v)) return true;
  if (['false', '0', 'no', 'nein'].includes(v)) return false;
  throw fail(`${field} muss true oder false sein.`, field);
}

/** Freitext (Suche), Länge min..max, ohne Steuerzeichen. */
export function parseQuery(value, min = 2, max = 64, field = 'q') {
  const s = firstString(value);
  if (s === null) throw fail('Suchbegriff fehlt.', field);
  const t = s.trim();
  if (t.length < min || t.length > max || CONTROL_RE.test(t)) throw fail(`Suchbegriff muss ${min}–${max} Zeichen lang sein.`, field);
  return t;
}

/** Kachelkoordinaten z/x/y (y optional mit .png). */
export function parseTileCoord(z, x, y, maxZoom = 22) {
  const zs = String(z);
  const xs = String(x);
  const m = /^(\d{1,8})(?:\.png)?$/.exec(String(y));
  if (!/^\d{1,2}$/.test(zs) || !/^\d{1,8}$/.test(xs) || !m) throw fail('Ungültige Kachelkoordinaten.', 'tile');
  const zi = Number.parseInt(zs, 10);
  const xi = Number.parseInt(xs, 10);
  const yi = Number.parseInt(m[1], 10);
  if (zi < 0 || zi > maxZoom) throw fail(`Zoomstufe muss zwischen 0 und ${maxZoom} liegen.`, 'z');
  const max = 2 ** zi;
  if (xi < 0 || xi >= max) throw fail('x außerhalb des Bereichs.', 'x');
  if (yi < 0 || yi >= max) throw fail('y außerhalb des Bereichs.', 'y');
  return { z: zi, x: xi, y: yi };
}
