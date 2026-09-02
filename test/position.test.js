import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDelay, parseTimeMs, buildTrackGeometry, computePosition, tripToFeature, createGeometryCache,
  DELAY_THRESHOLDS, MAX_SPEED_KMH, MAX_STOP_SNAP_M, DELAY_STATUSES,
} from '../src/transport/position.js';
import { haversineM, lineLengthM, interpolatePoint, nearestPointOnLine } from '../src/lib/geo.js';

// ---------------------------------------------------------------------------
// Testdaten: Berlin Hbf → Hamburg Hbf (eigene kleine Trips, keine Fixture-Dateien)
// ---------------------------------------------------------------------------

const S = {
  berlin: { id: '8011160', name: 'Berlin Hbf', lat: 52.525592, lon: 13.369545 },
  spandau: { id: '8010404', name: 'Berlin-Spandau', lat: 52.534, lon: 13.197 },
  wittenberge: { id: '8010382', name: 'Wittenberge', lat: 52.9961, lon: 11.7657 },
  ludwigslust: { id: '8010212', name: 'Ludwigslust', lat: 53.3226, lon: 11.4874 },
  hamburg: { id: '8002549', name: 'Hamburg Hbf', lat: 53.552736, lon: 10.006909 },
};

/** ISO-Zeit am 2026-09-02 (MESZ) */
const T = (h, m, s = 0) => `2026-09-02T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}+02:00`;
const ms = (iso) => Date.parse(iso);

function stopover(stop, { arr = null, dep = null, arrDelay = null, depDelay = null, cancelled = false, arrRt = null, depRt = null } = {}) {
  return {
    stop,
    plannedArrival: arr, arrival: arrRt, arrivalDelaySec: arrDelay,
    plannedDeparture: dep, departure: depRt, departureDelaySec: depDelay,
    plannedArrivalPlatform: null, arrivalPlatform: null, plannedDeparturePlatform: null, departurePlatform: null,
    cancelled, loadFactor: null, remarks: [],
  };
}

/** Standard-Fahrt: Abfahrt 10:00 Berlin, Ankunft 11:55 Hamburg. */
function baseStopovers() {
  return [
    stopover(S.berlin, { dep: T(10, 0), depDelay: 0 }),
    stopover(S.spandau, { arr: T(10, 14), dep: T(10, 16), arrDelay: 0, depDelay: 0 }),
    stopover(S.wittenberge, { arr: T(11, 0), dep: T(11, 2), arrDelay: 0, depDelay: 0 }),
    stopover(S.ludwigslust, { arr: T(11, 20), dep: T(11, 22), arrDelay: 0, depDelay: 0 }),
    stopover(S.hamburg, { arr: T(11, 55), arrDelay: 0 }),
  ];
}

/** Polyline entlang der Halte (10 Zwischenpunkte je Segment → 41 Punkte). */
function polylineAlong(stops, perSegment = 10) {
  const out = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = [stops[i].lon, stops[i].lat];
    const b = [stops[i + 1].lon, stops[i + 1].lat];
    for (let k = 0; k < perSegment; k++) out.push(interpolatePoint(a, b, k / perSegment));
  }
  const last = stops[stops.length - 1];
  out.push([last.lon, last.lat]);
  return out;
}

function makeTrip(overrides = {}) {
  const stopovers = overrides.stopovers || baseStopovers();
  return {
    id: '1|123456|0|80|2092026',
    lineName: 'ICE 703',
    product: 'nationalExpress',
    productName: 'ICE',
    fahrtNr: '703',
    operator: 'DB Fernverkehr AG',
    direction: 'Hamburg Hbf',
    origin: S.berlin,
    destination: S.hamburg,
    plannedDeparture: T(10, 0), departure: null, departureDelaySec: 0,
    plannedArrival: T(11, 55), arrival: null, arrivalDelaySec: 0,
    cancelled: false,
    loadFactor: 'high',
    remarks: [
      { type: 'hint', code: 'komfort', summary: null, text: 'Bordrestaurant', modified: null, priority: null },
      { type: 'warning', code: 'HIM', summary: 'Bauarbeiten', text: 'Bauarbeiten zwischen Wittenberge und Ludwigslust', modified: null, priority: 2 },
    ],
    polyline: polylineAlong([S.berlin, S.spandau, S.wittenberge, S.ludwigslust, S.hamburg]),
    realtimeDataUpdatedAt: ms(T(10, 30)),
    fetchedAt: ms(T(10, 30, 5)),
    ...overrides,
    stopovers,
  };
}

const near = (p, stop, tolM = 50) => haversineM(p, [stop.lon, stop.lat]) <= tolM;

// ---------------------------------------------------------------------------
// classifyDelay / parseTimeMs
// ---------------------------------------------------------------------------

