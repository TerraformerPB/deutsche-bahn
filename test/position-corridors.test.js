/**
 * Integrationstest: Positionsberechnung mit dem echten Korridor-Index (Fallback ohne Polyline).
 * Keine Netzwerkzugriffe – nur lokale Daten (Stationsverzeichnis, Korridor-GeoJSON).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackGeometry, computePosition, tripToFeature } from '../src/transport/position.js';
import { createCorridorIndex } from '../src/data/corridors.js';
import { findStation } from '../src/data/stations.js';
import { lineLengthM, haversineM } from '../src/lib/geo.js';

const stop = (name) => {
  const s = findStation(name);
  assert.ok(s, `Station ${name} nicht gefunden`);
  return { id: s.id, name: s.name, lat: s.lat, lon: s.lon };
};

const T = (h, m) => `2026-09-02T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+02:00`;
const ms = (iso) => Date.parse(iso);

function so(name, arr, dep) {
  return {
    stop: stop(name),
    plannedArrival: arr, arrival: null, arrivalDelaySec: arr ? 0 : null,
    plannedDeparture: dep, departure: null, departureDelaySec: dep ? 0 : null,
    plannedArrivalPlatform: null, arrivalPlatform: null, plannedDeparturePlatform: null, departurePlatform: null,
    cancelled: false, loadFactor: null, remarks: [],
  };
}

function berlinHamburgTrip() {
  return {
    id: '1|654321|0|80|2092026',
    lineName: 'ICE 802', product: 'nationalExpress', productName: 'ICE', fahrtNr: '802', operator: 'DB Fernverkehr AG',
    direction: 'Hamburg-Altona',
    origin: stop('Berlin Hbf'), destination: stop('Hamburg Hbf'),
    plannedDeparture: T(10, 0), departure: null, departureDelaySec: 0,
    plannedArrival: T(11, 50), arrival: null, arrivalDelaySec: 0,
    cancelled: false, loadFactor: null,
    stopovers: [
      so('Berlin Hbf', null, T(10, 0)),
      so('Berlin-Spandau', T(10, 12), T(10, 14)),
      so('Wittenberge', T(10, 55), T(10, 57)),
      so('Ludwigslust', T(11, 12), T(11, 14)),
      so('Hamburg Hbf', T(11, 50), null),
    ],
    remarks: [],
    polyline: null,
    realtimeDataUpdatedAt: ms(T(10, 30)),
    fetchedAt: ms(T(10, 30)),
  };
}

test('Korridor-Fallback: Geometrie Berlin–Hamburg folgt dem Korridor', () => {
  const idx = createCorridorIndex();
  const g = buildTrackGeometry(berlinHamburgTrip(), { routeBetween: idx.routeBetween });
  assert.equal(g.source, 'corridor');
  assert.equal(g.stopIndex.length, 5);
  assert.ok(g.coords.length > 5, 'Korridor-Stützpunkte erwartet');
  const km = lineLengthM(g.coords) / 1000;
  assert.ok(km > 250 && km < 340, `Länge ${km} km`);
  for (let i = 1; i < g.stopIndex.length; i++) assert.ok(g.stopIndex[i] > g.stopIndex[i - 1]);
});

test('Korridor-Fallback: Position unterwegs liegt nahe am Korridor', () => {
  const idx = createCorridorIndex();
  const trip = berlinHamburgTrip();
  const cache = new WeakMap();
  const p = computePosition(trip, ms(T(10, 35)), { routeBetween: idx.routeBetween, geometryCache: cache });
  assert.equal(p.state, 'en_route');
  assert.equal(p.source, 'corridor');
  assert.equal(p.prevStop.name, 'Berlin-Spandau');
  assert.equal(p.nextStop.name, 'Wittenberge');
  const nearest = idx.nearestCorridor({ lat: p.lat, lon: p.lon });
  assert.ok(nearest && nearest.distanceM < 1000, JSON.stringify(nearest));
  // Position zwischen den beiden Halten (grob: westlich von Spandau, östlich von Wittenberge)
  assert.ok(p.lon < 13.2 && p.lon > 11.7, `lon ${p.lon}`);
  assert.ok(p.speedKmh > 60 && p.speedKmh <= 330, `speed ${p.speedKmh}`);
  assert.ok(cache.has(trip));

  const f = tripToFeature(trip, p);
  assert.equal(f.properties.source, 'corridor');
  assert.equal(f.properties.hasPolyline, false);
  assert.ok(haversineM(f.geometry.coordinates, [p.lon, p.lat]) < 1);
});

test('Korridor-Fallback: Halte abseits aller Korridore → Luftlinie ohne Fehler', () => {
  const idx = createCorridorIndex();
  const trip = berlinHamburgTrip();
  trip.stopovers = [
    so('Berlin Hbf', null, T(10, 0)),
    { ...so('Berlin Hbf', T(11, 0), null), stop: { id: 'x', name: 'Nordsee', lat: 54.9, lon: 7.9 } },
  ];
  const g = buildTrackGeometry(trip, { routeBetween: idx.routeBetween });
  assert.equal(g.source, 'linear');
  assert.equal(g.coords.length, 2);
});
