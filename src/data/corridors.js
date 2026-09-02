/**
 * ICE-Hauptkorridore (schematische Streckengeometrie) und räumlicher Index.
 *
 * Datenbasis: `ice-corridors.geo.json`, erzeugt aus `ice-corridors.source.js`
 * (`npm run build:corridors`). Der Index liefert Teilstrecken zwischen zwei Punkten,
 * die auf demselben Korridor liegen (Fallback-Geometrie für die Positionsinterpolation,
 * wenn der Upstream keine Polyline liefert).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cumulativeLengths, nearestPointOnLine, sliceLineByDistance, haversineM, bboxOf, isLonLat } from '../lib/geo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cached = null;
/** Liefert die (unveränderliche) FeatureCollection der Korridore. */
export function corridorsGeoJson() {
  if (!cached) {
    cached = JSON.parse(readFileSync(join(__dirname, 'ice-corridors.geo.json'), 'utf8'));
  }
  return cached;
}

/**
 * @typedef {{id:string, name:string, kind:string, vmax:number|null, lines:string[], lengthKm:number|null,
 *   coords:Array<[number,number]>, cum:number[], bbox:[number,number,number,number]}} CorridorEntry
 */

function toEntry(feature) {
  const g = feature && feature.geometry;
  if (!g || g.type !== 'LineString' || !Array.isArray(g.coordinates)) return null;
  const coords = g.coordinates.filter(isLonLat).map((c) => [c[0], c[1]]);
  if (coords.length < 2) return null;
  const p = feature.properties || {};
  return {
    id: String(p.id || ''),
    name: String(p.name || p.id || ''),
    kind: String(p.kind || 'Hauptstrecke'),
    vmax: Number.isFinite(p.vmax) ? p.vmax : null,
    lines: Array.isArray(p.lines) ? p.lines.map(String) : [],
    lengthKm: Number.isFinite(p.lengthKm) ? p.lengthKm : null,
    coords,
    cum: cumulativeLengths(coords),
    bbox: bboxOf(coords),
  };
}

function expandBbox(bbox, marginDeg) {
  return [bbox[0] - marginDeg, bbox[1] - marginDeg, bbox[2] + marginDeg, bbox[3] + marginDeg];
}

const toLonLat = (p) => (Array.isArray(p) ? p : [p.lon ?? p.longitude, p.lat ?? p.latitude]);

/**
 * Erzeugt den Korridor-Index.
 * @param {{corridors?: object}} [opts] optionale FeatureCollection (Tests)
 */
export function createCorridorIndex({ corridors } = {}) {
  const fc = corridors || corridorsGeoJson();
  /** @type {CorridorEntry[]} */
  const entries = (fc.features || []).map(toEntry).filter(Boolean);

  /** Kandidaten, deren Bounding-Box (mit Rand) den Punkt enthält. */
  function candidates(p, maxSnapM) {
    const margin = maxSnapM / 111_000 + 0.01;
    return entries.filter((e) => {
      const b = expandBbox(e.bbox, margin);
      return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
    });
  }

  function snap(entry, p) {
    return nearestPointOnLine(entry.coords, p, entry.cum);
  }

  /**
   * Teilstrecke zwischen a und b entlang eines gemeinsamen Korridors (Reihenfolge a→b).
   * Verkettet bei Bedarf zwei Korridore über einen gemeinsamen Endpunkt (< 500 m).
   * @returns {Array<[number,number]>|null}
   */
  function routeBetween(a, b, { maxSnapM = 3000 } = {}) {
    const pa = toLonLat(a);
    const pb = toLonLat(b);
    if (!isLonLat(pa) || !isLonLat(pb)) return null;
    const ca = candidates(pa, maxSnapM);
    if (ca.length === 0) return null;
    const cb = candidates(pb, maxSnapM);
    if (cb.length === 0) return null;

    // 1) gemeinsamer Korridor
    let best = null;
    for (const e of ca) {
      if (!cb.includes(e)) continue;
      const sa = snap(e, pa);
      const sb = snap(e, pb);
      if (sa.distanceM > maxSnapM || sb.distanceM > maxSnapM) continue;
      const score = sa.distanceM + sb.distanceM;
      if (!best || score < best.score) best = { e, sa, sb, score };
    }
    if (best) {
      const line = sliceLineByDistance(best.e.coords, best.sa.alongM, best.sb.alongM, best.e.cum);
      return trimEnds(line, pa, pb);
    }

    // 2) Verkettung zweier Korridore über gemeinsamen Endpunkt
    let bestChain = null;
    for (const ea of ca) {
      const sa = snap(ea, pa);
      if (sa.distanceM > maxSnapM) continue;
      for (const eb of cb) {
        if (ea === eb) continue;
        const sb = snap(eb, pb);
        if (sb.distanceM > maxSnapM) continue;
        const endsA = [[0, ea.coords[0]], [ea.cum[ea.cum.length - 1], ea.coords[ea.coords.length - 1]]];
        const endsB = [[0, eb.coords[0]], [eb.cum[eb.cum.length - 1], eb.coords[eb.coords.length - 1]]];
        for (const [alongA, endA] of endsA) {
          for (const [alongB, endB] of endsB) {
            const joinDist = haversineM(endA, endB);
            if (joinDist > 500) continue;
            const total = Math.abs(alongA - sa.alongM) + Math.abs(sb.alongM - alongB);
            if (!bestChain || total < bestChain.total) bestChain = { ea, eb, sa, sb, alongA, alongB, total };
          }
        }
      }
    }
    if (bestChain) {
      const { ea, eb, sa, sb, alongA, alongB } = bestChain;
      const first = sliceLineByDistance(ea.coords, sa.alongM, alongA, ea.cum);
      const second = sliceLineByDistance(eb.coords, alongB, sb.alongM, eb.cum);
      return trimEnds([...first, ...second.slice(1)], pa, pb);
    }
    return null;
  }

  /** Nächster Korridor zu einem Punkt. */
  function nearestCorridor(p, { maxDistanceM = 50_000 } = {}) {
    const pt = toLonLat(p);
    if (!isLonLat(pt)) return null;
    let best = null;
    for (const e of candidates(pt, maxDistanceM)) {
      const s = snap(e, pt);
      if (s.distanceM <= maxDistanceM && (!best || s.distanceM < best.distanceM)) {
        best = { id: e.id, name: e.name, kind: e.kind, vmax: e.vmax, lines: e.lines, distanceM: Math.round(s.distanceM), alongM: Math.round(s.alongM) };
      }
    }
    return best;
  }

  return {
    routeBetween,
    nearestCorridor,
    all: () => entries.map(({ id, name, kind, vmax, lines, lengthKm }) => ({ id, name, kind, vmax, lines, lengthKm })),
    size: () => entries.length,
  };
}

/** Entfernt degenerierte Doppelpunkte an den Enden und stellt sicher, dass die Linie ≥ 2 Punkte hat. */
function trimEnds(line, pa, pb) {
  const out = [];
  for (const c of line) {
    if (out.length && haversineM(out[out.length - 1], c) < 1) continue;
    out.push([c[0], c[1]]);
  }
  if (out.length < 2) return [pa, pb];
  return out;
}