test('classifyDelay: Grenzen nach DB-Pünktlichkeitsdefinition', () => {
  assert.equal(classifyDelay(null), 'unknown');
  assert.equal(classifyDelay(undefined), 'unknown');
  assert.equal(classifyDelay(NaN), 'unknown');
  assert.equal(classifyDelay('120'), 'unknown');
  assert.equal(classifyDelay(-120), 'on_time');
  assert.equal(classifyDelay(0), 'on_time');
  assert.equal(classifyDelay(359), 'on_time');
  assert.equal(classifyDelay(360), 'slight');
  assert.equal(classifyDelay(959), 'slight');
  assert.equal(classifyDelay(960), 'delayed');
  assert.equal(classifyDelay(3600), 'delayed');
  assert.equal(classifyDelay(3601), 'heavy');
  assert.equal(classifyDelay(0, { cancelled: true }), 'cancelled');
  assert.equal(classifyDelay(null, { cancelled: true }), 'cancelled');
  assert.equal(classifyDelay(900, { cancelled: false }), 'slight');
  assert.equal(DELAY_THRESHOLDS.onTimeMaxSec, 359);
  assert.ok(DELAY_STATUSES.includes('heavy'));
  assert.equal(MAX_SPEED_KMH, 330);
  assert.equal(MAX_STOP_SNAP_M, 5000);
});

test('parseTimeMs: ISO mit Offset, Zahlen, Unsinn', () => {
  assert.equal(parseTimeMs('2026-09-02T18:04:00+02:00'), Date.UTC(2026, 8, 2, 16, 4));
  assert.equal(parseTimeMs('2026-09-02T16:04:00Z'), Date.UTC(2026, 8, 2, 16, 4));
  assert.equal(parseTimeMs(1234), 1234);
  assert.equal(parseTimeMs(NaN), null);
  assert.equal(parseTimeMs(null), null);
  assert.equal(parseTimeMs(''), null);
  assert.equal(parseTimeMs('gestern'), null);
  assert.equal(parseTimeMs('x'.repeat(50)), null);
  assert.equal(parseTimeMs({}), null);
});

// ---------------------------------------------------------------------------
// buildTrackGeometry
// ---------------------------------------------------------------------------

test('buildTrackGeometry: Polyline wird bevorzugt, Halte monoton gemappt', () => {
  const g = buildTrackGeometry(makeTrip());
  assert.equal(g.source, 'polyline');
  assert.equal(g.coords.length, 41);
  assert.deepEqual(g.stopIndex, [0, 10, 20, 30, 40]);
  assert.deepEqual(g.stopoverIndex, [0, 1, 2, 3, 4]);
  assert.equal(g.cum.length, 41);
  assert.equal(g.cum[0], 0);
  assert.ok(g.cum[40] > 250_000 && g.cum[40] < 330_000);
});

test('buildTrackGeometry: Polyline mit Schleife wird monoton gemappt (kein Rücksprung)', () => {
  // Polyline fährt erst nach Hamburg, dann zurück nach Berlin und wieder nach Hamburg: Halte müssen
  // in aufsteigender Reihenfolge gemappt werden.
  const fwd = polylineAlong([S.berlin, S.spandau, S.wittenberge, S.ludwigslust, S.hamburg], 4);
  const back = [...fwd].reverse().slice(1);
  const trip = makeTrip({ polyline: [...fwd, ...back, ...fwd.slice(1)] });
  const g = buildTrackGeometry(trip);
  assert.equal(g.source, 'polyline');
  for (let i = 1; i < g.stopIndex.length; i++) assert.ok(g.stopIndex[i] >= g.stopIndex[i - 1]);
});

test('buildTrackGeometry: ungültige Polyline-Punkte werden verworfen, zu kurze Polyline → Fallback', () => {
  const trip = makeTrip();
  trip.polyline = [[999, 1], ...trip.polyline, [1, 'x'], null, [13.369545, 52.525592, 5]];
  const g = buildTrackGeometry(trip);
  assert.equal(g.source, 'polyline');
  assert.ok(g.coords.every((c) => Array.isArray(c) && c.length === 2));

  assert.equal(buildTrackGeometry(makeTrip({ polyline: [[13.4, 52.5]] })).source, 'linear');
  assert.equal(buildTrackGeometry(makeTrip({ polyline: null })).source, 'linear');
  assert.equal(buildTrackGeometry(makeTrip({ polyline: 'kaputt' })).source, 'linear');
});

