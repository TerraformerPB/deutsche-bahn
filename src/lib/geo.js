/**
 * Geodätische Hilfsfunktionen. Koordinaten sind durchgängig GeoJSON-Reihenfolge:
 * `[lon, lat]` in Grad. Distanzen in Metern, Richtungen in Grad (0 = Nord, 90 = Ost).
 */
export const EARTH_RADIUS_M = 6371008.8;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function isLonLat(p) {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
    && p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;
}

/** Großkreisdistanz (Haversine) in Metern. */
export function haversineM(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Anfangs-Kurswinkel von a nach b in Grad [0, 360). */
export function bearingDeg(a, b) {
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  const brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

/** Lineare Interpolation zwischen zwei Punkten (für kurze Segmente ausreichend genau). */
export function interpolatePoint(a, b, f) {
  const t = Math.min(1, Math.max(0, f));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Kumulierte Streckenlängen entlang einer Koordinatenfolge (erstes Element 0). */
export function cumulativeLengths(coords) {
  const cum = new Array(coords.length);
  let acc = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) acc += haversineM(coords[i - 1], coords[i]);
    cum[i] = acc;
  }
  return cum;
}

export function lineLengthM(coords) {
  if (!coords || coords.length < 2) return 0;
  return cumulativeLengths(coords)[coords.length - 1];
}

/**
 * Punkt in gegebenem Abstand (Meter) entlang der Linie.
 * @returns {{point:[number,number], bearing:number, index:number}} index = Index des Segmentanfangs
 */
export function pointAtDistance(coords, distanceM, cum = cumulativeLengths(coords)) {
  if (!coords || coords.length === 0) return null;
  if (coords.length === 1) return { point: [...coords[0]], bearing: 0, index: 0 };
  const total = cum[cum.length - 1];
  const d = Math.min(Math.max(0, distanceM), total);
  // binäre Suche nach dem Segment
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const segLen = cum[hi] - cum[lo];
  const f = segLen > 0 ? (d - cum[lo]) / segLen : 0;
  const point = interpolatePoint(coords[lo], coords[hi], f);
  // Kurs: nächstes nicht-degeneriertes Segment
  let bearing = 0;
  for (let i = lo; i < coords.length - 1; i++) {
    if (haversineM(coords[i], coords[i + 1]) > 0.5) {
      bearing = bearingDeg(coords[i], coords[i + 1]);
      break;
    }
  }
  return { point, bearing, index: lo };
}

/** Punkt bei Anteil `fraction` ∈ [0,1] der Gesamtlänge. */
export function pointAlongLine(coords, fraction, cum = cumulativeLengths(coords)) {
  const total = cum.length ? cum[cum.length - 1] : 0;
  return pointAtDistance(coords, total * Math.min(1, Math.max(0, fraction)), cum);
}

/** Index des Stützpunkts mit minimalem Abstand zu `target`, Suche ab `fromIndex`. */
export function nearestVertexIndex(coords, target, fromIndex = 0) {
  let best = -1;
  let bestD = Infinity;
  for (let i = Math.max(0, fromIndex); i < coords.length; i++) {
    const d = haversineM(coords[i], target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Abstand Punkt–Segment (äquirektangulare Näherung, ausreichend für < 100 km). */
export function distancePointToSegmentM(p, a, b) {
  const cosLat = Math.cos(toRad(p[1]));
  const ax = a[0] * cosLat;
  const ay = a[1];
  const bx = b[0] * cosLat;
  const by = b[1];
  const px = p[0] * cosLat;
  const py = p[1];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  const proj = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { distanceM: haversineM(p, proj), t, point: proj };
}

/**
 * Nächster Punkt auf der Linie zu `p`.
 * @returns {{index:number, t:number, point:[number,number], distanceM:number, alongM:number}|null}
 */
export function nearestPointOnLine(coords, p, cum = cumulativeLengths(coords)) {
  if (!coords || coords.length === 0) return null;
  if (coords.length === 1) return { index: 0, t: 0, point: [...coords[0]], distanceM: haversineM(coords[0], p), alongM: 0 };
  let best = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const r = distancePointToSegmentM(p, coords[i], coords[i + 1]);
    if (!best || r.distanceM < best.distanceM) {
      best = { index: i, t: r.t, point: r.point, distanceM: r.distanceM, alongM: cum[i] + (cum[i + 1] - cum[i]) * r.t };
    }
  }
  return best;
}

/** Teilstrecke zwischen zwei Streckenpositionen (Meter ab Start), inkl. interpolierter Endpunkte. */
export function sliceLineByDistance(coords, fromM, toM, cum = cumulativeLengths(coords)) {
  if (!coords || coords.length < 2) return coords ? [...coords] : [];
  const a = pointAtDistance(coords, fromM, cum);
  const b = pointAtDistance(coords, toM, cum);
  if (fromM > toM) return sliceLineByDistance(coords, toM, fromM, cum).reverse();
  const out = [a.point];
  for (let i = a.index + 1; i <= b.index; i++) out.push([...coords[i]]);
  out.push(b.point);
  return out;
}

/** Prüft, ob Punkt in Bounding Box [west, south, east, north] liegt. */
export function inBbox(p, bbox) {
  return p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3];
}

/** Bounding Box einer Koordinatenfolge. */
export function bboxOf(coords) {
  let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
  for (const c of coords) {
    if (c[0] < w) w = c[0];
    if (c[0] > e) e = c[0];
    if (c[1] < s) s = c[1];
    if (c[1] > n) n = c[1];
  }
  return [w, s, e, n];
}

/** Rundet Koordinaten auf `digits` Nachkommastellen (Standard: 5 ≈ 1 m). */
export function roundCoord(p, digits = 5) {
  const f = 10 ** digits;
  return [Math.round(p[0] * f) / f, Math.round(p[1] * f) / f];
}
