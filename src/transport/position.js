/**
 * Positionsberechnung für Fahrten (Trips) ohne Live-Radar.
 *
 * Der Upstream liefert keine Zugpositionen mehr; sie werden aus den Halten
 * (Plan-/Echtzeitzeiten) und einer Streckengeometrie zeitlich interpoliert:
 *
 *   1. Geometrie (`buildTrackGeometry`): bevorzugt die Polyline des Trips
 *      (Halte werden monoton auf die nächsten Stützpunkte gemappt und auf
 *      Plausibilität geprüft), sonst je Halt-Paar die Korridor-Teilstrecke
 *      (`routeBetween`) oder die Luftlinie.
 *   2. Zeitachse: je Halt eine Ankunfts- und Abfahrtszeit (Echtzeit vor Plan,
 *      fehlende Werte werden gegenseitig ergänzt bzw. interpoliert).
 *   3. Zustand (`computePosition`): `scheduled` (vor erster Abfahrt), `at_stop`
 *      (zwischen Ankunft und Abfahrt eines Halts), `en_route` (im Segment),
 *      `finished` (nach letzter Ankunft), `cancelled` (Fahrt ausgefallen),
 *      `unknown` (keine Zeitinformation).
 *
 * Alle Funktionen sind rein (keine Netzwerkzugriffe, keine Zeitquelle – der
 * Zeitpunkt wird als `nowMs` übergeben). Koordinaten immer `[lon, lat]`.
 */
import {
  haversineM, bearingDeg, cumulativeLengths, pointAtDistance, nearestVertexIndex, isLonLat, roundCoord,
} from '../lib/geo.js';

/** @typedef {{id:string|null, name:string, lat:number|null, lon:number|null}} Stop */

/**
 * @typedef {{
 *   lon:number, lat:number, bearing:number,
 *   state:'scheduled'|'en_route'|'at_stop'|'finished'|'cancelled'|'unknown',
 *   source:'polyline'|'corridor'|'linear',
 *   delaySec:number|null, delayMin:number|null, status:string,
 *   prevStop:Stop|null, nextStop:Stop|null,
 *   nextStopPlannedArrival:string|null, nextStopArrival:string|null, prevStopDeparture:string|null,
 *   progress:number, speedKmh:number|null, segmentIndex:number
 * }} Position
 */

/**
 * @typedef {{
 *   coords:Array<[number,number]>, stopIndex:number[], source:'polyline'|'corridor'|'linear',
 *   cum:number[], stopoverIndex:number[]
 * }} TrackGeometry
 */

/** Verspätungsklassen (Sekunden). DB zählt Züge bis 5:59 min als pünktlich. */
export const DELAY_THRESHOLDS = Object.freeze({
  onTimeMaxSec: 359,   // ≤ 5:59 min pünktlich
  slightMaxSec: 959,   // 6–15 min leicht verspätet
  delayedMaxSec: 3600, // 16–60 min verspätet, darüber stark
});

/** Höchstgeschwindigkeit für die Plausibilitätsbegrenzung (km/h). */
export const MAX_SPEED_KMH = 330;

/** Maximaler Abstand Halt ↔ Polyline-Stützpunkt, bevor die Polyline verworfen wird (Meter). */
export const MAX_STOP_SNAP_M = 5000;

const STATUS_ORDER = ['on_time', 'slight', 'delayed', 'heavy', 'cancelled', 'unknown'];
export const DELAY_STATUSES = Object.freeze([...STATUS_ORDER]);

/**
 * Ordnet eine Verspätung (Sekunden) einer Klasse zu.
 * @param {number|null|undefined} delaySec Verspätung in Sekunden, `null` = keine Echtzeitinformation
 * @param {{cancelled?:boolean}} [opts]
 * @returns {'on_time'|'slight'|'delayed'|'heavy'|'cancelled'|'unknown'}
 */
export function classifyDelay(delaySec, { cancelled = false } = {}) {
  if (cancelled === true) return 'cancelled';
  if (typeof delaySec !== 'number' || !Number.isFinite(delaySec)) return 'unknown';
  if (delaySec <= DELAY_THRESHOLDS.onTimeMaxSec) return 'on_time';
  if (delaySec <= DELAY_THRESHOLDS.slightMaxSec) return 'slight';
  if (delaySec <= DELAY_THRESHOLDS.delayedMaxSec) return 'delayed';
  return 'heavy';
}