test('buildTrackGeometry: unplausible Polyline (Halt > 5 km entfernt) wird verworfen', () => {
  // Polyline nur zwischen Berlin und Wittenberge – Ludwigslust und Hamburg fehlen
  const trip = makeTrip({ polyline: polylineAlong([S.berlin, S.spandau, S.wittenberge]) });
  const g = buildTrackGeometry(trip);
  assert.equal(g.source, 'linear');
  assert.equal(g.coords.length, 5);
  assert.deepEqual(g.stopIndex, [0, 1, 2, 3, 4]);
  // ... mit Korridor-Funktion wird der Korridor genutzt
  const routeBetween = (a, b) => [[a.lon, a.lat], interpolatePoint([a.lon, a.lat], [b.lon, b.lat], 0.5), [b.lon, b.lat]];
  const g2 = buildTrackGeometry(trip, { routeBetween });
  assert.equal(g2.source, 'corridor');
});

test('buildTrackGeometry: ausgefallene Halte und Halte ohne Koordinaten werden übersprungen', () => {
  const stops = baseStopovers();
  stops[2].cancelled = true; // Wittenberge fällt aus
  stops[3] = stopover({ id: '8010212', name: 'Ludwigslust', lat: null, lon: null }, { arr: T(11, 20), dep: T(11, 22) });
  const g = buildTrackGeometry(makeTrip({ stopovers: stops, polyline: null }));
  assert.equal(g.coords.length, 3);
  assert.deepEqual(g.stopoverIndex, [0, 1, 4]);
  assert.deepEqual(g.stopIndex, [0, 1, 2]);
  assert.ok(near(g.coords[2], S.hamburg));
});

test('buildTrackGeometry: Korridor je Halt-Paar, Fehler/ungültige Ergebnisse → Luftlinie', () => {
  const calls = [];
  const routeBetween = (a, b) => {
    calls.push([a, b]);
    // nur für Berlin–Spandau eine Route mit Umweg, sonst null
    if (Math.abs(a.lon - S.berlin.lon) < 1e-6) {
      return [[a.lon, a.lat], [13.30, 52.60], [13.25, 52.58], [b.lon, b.lat]];
    }
    return null;
  };
  const g = buildTrackGeometry(makeTrip({ polyline: null }), { routeBetween });
  assert.equal(g.source, 'corridor');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0][0], { lat: S.berlin.lat, lon: S.berlin.lon });
  // Umweg-Punkte eingefügt, Halt-Duplikate (Endpunkte der Route) entfernt
  assert.equal(g.coords.length, 5 + 2);
  assert.deepEqual(g.stopIndex, [0, 3, 4, 5, 6]);
  assert.ok(near(g.coords[0], S.berlin) && near(g.coords[3], S.spandau));

  const throwing = () => { throw new Error('Index kaputt'); };
  const g2 = buildTrackGeometry(makeTrip({ polyline: null }), { routeBetween: throwing });
  assert.equal(g2.source, 'linear');
  assert.equal(g2.coords.length, 5);

  const garbage = () => [[1, 2], ['x', 3]];
  assert.equal(buildTrackGeometry(makeTrip({ polyline: null }), { routeBetween: garbage }).source, 'linear');
  assert.equal(buildTrackGeometry(makeTrip({ polyline: null }), { routeBetween: () => 'nein' }).source, 'linear');
  assert.equal(buildTrackGeometry(makeTrip({ polyline: null }), { routeBetween: () => [[1, 2]] }).source, 'linear');
});

test('buildTrackGeometry: Grenzfälle (ein Halt, kein Halt, ungültiger Trip)', () => {
  const one = buildTrackGeometry(makeTrip({ stopovers: [stopover(S.berlin, { dep: T(10, 0) })], polyline: null }));
  assert.equal(one.coords.length, 1);
  assert.deepEqual(one.stopIndex, [0]);
  assert.equal(one.source, 'linear');

  const none = makeTrip({ stopovers: [stopover({ id: null, name: '?', lat: null, lon: null })], polyline: null });
  none.origin = { id: null, name: 'x', lat: null, lon: null };
  none.destination = null;
  assert.equal(buildTrackGeometry(none), null);
  assert.equal(buildTrackGeometry(null), null);
  assert.equal(buildTrackGeometry('trip'), null);
  assert.equal(buildTrackGeometry({}), null);
});

// ---------------------------------------------------------------------------
// computePosition
// ---------------------------------------------------------------------------

test('computePosition: vor der ersten Abfahrt → scheduled am Startbahnhof', () => {
  const p = computePosition(makeTrip(), ms(T(9, 30)));
  assert.equal(p.state, 'scheduled');
  assert.ok(near([p.lon, p.lat], S.berlin));
  assert.equal(p.prevStop.name, 'Berlin Hbf');
  assert.equal(p.nextStop.name, 'Berlin-Spandau');
  assert.equal(p.nextStop.id, '8010404');
  assert.equal(p.nextStopPlannedArrival, T(10, 14));
  assert.equal(p.nextStopArrival, null);
  assert.equal(p.prevStopDeparture, T(10, 0));
  assert.equal(p.progress, 0);
  assert.equal(p.speedKmh, 0);
  assert.equal(p.segmentIndex, 0);
  assert.equal(p.delaySec, 0);
  assert.equal(p.delayMin, 0);
  assert.equal(p.status, 'on_time');
  assert.equal(p.source, 'polyline');
  assert.ok(p.bearing > 240 && p.bearing < 300, `Kurs nach Westen erwartet: ${p.bearing}`);
});

