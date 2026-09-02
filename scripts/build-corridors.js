#!/usr/bin/env node
/**
 * Erzeugt reproduzierbar `src/data/ice-corridors.geo.json` aus der Quelldefinition
 * `src/data/ice-corridors.source.js`.
 *
 * Bahnhofsnamen werden über `findStation()` aufgelöst; ein nicht auflösbarer Name
 * bricht den Build mit Fehler ab (Exit-Code 1). Koordinaten werden auf 5 Nachkomma-
 * stellen gerundet. Die Ausgabe enthält keine Zeitstempel, damit ein erneuter Lauf
 * bei unveränderter Quelle byteidentisch ist.
 *
 * Aufruf: `node scripts/build-corridors.js` (oder `npm run build:corridors`).
 * Die Funktionen sind exportiert, damit Tests den Build im Speicher ausführen können.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { corridorSources, KINDS } from '../src/data/ice-corridors.source.js';
import { findStation as defaultFindStation } from '../src/data/stations.js';
import { cumulativeLengths, haversineM, isLonLat, roundCoord } from '../src/lib/geo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const OUTPUT_PATH = join(__dirname, '..', 'src', 'data', 'ice-corridors.geo.json');

/** Zulässiger Bereich für Stützpunkte (Deutschland inkl. Grenzräume). */
const BBOX = Object.freeze([4.5, 45.5, 16.5, 56.0]);
/** Maximaler Abstand zweier aufeinanderfolgender Stützpunkte. */
const MAX_GAP_M = 80_000;
/** Mindestabstand zweier aufeinanderfolgender Stützpunkte (Duplikat-Schutz). */
const MIN_GAP_M = 1;
/** Maximales Verhältnis Streckenlänge zu Luftlinie der Endpunkte (Schutz vor Tippfehlern). */
const MAX_DETOUR_RATIO = 2.5;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Fehler beim Aufbau der Korridore (ungültige Quelle, nicht auflösbarer Name). */
export class CorridorBuildError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CorridorBuildError';
    this.code = 'CORRIDOR_BUILD';
    if (details !== undefined) this.details = details;
  }
}

function fail(corridorId, message, details) {
  throw new CorridorBuildError(`Korridor "${corridorId}": ${message}`, details);
}

/**
 * Löst einen Stützpunkt der Quelle auf.
 * @param {import('../src/data/ice-corridors.source.js').ViaPoint} v
 * @param {{findStation: (name: string) => ({id:string,name:string,lat:number,lon:number,cat?:number|null}|null)}} deps
 * @returns {{lonlat:[number,number], name:string|null, station:{id:string,name:string,cat:number|null}|null}}
 */
export function resolveViaPoint(v, { findStation }) {
  if (typeof v === 'string') {
    const name = v.trim();
    if (!name) throw new CorridorBuildError('Leerer Bahnhofsname in der Quelle');
    const st = findStation(name);
    if (!st) throw new CorridorBuildError(`Bahnhof "${name}" konnte nicht aufgelöst werden`, { name });
    if (!Number.isFinite(st.lat) || !Number.isFinite(st.lon)) {
      throw new CorridorBuildError(`Bahnhof "${name}" hat keine gültigen Koordinaten`, { name });
    }
    return { lonlat: [st.lon, st.lat], name: st.name, station: { id: String(st.id), name: st.name, cat: Number.isFinite(st.cat) ? st.cat : null } };
  }
  if (Array.isArray(v)) {
    if (!isLonLat(v) || v.length !== 2) throw new CorridorBuildError(`Ungültige Koordinate ${JSON.stringify(v)}`);
    return { lonlat: [v[0], v[1]], name: null, station: null };
  }
  if (v && typeof v === 'object') {
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!name) throw new CorridorBuildError('Benannter Stützpunkt ohne Namen');
    if (!isLonLat(v.lonlat) || v.lonlat.length !== 2) throw new CorridorBuildError(`Stützpunkt "${name}" hat eine ungültige Koordinate`);
    return { lonlat: [v.lonlat[0], v.lonlat[1]], name, station: null };
  }
  throw new CorridorBuildError(`Unbekannte Stützpunkt-Form: ${JSON.stringify(v)}`);
}

function validateHeader(src) {
  if (!src || typeof src !== 'object') throw new CorridorBuildError('Korridor-Eintrag ist kein Objekt');
  const id = src.id;
  if (typeof id !== 'string' || id.length < 3 || id.length > 64 || !ID_RE.test(id)) {
    throw new CorridorBuildError(`Ungültige Korridor-ID ${JSON.stringify(id)} (erlaubt: a-z, 0-9, Bindestrich)`);
  }
  if (typeof src.name !== 'string' || !src.name.trim() || src.name.length > 160) fail(id, 'ungültiger Name');
  if (!KINDS.includes(src.kind)) fail(id, `ungültige Art ${JSON.stringify(src.kind)} (erlaubt: ${KINDS.join(', ')})`);
  if (!Number.isInteger(src.vmax) || src.vmax < 80 || src.vmax > 330) fail(id, `unplausible Höchstgeschwindigkeit ${src.vmax}`);
  if (!Array.isArray(src.lines) || src.lines.length === 0
    || src.lines.some((l) => typeof l !== 'string' || !/^[A-Z]{2,4} \d{1,4}$/.test(l))) {
    fail(id, 'Linienliste fehlt oder enthält ungültige Einträge (Form "ICE 10")');
  }
  if (!Array.isArray(src.via) || src.via.length < 2) fail(id, 'mindestens zwei Stützpunkte erforderlich');
  return id;
}