/**
 * Parst einen Zeitstempel (ISO-8601-String mit Offset oder Epoch-Millisekunden) zu Epoch-Millisekunden.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseTimeMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length < 10 || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Gibt `[lon, lat]` eines Stops zurück oder `null`, wenn Koordinaten fehlen/ungültig sind. */
function stopLonLat(stop) {
  if (!stop || typeof stop !== 'object') return null;
  const p = [stop.lon, stop.lat];
  return isLonLat(p) ? p : null;
}

/** Sichere Kopie eines Stops für die Ausgabe (nur die vereinbarten Felder). */
function publicStop(stop) {
  if (!stop || typeof stop !== 'object') return null;
  return {
    id: typeof stop.id === 'string' ? stop.id : null,
    name: typeof stop.name === 'string' ? stop.name : '',
    lat: Number.isFinite(stop.lat) ? stop.lat : null,
    lon: Number.isFinite(stop.lon) ? stop.lon : null,
  };
}

const nullableString = (v) => (typeof v === 'string' && v !== '' ? v : null);
const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Liefert die Halteliste des Trips; fehlt sie, werden Start- und Zielbahnhof
 * als Ersatz-Halte synthetisiert (aus `origin`/`destination` und den Trip-Zeiten).
 * @param {object} trip
 * @returns {object[]}
 */
function stopoversOf(trip) {
  if (Array.isArray(trip.stopovers) && trip.stopovers.length > 0) {
    return trip.stopovers.filter((s) => s && typeof s === 'object');
  }
  const out = [];
  if (trip.origin && typeof trip.origin === 'object') {
    out.push({
      stop: trip.origin,
      plannedArrival: null, arrival: null, arrivalDelaySec: null,
      plannedDeparture: nullableString(trip.plannedDeparture), departure: nullableString(trip.departure),
      departureDelaySec: finiteOrNull(trip.departureDelaySec),
      cancelled: false, loadFactor: null, remarks: [],
    });
  }
  if (trip.destination && typeof trip.destination === 'object') {
    out.push({
      stop: trip.destination,
      plannedArrival: nullableString(trip.plannedArrival), arrival: nullableString(trip.arrival),
      arrivalDelaySec: finiteOrNull(trip.arrivalDelaySec),
      plannedDeparture: null, departure: null, departureDelaySec: null,
      cancelled: false, loadFactor: null, remarks: [],
    });
  }
  return out;
}

/**
 * Nutzbare Halte: nicht ausgefallen, mit gültigen Koordinaten.
 * @returns {Array<{index:number, stopover:object, point:[number,number]}>}
 */
function usableStops(trip, { includeCancelled = false } = {}) {
  const out = [];
  const list = stopoversOf(trip);
  for (let i = 0; i < list.length; i++) {
    const so = list[i];
    if (!includeCancelled && so.cancelled === true) continue;
    const point = stopLonLat(so.stop);
    if (!point) continue;
    out.push({ index: i, stopover: so, point });
  }
  return out;
}

/** Bereinigte Polyline des Trips (nur gültige Punkte) oder `null`. */
function cleanPolyline(polyline) {
  if (!Array.isArray(polyline)) return null;
  const out = [];
  for (const c of polyline) {
    if (!isLonLat(c)) continue;
    const p = [c[0], c[1]];
    if (out.length && haversineM(out[out.length - 1], p) < 0.5) continue; // Doppelpunkte
    out.push(p);
  }
  return out.length >= 2 ? out : null;
}

/**
 * Mappt Halte monoton auf die nächsten Stützpunkte der Polyline.
 * @returns {number[]|null} Stützpunkt-Indizes oder `null`, wenn ein Halt zu weit entfernt liegt
 */
function mapStopsToPolyline(coords, stops) {
  const idx = [];
  let from = 0;
  for (const s of stops) {
    const i = nearestVertexIndex(coords, s.point, from);
    if (i < 0) return null;
    if (haversineM(coords[i], s.point) > MAX_STOP_SNAP_M) return null;
    idx.push(i);
    from = i;
  }
  return idx;
}