test('computePosition: unterwegs mit Polyline – Fortschritt, Kurs, Geschwindigkeit', () => {
  const p = computePosition(makeTrip(), ms(T(10, 7)));
  assert.equal(p.state, 'en_route');
  assert.equal(p.segmentIndex, 0);
  assert.ok(Math.abs(p.progress - 0.5) < 1e-9, `progress ${p.progress}`);
  const mid = interpolatePoint([S.berlin.lon, S.berlin.lat], [S.spandau.lon, S.spandau.lat], 0.5);
  assert.ok(haversineM([p.lon, p.lat], mid) < 200);
  assert.ok(p.bearing > 240 && p.bearing < 300);
  assert.equal(p.prevStop.name, 'Berlin Hbf');
  assert.equal(p.nextStop.name, 'Berlin-Spandau');
  assert.equal(p.source, 'polyline');
  // ~11,7 km in 14 min ≈ 50 km/h
  assert.ok(p.speedKmh > 40 && p.speedKmh < 60, `speed ${p.speedKmh}`);
  assert.equal(p.status, 'on_time');
});

test('computePosition: unterwegs ohne Polyline (Luftlinie) und mit Korridor', () => {
  const t = makeTrip({ polyline: null });
  const p = computePosition(t, ms(T(10, 7)));
  assert.equal(p.source, 'linear');
  const mid = interpolatePoint([S.berlin.lon, S.berlin.lat], [S.spandau.lon, S.spandau.lat], 0.5);
  assert.ok(haversineM([p.lon, p.lat], mid) < 5);

  const routeBetween = (a, b) => [[a.lon, a.lat], [(a.lon + b.lon) / 2, (a.lat + b.lat) / 2 + 0.05], [b.lon, b.lat]];
  const q = computePosition(t, ms(T(10, 7)), { routeBetween });
  assert.equal(q.source, 'corridor');
  assert.ok(Math.abs(q.lat - (mid[1] + 0.05)) < 0.01);
});

test('computePosition: im Halt → at_stop mit Kurs des nächsten Segments', () => {
  const p = computePosition(makeTrip(), ms(T(10, 15)));
  assert.equal(p.state, 'at_stop');
  assert.ok(near([p.lon, p.lat], S.spandau));
  assert.equal(p.prevStop.name, 'Berlin-Spandau');
  assert.equal(p.nextStop.name, 'Wittenberge');
  assert.equal(p.progress, 0);
  assert.equal(p.speedKmh, 0);
  assert.equal(p.segmentIndex, 1);
  assert.ok(p.bearing > 270 && p.bearing < 340, `Kurs NW erwartet: ${p.bearing}`);
  // exakt zur Ankunft: at_stop; exakt zur Abfahrt: en_route
  assert.equal(computePosition(makeTrip(), ms(T(10, 14))).state, 'at_stop');
  assert.equal(computePosition(makeTrip(), ms(T(10, 16))).state, 'en_route');
});

test('computePosition: nach der letzten Ankunft → finished am Zielbahnhof', () => {
  const p = computePosition(makeTrip(), ms(T(12, 30)));
  assert.equal(p.state, 'finished');
  assert.ok(near([p.lon, p.lat], S.hamburg));
  assert.equal(p.prevStop.name, 'Hamburg Hbf');
  assert.equal(p.nextStop, null);
  assert.equal(p.progress, 1);
  assert.equal(p.speedKmh, 0);
  assert.equal(p.segmentIndex, 3);
  assert.equal(computePosition(makeTrip(), ms(T(11, 55))).state, 'finished');
});