/**
 * Baut ein GeoJSON-Feature (LineString) für einen Korridor.
 * @param {import('../src/data/ice-corridors.source.js').CorridorSource} src
 * @param {{findStation: Function}} deps
 */
export function buildCorridorFeature(src, { findStation }) {
  const id = validateHeader(src);
  const coordinates = [];
  const stops = [];
  src.via.forEach((v, index) => {
    let r;
    try {
      r = resolveViaPoint(v, { findStation });
    } catch (err) {
      fail(id, `Stützpunkt ${index + 1}: ${err.message}`, err.details);
    }
    const c = roundCoord(r.lonlat, 5);
    if (c[0] < BBOX[0] || c[0] > BBOX[2] || c[1] < BBOX[1] || c[1] > BBOX[3]) {
      fail(id, `Stützpunkt ${index + 1} (${r.name ?? 'Koordinate'}) liegt außerhalb des zulässigen Bereichs: ${c.join(', ')}`);
    }
    if (coordinates.length > 0) {
      const gap = haversineM(coordinates[coordinates.length - 1], c);
      if (gap < MIN_GAP_M) fail(id, `Stützpunkt ${index + 1} (${r.name ?? 'Koordinate'}) ist ein Duplikat des Vorgängers`);
      if (gap > MAX_GAP_M) {
        fail(id, `Lücke von ${(gap / 1000).toFixed(1)} km vor Stützpunkt ${index + 1} (${r.name ?? 'Koordinate'}) – bitte Zwischenpunkte ergänzen`);
      }
    }
    coordinates.push(c);
    if (r.station) stops.push({ index, id: r.station.id, name: r.station.name, cat: r.station.cat });
  });
  const cum = cumulativeLengths(coordinates);
  const lengthM = cum[cum.length - 1];
  const direct = haversineM(coordinates[0], coordinates[coordinates.length - 1]);
  if (direct > 5000 && lengthM / direct > MAX_DETOUR_RATIO) {
    fail(id, `Streckenlänge ${(lengthM / 1000).toFixed(1)} km ist unplausibel gegenüber der Luftlinie ${(direct / 1000).toFixed(1)} km`);
  }
  return {
    type: 'Feature',
    id,
    properties: {
      id,
      name: src.name.trim(),
      kind: src.kind,
      vmax: src.vmax,
      lines: [...src.lines],
      lengthKm: Math.round(lengthM / 100) / 10,
      stops,
    },
    geometry: { type: 'LineString', coordinates },
  };
}

/**
 * Baut die vollständige FeatureCollection.
 * @param {{sources?: Array, findStation?: Function}} [opts]
 */
export function buildCorridors({ sources = corridorSources, findStation = defaultFindStation } = {}) {
  if (!Array.isArray(sources)) throw new CorridorBuildError('Quellliste ist kein Array');
  if (typeof findStation !== 'function') throw new CorridorBuildError('findStation muss eine Funktion sein');
  const seen = new Set();
  const features = [];
  for (const src of sources) {
    const f = buildCorridorFeature(src, { findStation });
    if (seen.has(f.id)) throw new CorridorBuildError(`Doppelte Korridor-ID "${f.id}"`);
    seen.add(f.id);
    features.push(f);
  }
  return {
    type: 'FeatureCollection',
    _meta: {
      source: 'src/data/ice-corridors.source.js',
      generator: 'scripts/build-corridors.js',
      description: 'Schematische Verläufe der ICE-/IC-Hauptkorridore (Schnellfahr-, Ausbau- und Hauptstrecken). '
        + 'Bahnhofskoordinaten aus DB Station Data (CC BY 4.0), übrige Stützpunkte schematisch nach Trassenverlauf.',
      coordinatePrecision: 5,
      count: features.length,
    },
    features,
  };
}

/** Stabile Serialisierung (eine Koordinate je Zeile ist unnötig – kompakte Features, eine je Zeile). */
export function serializeCorridors(fc) {
  const lines = ['{', '"type":"FeatureCollection",', `"_meta":${JSON.stringify(fc._meta)},`, '"features":['];
  fc.features.forEach((f, i) => {
    lines.push(JSON.stringify(f) + (i < fc.features.length - 1 ? ',' : ''));
  });
  lines.push(']', '}');
  return `${lines.join('\n')}\n`;
}

function main() {
  const fc = buildCorridors();
  writeFileSync(OUTPUT_PATH, serializeCorridors(fc), 'utf8');
  const totalKm = fc.features.reduce((s, f) => s + f.properties.lengthKm, 0);
  const byKind = {};
  for (const f of fc.features) byKind[f.properties.kind] = (byKind[f.properties.kind] || 0) + 1;
  process.stdout.write(
    `[build-corridors] ${fc.features.length} Korridore (${Object.entries(byKind).map(([k, n]) => `${k}: ${n}`).join(', ')}), `
    + `${Math.round(totalKm)} km, geschrieben nach ${relative(process.cwd(), OUTPUT_PATH)}\n`,
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[build-corridors] Fehler: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}