/** Validiert das Ergebnis von `routeBetween`: Array aus ≥ 2 gültigen Punkten. */
function validRoute(route) {
  if (!Array.isArray(route) || route.length < 2) return null;
  const out = [];
  for (const c of route) {
    if (!isLonLat(c)) return null;
    out.push([c[0], c[1]]);
  }
  return out;
}

/**
 * Baut die Streckengeometrie eines Trips.
 * @param {object} trip normalisierter Trip
 * @param {{routeBetween?: (a:{lat:number,lon:number}, b:{lat:number,lon:number}) => Array<[number,number]>|null}} [opts]
 * @returns {TrackGeometry|null} `null`, wenn kein Halt mit Koordinaten existiert
 */
export function buildTrackGeometry(trip, { routeBetween } = {}) {
  if (!trip || typeof trip !== 'object') return null;
  const stops = usableStops(trip);
  if (stops.length === 0) return null;
  const stopoverIndex = stops.map((s) => s.index);

  if (stops.length === 1) {
    const coords = [stops[0].point];
    return { coords, stopIndex: [0], source: 'linear', cum: [0], stopoverIndex };
  }

  // 1) Polyline des Upstreams, sofern plausibel
  const poly = cleanPolyline(trip.polyline);
  if (poly) {
    const mapped = mapStopsToPolyline(poly, stops);
    if (mapped) {
      return { coords: poly, stopIndex: mapped, source: 'polyline', cum: cumulativeLengths(poly), stopoverIndex };
    }
  }

  // 2) Korridor-Teilstrecken je Halt-Paar, sonst Luftlinie
  const coords = [stops[0].point];
  const stopIndex = [0];
  let corridorSegments = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1].point;
    const b = stops[i].point;
    let inner = null;
    if (typeof routeBetween === 'function') {
      let route = null;
      try {
        route = validRoute(routeBetween({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] }));
      } catch {
        route = null; // Korridor-Fehler → Luftlinie
      }
      if (route) {
        // Endpunkte in unmittelbarer Nähe der Halte weglassen (Halt selbst wird als Stützpunkt genutzt)
        inner = route.filter((p) => haversineM(p, a) > 50 && haversineM(p, b) > 50);
        corridorSegments++;
      }
    }
    if (inner) for (const p of inner) coords.push(p);
    coords.push(b);
    stopIndex.push(coords.length - 1);
  }
  return {
    coords,
    stopIndex,
    source: corridorSegments > 0 ? 'corridor' : 'linear',
    cum: cumulativeLengths(coords),
    stopoverIndex,
  };
}

/**
 * Effektive Zeit: Echtzeit vor Plan; fehlt die Echtzeit, aber eine Verspätung ist bekannt,
 * wird sie auf die Planzeit addiert.
 */
function effectiveTime(realtime, planned, delaySec) {
  const rt = parseTimeMs(realtime);
  if (rt !== null) return rt;
  const pl = parseTimeMs(planned);
  if (pl === null) return null;
  if (typeof delaySec === 'number' && Number.isFinite(delaySec)) return pl + delaySec * 1000;
  return pl;
}

/**
 * Zeitachse je nutzbarem Halt: `{arr, dep}` in Epoch-ms. Fehlende Werte werden ergänzt:
 * Ankunft ↔ Abfahrt gegenseitig, sonst Interpolation nach Streckenanteil, Ränder werden fortgeschrieben.
 * Zeiten werden monoton gemacht (Abfahrt ≥ Ankunft, nächste Ankunft ≥ Abfahrt).
 * @returns {Array<{arr:number, dep:number}>|null} `null`, wenn kein Halt eine Zeit besitzt
 */