test('computePosition: Echtzeit vor Plan, Verspätung wechselt zwischen Halten', () => {
  const stops = baseStopovers();
  // Wittenberge: +10 min Ankunft/Abfahrt (Echtzeit), Ludwigslust +12, Hamburg +8
  stops[2].arrival = T(11, 10); stops[2].arrivalDelaySec = 600;
  stops[2].departure = T(11, 12); stops[2].departureDelaySec = 600;
  stops[3].arrival = T(11, 32); stops[3].arrivalDelaySec = 720;
  stops[3].departure = T(11, 34); stops[3].departureDelaySec = 720;
  stops[4].arrival = T(12, 3); stops[4].arrivalDelaySec = 480;
  const trip = makeTrip({ stopovers: stops });

  // Segment Berlin–Spandau: pünktlich
  const a = computePosition(trip, ms(T(10, 5)));
  assert.equal(a.delaySec, 0);
  assert.equal(a.status, 'on_time');
  // Segment Spandau–Wittenberge: Verspätung des nächsten Halts (Ankunft)
  const b = computePosition(trip, ms(T(10, 30)));
  assert.equal(b.state, 'en_route');
  assert.equal(b.delaySec, 600);
  assert.equal(b.delayMin, 10);
  assert.equal(b.status, 'slight');
  assert.equal(b.nextStopArrival, T(11, 10));
  assert.equal(b.nextStopPlannedArrival, T(11, 0));
  // 11:05: laut Plan im Halt, laut Echtzeit noch unterwegs
  const c = computePosition(trip, ms(T(11, 5)));
  assert.equal(c.state, 'en_route');
  assert.ok(c.progress > 0.85 && c.progress < 1);
  // 11:11: im Halt Wittenberge
  const d = computePosition(trip, ms(T(11, 11)));
  assert.equal(d.state, 'at_stop');
  assert.equal(d.delaySec, 600);
  assert.equal(d.prevStopDeparture, T(11, 12));
  // Segment Wittenberge–Ludwigslust: 720 s
  const e = computePosition(trip, ms(T(11, 20)));
  assert.equal(e.state, 'en_route');
  assert.equal(e.delaySec, 720);
  assert.equal(e.status, 'slight');
  // Nach Plan-Ankunft in Hamburg (11:55) aber vor Echtzeit-Ankunft (12:03): noch unterwegs
  const f = computePosition(trip, ms(T(11, 58)));
  assert.equal(f.state, 'en_route');
  assert.equal(f.delaySec, 480);
  const g = computePosition(trip, ms(T(12, 4)));
  assert.equal(g.state, 'finished');
  assert.equal(g.delaySec, 480);
});

test('computePosition: fehlende Echtzeit, aber bekannte Verspätung → Plan + Verspätung', () => {
  const stops = baseStopovers();
  stops[1].arrivalDelaySec = 900; // Spandau +15 min ohne Echtzeit-String
  stops[1].departureDelaySec = 900;
  const trip = makeTrip({ stopovers: stops });
  const p = computePosition(trip, ms(T(10, 20)));
  assert.equal(p.state, 'en_route'); // Plan-Ankunft 10:14 wäre schon vorbei
  assert.equal(p.status, 'slight');
  assert.equal(computePosition(trip, ms(T(10, 30))).state, 'at_stop');
});

test('computePosition: Verspätungsklasse schwer/stark und Geschwindigkeitsbegrenzung', () => {
  const stops = [
    stopover(S.berlin, { dep: T(10, 0), depDelay: 4000 }),
    stopover(S.hamburg, { arr: T(10, 10), arrDelay: 4000 }), // 255 km in 10 min → unrealistisch
  ];
  // Plan + Verspätung: Abfahrt 11:06:40, Ankunft 11:16:40
  assert.equal(computePosition(makeTrip({ stopovers: stops, polyline: null }), ms(T(10, 5))).state, 'scheduled');
  const p = computePosition(makeTrip({ stopovers: stops, polyline: null }), ms(T(11, 10)));
  assert.equal(p.state, 'en_route');
  assert.equal(p.speedKmh, MAX_SPEED_KMH);
  assert.equal(p.status, 'heavy');
  assert.equal(p.delayMin, 67);
});

test('computePosition: ausgefallene Halte werden übersprungen', () => {
  const stops = baseStopovers();
  stops[1].cancelled = true; // Spandau fällt aus → Berlin–Wittenberge direkt
  const trip = makeTrip({ stopovers: stops });
  const p = computePosition(trip, ms(T(10, 15)));
  assert.equal(p.state, 'en_route');
  assert.equal(p.prevStop.name, 'Berlin Hbf');
  assert.equal(p.nextStop.name, 'Wittenberge');
  assert.equal(p.segmentIndex, 0);
  // 10:15 liegt bei 15/60 der Fahrzeit 10:00–11:00
  assert.ok(Math.abs(p.progress - 0.25) < 1e-9);
  assert.equal(p.source, 'polyline');
});

test('computePosition: Halte ohne Koordinaten werden ignoriert, Zeiten der Nachbarn bleiben', () => {
  const stops = baseStopovers();
  stops[1].stop = { id: '8010404', name: 'Berlin-Spandau', lat: null, lon: null };
  const p = computePosition(makeTrip({ stopovers: stops }), ms(T(10, 15)));
  assert.equal(p.state, 'en_route');
  assert.equal(p.nextStop.name, 'Wittenberge');
});

test('computePosition: fehlende Ankunft/Abfahrt eines Halts wird gegenseitig ergänzt', () => {
  const stops = [
    stopover(S.berlin, { dep: T(10, 0) }),
    stopover(S.wittenberge, { arr: T(11, 0) }), // keine Abfahrt → Abfahrt = Ankunft
    stopover(S.hamburg, { dep: T(11, 55) }), // keine Ankunft → Ankunft = Abfahrt
  ];
  const trip = makeTrip({ stopovers: stops, polyline: null });
  assert.equal(computePosition(trip, ms(T(11, 0))).state, 'en_route'); // Abfahrt = Ankunft → kein Halt-Intervall
  assert.equal(computePosition(trip, ms(T(11, 30))).nextStop.name, 'Hamburg Hbf');
  assert.equal(computePosition(trip, ms(T(11, 55))).state, 'finished');
});

test('computePosition: Halt ohne jede Zeit wird nach Streckenanteil interpoliert', () => {
  const stops = [
    stopover(S.berlin, { dep: T(10, 0) }),
    stopover(S.wittenberge), // keine Zeiten
    stopover(S.hamburg, { arr: T(12, 0) }),
  ];
  const trip = makeTrip({ stopovers: stops, polyline: null });
  // Wittenberge liegt bei ca. 47 % der Luftlinien-Strecke → Zeit ≈ 10:56
  const p = computePosition(trip, ms(T(10, 30)));
  assert.equal(p.state, 'en_route');
  assert.equal(p.nextStop.name, 'Wittenberge');
  const q = computePosition(trip, ms(T(11, 30)));
  assert.equal(q.prevStop.name, 'Wittenberge');
  assert.equal(q.nextStop.name, 'Hamburg Hbf');
  // Zeiten nur am Ende → Anfang wird fortgeschrieben (Abfahrt = 12:00 → vorher „scheduled“)
  const stops2 = [stopover(S.berlin), stopover(S.hamburg, { arr: T(12, 0) })];
  const r = computePosition(makeTrip({ stopovers: stops2, polyline: null }), ms(T(11, 0)));
  assert.equal(r.state, 'scheduled');
  assert.equal(r.prevStop.name, 'Berlin Hbf');
  assert.equal(computePosition(makeTrip({ stopovers: stops2, polyline: null }), ms(T(12, 0))).state, 'finished');
});

test('computePosition: nicht-monotone Zeiten werden geglättet (kein Absturz, kein Rücksprung)', () => {
  const stops = [
    stopover(S.berlin, { dep: T(10, 0) }),
    stopover(S.spandau, { arr: T(9, 50), dep: T(9, 40) }), // fehlerhafte Upstream-Daten
    stopover(S.hamburg, { arr: T(11, 55) }),
  ];
  const trip = makeTrip({ stopovers: stops, polyline: null });
  const p = computePosition(trip, ms(T(10, 0, 30)));
  assert.equal(p.state, 'en_route');
  assert.equal(p.prevStop.name, 'Berlin-Spandau'); // Spandau-Zeiten auf 10:00 angehoben
  assert.equal(computePosition(trip, ms(T(9, 45))).state, 'scheduled');
});

test('computePosition: keine Zeitinformation → unknown am Startbahnhof', () => {
  const stops = [stopover(S.berlin), stopover(S.hamburg)];
  const p = computePosition(makeTrip({ stopovers: stops, polyline: null }), ms(T(10, 0)));
  assert.equal(p.state, 'unknown');
  assert.equal(p.status, 'unknown');
  assert.equal(p.delaySec, null);
  assert.equal(p.delayMin, null);
  assert.equal(p.speedKmh, null);
  assert.ok(near([p.lon, p.lat], S.berlin));
  assert.equal(p.nextStop.name, 'Hamburg Hbf');
});

test('computePosition: ganz ausgefallene Fahrt → cancelled am letzten bekannten Halt', () => {
  const trip = makeTrip({ cancelled: true });
  const before = computePosition(trip, ms(T(9, 0)));
  assert.equal(before.state, 'cancelled');
  assert.equal(before.status, 'cancelled');
  assert.ok(near([before.lon, before.lat], S.berlin));
  assert.equal(before.nextStop.name, 'Berlin-Spandau');
  const mid = computePosition(trip, ms(T(11, 5)));
  assert.equal(mid.state, 'cancelled');
  assert.ok(near([mid.lon, mid.lat], S.wittenberge), 'letzter erreichter Halt Wittenberge');
  assert.equal(mid.prevStop.name, 'Wittenberge');
  assert.equal(mid.speedKmh, 0);
  const end = computePosition(trip, ms(T(13, 0)));
  assert.ok(near([end.lon, end.lat], S.hamburg));
  assert.equal(end.nextStop, null);

  // alle Halte ausgefallen, Trip-Flag fehlt
  const stops = baseStopovers().map((s) => ({ ...s, cancelled: true }));
  const all = computePosition(makeTrip({ stopovers: stops }), ms(T(10, 30)));
  assert.equal(all.state, 'cancelled');

  // Teilausfall (nur letzter Halt ausgefallen): Fahrt endet in Ludwigslust
  const partial = baseStopovers();
  partial[4].cancelled = true;
  const pp = computePosition(makeTrip({ stopovers: partial }), ms(T(11, 40)));
  assert.equal(pp.state, 'finished');
  assert.equal(pp.prevStop.name, 'Ludwigslust');
  assert.equal(pp.status, 'on_time');
});