function buildTimeline(stopovers, cum, stopIndex) {
  const n = stopovers.length;
  const arr = new Array(n).fill(null);
  const dep = new Array(n).fill(null);
  let any = false;
  for (let i = 0; i < n; i++) {
    const so = stopovers[i];
    const a = effectiveTime(so.arrival, so.plannedArrival, so.arrivalDelaySec);
    const d = effectiveTime(so.departure, so.plannedDeparture, so.departureDelaySec);
    arr[i] = a !== null ? a : d;
    dep[i] = d !== null ? d : a;
    if (arr[i] !== null) any = true;
  }
  if (!any) return null;

  // Lücken schließen: Interpolation zwischen bekannten Nachbarn nach Streckenanteil
  for (let i = 0; i < n; i++) {
    if (arr[i] !== null) continue;
    let p = i - 1;
    while (p >= 0 && dep[p] === null) p--;
    let q = i + 1;
    while (q < n && arr[q] === null) q++;
    let t;
    if (p >= 0 && q < n) {
      const span = cum[stopIndex[q]] - cum[stopIndex[p]];
      const f = span > 0 ? (cum[stopIndex[i]] - cum[stopIndex[p]]) / span : 0;
      t = dep[p] + (arr[q] - dep[p]) * f;
    } else if (p >= 0) {
      t = dep[p];
    } else {
      t = arr[q];
    }
    arr[i] = t;
    dep[i] = t;
  }

  // Monotonie erzwingen
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = Math.max(arr[i], last);
    const d = Math.max(dep[i], a);
    out.push({ arr: a, dep: d });
    last = d;
  }
  return out;
}

/** Kurs an einer Streckenposition (Meter ab Start). */
function bearingAt(coords, cum, alongM) {
  if (coords.length < 2) return 0;
  const r = pointAtDistance(coords, alongM, cum);
  return r ? r.bearing : 0;
}