test('computePosition: ohne Halteliste werden Start/Ziel aus dem Trip genutzt', () => {
  const trip = makeTrip({ stopovers: [], polyline: null });
  const p = computePosition(trip, ms(T(10, 57, 30)));
  assert.equal(p.state, 'en_route');
  assert.ok(Math.abs(p.progress - 0.5) < 1e-6);
  assert.equal(p.prevStop.name, 'Berlin Hbf');
  assert.equal(p.nextStop.name, 'Hamburg Hbf');
  assert.equal(p.nextStopPlannedArrival, T(11, 55));
  const trip2 = makeTrip({ stopovers: [], polyline: null, departure: T(10, 30), departureDelaySec: 1800 });
  assert.equal(computePosition(trip2, ms(T(10, 15))).state, 'scheduled');
  assert.equal(computePosition(trip2, ms(T(10, 15))).status, 'delayed');
});

test('computePosition: ungültige Eingaben → null', () => {
  assert.equal(computePosition(null, 1), null);
  assert.equal(computePosition('x', 1), null);
  assert.equal(computePosition(makeTrip(), NaN), null);
  assert.equal(computePosition(makeTrip(), '2026'), null);
  const noCoords = makeTrip({ stopovers: [stopover({ id: null, name: 'x', lat: null, lon: null }, { dep: T(10, 0) })] });
  assert.equal(computePosition(noCoords, ms(T(10, 0))), null);
  const cancelledNoCoords = makeTrip({ cancelled: true, stopovers: [stopover({ id: null, name: 'x', lat: null, lon: null })] });
  assert.equal(computePosition(cancelledNoCoords, ms(T(10, 0))), null);
  assert.equal(computePosition({ id: 'leer' }, ms(T(10, 0))), null);
});

test('computePosition: Geometrie-Cache verhindert wiederholte Korridor-Berechnung', () => {
  let calls = 0;
  const routeBetween = (a, b) => { calls++; return [[a.lon, a.lat], [b.lon, b.lat]]; };
  const cache = createGeometryCache();
  assert.ok(cache instanceof WeakMap);
  const trip = makeTrip({ polyline: null });
  computePosition(trip, ms(T(10, 5)), { routeBetween, geometryCache: cache });
  computePosition(trip, ms(T(10, 6)), { routeBetween, geometryCache: cache });
  assert.equal(calls, 4, 'nur ein Aufbau (4 Segmente)');
  assert.ok(cache.has(trip));
  // neues Trip-Objekt (Refresh) → neue Geometrie
  computePosition(makeTrip({ polyline: null }), ms(T(10, 6)), { routeBetween, geometryCache: cache });
  assert.equal(calls, 8);
  // auch ein Map-ähnliches Objekt funktioniert; ungeeignete Objekte werden ignoriert
  const map = new Map();
  computePosition(trip, ms(T(10, 6)), { routeBetween, geometryCache: map });
  computePosition(trip, ms(T(10, 6)), { routeBetween, geometryCache: map });
  assert.equal(calls, 12);
  assert.equal(map.size, 1);
  computePosition(trip, ms(T(10, 6)), { routeBetween, geometryCache: {} });
  assert.equal(calls, 16);
});

test('computePosition: Position liegt stets auf der Strecke und bewegt sich monoton', () => {
  const trip = makeTrip();
  const g = buildTrackGeometry(trip);
  let lastAlong = -1;
  for (let t = ms(T(9, 55)); t <= ms(T(12, 0)); t += 60_000) {
    const p = computePosition(trip, t);
    assert.ok(p, 'Position erwartet');
    // Punkt darf max. wenige Meter von der Polyline entfernt liegen
    const best = nearestPointOnLine(g.coords, [p.lon, p.lat], g.cum).distanceM;
    assert.ok(best < 20, `Abstand zur Polyline ${best} m`);
    const along = p.segmentIndex + p.progress;
    assert.ok(along >= lastAlong - 1e-9, `Rücksprung bei ${new Date(t).toISOString()}`);
    lastAlong = along;
  }
});

// ---------------------------------------------------------------------------
// tripToFeature
// ---------------------------------------------------------------------------

test('tripToFeature: GeoJSON-Feature mit den vereinbarten Properties', () => {
  const trip = makeTrip();
  const position = computePosition(trip, ms(T(10, 30)));
  const f = tripToFeature(trip, position);
  assert.equal(f.type, 'Feature');
  assert.equal(f.id, trip.id);
  assert.equal(f.geometry.type, 'Point');
  assert.equal(f.geometry.coordinates.length, 2);
  assert.ok(Math.abs(f.geometry.coordinates[0] - position.lon) < 1e-5);
  assert.ok(Math.abs(f.geometry.coordinates[1] - position.lat) < 1e-5);
  const p = f.properties;
  assert.deepEqual(Object.keys(p).sort(), [
    'bearing', 'cancelled', 'delayMin', 'delaySec', 'destination', 'direction', 'fahrtNr', 'hasPolyline', 'line',
    'loadFactor', 'nextStop', 'nextStopArrival', 'nextStopId', 'nextStopPlannedArrival', 'operator', 'origin',
    'prevStop', 'product', 'productName', 'remarkCount', 'source', 'speedKmh', 'state', 'status', 'tripId',
    'updatedAt', 'warningCount',
  ]);
  assert.equal(p.tripId, trip.id);
  assert.equal(p.line, 'ICE 703');
  assert.equal(p.product, 'nationalExpress');
  assert.equal(p.productName, 'ICE');
  assert.equal(p.fahrtNr, '703');
  assert.equal(p.operator, 'DB Fernverkehr AG');
  assert.equal(p.direction, 'Hamburg Hbf');
  assert.equal(p.origin, 'Berlin Hbf');
  assert.equal(p.destination, 'Hamburg Hbf');
  assert.equal(p.state, 'en_route');
  assert.equal(p.status, 'on_time');
  assert.equal(p.delaySec, 0);
  assert.equal(p.delayMin, 0);
  assert.equal(p.prevStop, 'Berlin-Spandau');
  assert.equal(p.nextStop, 'Wittenberge');
  assert.equal(p.nextStopId, '8010382');
  assert.equal(p.nextStopPlannedArrival, T(11, 0));
  assert.equal(p.nextStopArrival, null);
  assert.equal(typeof p.bearing, 'number');
  assert.equal(typeof p.speedKmh, 'number');
  assert.equal(p.source, 'polyline');
  assert.equal(p.cancelled, false);
  assert.equal(p.loadFactor, 'high');
  assert.equal(p.updatedAt, new Date(ms(T(10, 30))).toISOString());
  assert.equal(p.hasPolyline, true);
  assert.equal(p.remarkCount, 2);
  assert.equal(p.warningCount, 1);
});

test('tripToFeature: fehlende Felder defensiv, ausgefallene Fahrt, ungültige Eingaben', () => {
  const trip = makeTrip({
    polyline: null, remarks: 'kaputt', realtimeDataUpdatedAt: null, fetchedAt: ms(T(10, 31)),
    loadFactor: null, operator: undefined, origin: null, destination: undefined, cancelled: true,
  });
  const position = computePosition(trip, ms(T(10, 30)));
  const f = tripToFeature(trip, position);
  assert.equal(f.properties.hasPolyline, false);
  assert.equal(f.properties.remarkCount, 0);
  assert.equal(f.properties.warningCount, 0);
  assert.equal(f.properties.origin, null);
  assert.equal(f.properties.destination, null);
  assert.equal(f.properties.operator, null);
  assert.equal(f.properties.loadFactor, null);
  assert.equal(f.properties.cancelled, true);
  assert.equal(f.properties.status, 'cancelled');
  assert.equal(f.properties.updatedAt, new Date(ms(T(10, 31))).toISOString());

  const noTime = makeTrip({ realtimeDataUpdatedAt: 'x', fetchedAt: null });
  assert.equal(tripToFeature(noTime, computePosition(noTime, ms(T(10, 30)))).properties.updatedAt, null);

  assert.equal(tripToFeature(trip, null), null);
  assert.equal(tripToFeature(null, position), null);
  assert.equal(tripToFeature(trip, { lon: 500, lat: 1 }), null);
  assert.equal(tripToFeature(trip, 'pos'), null);
});

test('tripToFeature: Feature ist JSON-serialisierbar und Luftlinie hat plausible Länge', () => {
  const trip = makeTrip({ polyline: null });
  const f = tripToFeature(trip, computePosition(trip, ms(T(10, 30))));
  const json = JSON.parse(JSON.stringify(f));
  assert.equal(json.id, trip.id);
  const g = buildTrackGeometry(trip);
  const km = lineLengthM(g.coords) / 1000;
  assert.ok(km > 240 && km < 300, `Länge ${km}`);
});