/** Verspätung: erster nicht-null Wert der Kandidaten. */
function firstDelay(...values) {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** Geometrie aus Cache holen bzw. ablegen (Schlüssel: das Trip-Objekt – WeakMap empfohlen). */
function geometryFor(trip, routeBetween, cache) {
  if (cache && typeof cache.get === 'function' && typeof cache.set === 'function') {
    const hit = cache.get(trip);
    if (hit !== undefined) return hit;
    const geom = buildTrackGeometry(trip, { routeBetween });
    cache.set(trip, geom);
    return geom;
  }
  return buildTrackGeometry(trip, { routeBetween });
}

/** Erzeugt einen Geometrie-Cache (WeakMap, Schlüssel = Trip-Objekt; verfällt mit dem Trip). */
export function createGeometryCache() {
  return new WeakMap();
}

/**
 * Baut das Positionsobjekt zusammen.
 */
function makePosition({
  point, bearing, state, source, delaySec, cancelled, prev, next, progress, speedKmh, segmentIndex,
}) {
  const delay = finiteOrNull(delaySec);
  return {
    lon: point[0],
    lat: point[1],
    bearing: Math.round(bearing * 10) / 10,
    state,
    source,
    delaySec: delay,
    delayMin: delay === null ? null : Math.round(delay / 60),
    status: classifyDelay(delay, { cancelled }),
    prevStop: prev ? publicStop(prev.stop) : null,
    nextStop: next ? publicStop(next.stop) : null,
    nextStopPlannedArrival: next ? nullableString(next.plannedArrival) : null,
    nextStopArrival: next ? nullableString(next.arrival) : null,
    prevStopDeparture: prev ? (nullableString(prev.departure) ?? nullableString(prev.plannedDeparture)) : null,
    progress: Math.min(1, Math.max(0, progress)),
    speedKmh: speedKmh === null ? null : Math.round(Math.min(MAX_SPEED_KMH, Math.max(0, speedKmh))),
    segmentIndex,
  };
}

/**
 * Position einer ausgefallenen Fahrt: letzter bekannter (auch ausgefallener) Halt, dessen
 * Zeit bereits erreicht ist, sonst der Startbahnhof.
 */
function cancelledPosition(trip, nowMs) {
  const stops = usableStops(trip, { includeCancelled: true });
  if (stops.length === 0) return null;
  let current = stops[0];
  for (const s of stops) {
    const t = effectiveTime(s.stopover.departure, s.stopover.plannedDeparture, s.stopover.departureDelaySec)
      ?? effectiveTime(s.stopover.arrival, s.stopover.plannedArrival, s.stopover.arrivalDelaySec);
    if (t !== null && t <= nowMs) current = s; else if (t !== null) break;
  }
  const pos = stops.indexOf(current);
  const next = stops[pos + 1] || null;
  const bearing = next ? bearingDeg(current.point, next.point) : 0;
  return makePosition({
    point: current.point,
    bearing,
    state: 'cancelled',
    source: 'linear',
    delaySec: firstDelay(current.stopover.departureDelaySec, current.stopover.arrivalDelaySec),
    cancelled: true,
    prev: current.stopover,
    next: next ? next.stopover : null,
    progress: 0,
    speedKmh: 0,
    segmentIndex: Math.max(0, pos),
  });
}

/**
 * Berechnet die Position eines Trips zum Zeitpunkt `nowMs`.
 * @param {object} trip normalisierter Trip
 * @param {number} nowMs Epoch-Millisekunden
 * @param {{routeBetween?: Function, geometryCache?: {get:Function, set:Function}}} [opts]
 * @returns {Position|null} `null`, wenn keine Koordinaten vorliegen oder die Eingabe ungültig ist
 */
export function computePosition(trip, nowMs, { routeBetween, geometryCache } = {}) {
  if (!trip || typeof trip !== 'object') return null;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;

  const allStopovers = stopoversOf(trip);
  const cancelled = trip.cancelled === true
    || (allStopovers.length > 0 && allStopovers.every((s) => s.cancelled === true));
  if (cancelled) return cancelledPosition(trip, nowMs);

  const geom = geometryFor(trip, routeBetween, geometryCache);
  if (!geom) return null;
  const { coords, stopIndex, cum, source } = geom;
  const stopovers = geom.stopoverIndex.map((i) => allStopovers[i]);
  const n = stopovers.length;
  const timeline = buildTimeline(stopovers, cum, stopIndex);

  const pointOf = (k) => coords[stopIndex[k]];

  if (!timeline) {
    // Keine Zeitinformation: Position am Startbahnhof, Zustand unbekannt
    const bearing = n > 1 ? bearingAt(coords, cum, cum[stopIndex[0]]) : 0;
    return makePosition({
      point: pointOf(0), bearing, state: 'unknown', source,
      delaySec: null, cancelled: false,
      prev: stopovers[0], next: stopovers[1] || null, progress: 0, speedKmh: null, segmentIndex: 0,
    });
  }

  // Vor der ersten Abfahrt
  if (nowMs < timeline[0].dep) {
    const so = stopovers[0];
    return makePosition({
      point: pointOf(0),
      bearing: n > 1 ? bearingAt(coords, cum, cum[stopIndex[0]]) : 0,
      state: 'scheduled',
      source,
      delaySec: firstDelay(so.departureDelaySec, stopovers[1] && stopovers[1].arrivalDelaySec),
      cancelled: false,
      prev: so,
      next: stopovers[1] || null,
      progress: 0,
      speedKmh: 0,
      segmentIndex: 0,
    });
  }

  // Nach der letzten Ankunft
  const last = n - 1;
  if (nowMs >= timeline[last].arr) {
    const so = stopovers[last];
    return makePosition({
      point: pointOf(last),
      bearing: n > 1 ? bearingAt(coords, cum, Math.max(0, cum[stopIndex[last]] - 1)) : 0,
      state: 'finished',
      source,
      delaySec: firstDelay(so.arrivalDelaySec, so.departureDelaySec, n > 1 ? stopovers[last - 1].departureDelaySec : null),
      cancelled: false,
      prev: so,
      next: null,
      progress: 1,
      speedKmh: 0,
      segmentIndex: Math.max(0, last - 1),
    });
  }

  // Im Halt oder im Segment
  for (let i = 0; i < n; i++) {
    const t = timeline[i];
    if (nowMs >= t.arr && nowMs < t.dep) {
      const so = stopovers[i];
      const next = stopovers[i + 1] || null;
      return makePosition({
        point: pointOf(i),
        bearing: next ? bearingAt(coords, cum, cum[stopIndex[i]]) : 0,
        state: 'at_stop',
        source,
        delaySec: firstDelay(so.departureDelaySec, so.arrivalDelaySec, next && next.arrivalDelaySec),
        cancelled: false,
        prev: so,
        next,
        progress: 0,
        speedKmh: 0,
        segmentIndex: Math.min(i, Math.max(0, n - 2)),
      });
    }
    if (i < last && nowMs >= t.dep && nowMs < timeline[i + 1].arr) {
      const prev = stopovers[i];
      const next = stopovers[i + 1];
      const durationMs = timeline[i + 1].arr - t.dep;
      const progress = durationMs > 0 ? (nowMs - t.dep) / durationMs : 1;
      const fromM = cum[stopIndex[i]];
      const toM = cum[stopIndex[i + 1]];
      const segLenM = toM - fromM;
      const alongM = fromM + segLenM * progress;
      const at = pointAtDistance(coords, alongM, cum);
      const speedKmh = durationMs > 0 ? (segLenM / 1000) / (durationMs / 3_600_000) : null;
      return makePosition({
        point: at ? at.point : pointOf(i),
        bearing: segLenM > 0 && at ? at.bearing : bearingDeg(pointOf(i), pointOf(i + 1)),
        state: 'en_route',
        source,
        delaySec: firstDelay(next.arrivalDelaySec, prev.departureDelaySec),
        cancelled: false,
        prev,
        next,
        progress,
        speedKmh,
        segmentIndex: i,
      });
    }
  }

  // Sollte durch die Monotonie der Zeitachse nicht erreichbar sein – defensiv: unbekannt am Start
  return makePosition({
    point: pointOf(0), bearing: 0, state: 'unknown', source, delaySec: null, cancelled: false,
    prev: stopovers[0], next: stopovers[1] || null, progress: 0, speedKmh: null, segmentIndex: 0,
  });
}

/** ISO-8601 (UTC) aus Epoch-Millisekunden oder `null`. */
function isoOrNull(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/**
 * GeoJSON-Feature (Punkt) für die Kartendarstellung.
 * @param {object} trip normalisierter Trip
 * @param {Position|null} position Ergebnis von `computePosition`
 * @returns {object|null} Feature oder `null`, wenn keine Position vorliegt
 */
export function tripToFeature(trip, position) {
  if (!trip || typeof trip !== 'object' || !position || typeof position !== 'object') return null;
  if (!isLonLat([position.lon, position.lat])) return null;
  const remarks = Array.isArray(trip.remarks) ? trip.remarks.filter((r) => r && typeof r === 'object') : [];
  const warningCount = remarks.filter((r) => r.type === 'warning').length;
  const polylineLength = Array.isArray(trip.polyline) ? trip.polyline.length : 0;
  const tripId = typeof trip.id === 'string' ? trip.id : String(trip.id ?? '');
  return {
    type: 'Feature',
    id: tripId,
    geometry: { type: 'Point', coordinates: roundCoord([position.lon, position.lat], 6) },
    properties: {
      tripId,
      line: nullableString(trip.lineName) ?? '',
      product: nullableString(trip.product),
      productName: nullableString(trip.productName),
      fahrtNr: nullableString(trip.fahrtNr),
      operator: nullableString(trip.operator),
      direction: nullableString(trip.direction),
      origin: trip.origin && typeof trip.origin === 'object' ? nullableString(trip.origin.name) : null,
      destination: trip.destination && typeof trip.destination === 'object' ? nullableString(trip.destination.name) : null,
      state: position.state,
      status: position.status,
      delaySec: finiteOrNull(position.delaySec),
      delayMin: finiteOrNull(position.delayMin),
      prevStop: position.prevStop ? position.prevStop.name : null,
      nextStop: position.nextStop ? position.nextStop.name : null,
      nextStopId: position.nextStop ? position.nextStop.id : null,
      nextStopPlannedArrival: nullableString(position.nextStopPlannedArrival),
      nextStopArrival: nullableString(position.nextStopArrival),
      bearing: finiteOrNull(position.bearing) ?? 0,
      speedKmh: finiteOrNull(position.speedKmh),
      source: position.source,
      cancelled: trip.cancelled === true || position.state === 'cancelled',
      loadFactor: nullableString(trip.loadFactor),
      updatedAt: isoOrNull(trip.realtimeDataUpdatedAt) ?? isoOrNull(trip.fetchedAt),
      hasPolyline: polylineLength >= 2,
      remarkCount: remarks.length,
      warningCount,
    },
  };
}
