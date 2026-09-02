import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corridorsGeoJson, createCorridorIndex } from '../src/data/corridors.js';
import { findStation } from '../src/data/stations.js';
import { lineLengthM, isLonLat } from '../src/lib/geo.js';

const st = (name) => {
  const s = findStation(name);
  assert.ok(s, name);
  return { lat: s.lat, lon: s.lon };
};

test('Korridor-GeoJSON ist valide und umfangreich', () => {
  const fc = corridorsGeoJson();
  assert.equal(fc.type, 'FeatureCollection');
  assert.ok(fc.features.length >= 35, `nur ${fc.features.length} Korridore`);
  const ids = new Set();
  for (const f of fc.features) {
    assert.equal(f.geometry.type, 'LineString');
    assert.ok(f.geometry.coordinates.length >= 2);
    for (const c of f.geometry.coordinates) assert.ok(isLonLat(c), `${f.properties.id}: ${c}`);
    assert.ok(['SFS', 'ABS', 'Hauptstrecke'].includes(f.properties.kind), f.properties.kind);
    assert.ok(!ids.has(f.properties.id), `doppelte ID ${f.properties.id}`);
    ids.add(f.properties.id);
  }
});

test('routeBetween Berlin–Hamburg liefert plausible Teilstrecke', () => {
  const idx = createCorridorIndex();
  const line = idx.routeBetween(st('Berlin Hbf'), st('Hamburg Hbf'));
  assert.ok(line, 'kein Korridor gefunden');
  const km = lineLengthM(line) / 1000;
  assert.ok(km > 250 && km < 330, `Länge ${km} km`);
  // Reihenfolge a→b: erster Punkt nahe Berlin, letzter nahe Hamburg
  assert.ok(Math.abs(line[0][0] - 13.37) < 0.1);
  assert.ok(Math.abs(line[line.length - 1][0] - 10.0) < 0.1);
  const back = idx.routeBetween(st('Hamburg Hbf'), st('Berlin Hbf'));
  assert.ok(Math.abs(back[0][0] - 10.0) < 0.1);
});

test('routeBetween für weit entfernte Punkte ohne gemeinsamen Korridor ist null oder verkettet', () => {
  const idx = createCorridorIndex();
  const r = idx.routeBetween(st('Berlin Hbf'), st('München Hbf'));
  if (r !== null) {
    assert.ok(lineLengthM(r) / 1000 > 500);
  }
  assert.equal(idx.routeBetween({ lat: 0, lon: 0 }, st('Berlin Hbf')), null);
  assert.equal(idx.routeBetween({ lat: NaN, lon: 1 }, st('Berlin Hbf')), null);
});

test('nearestCorridor und all', () => {
  const idx = createCorridorIndex();
  const n = idx.nearestCorridor(st('Fulda'));
  assert.ok(n && n.distanceM < 2000, JSON.stringify(n));
  assert.equal(idx.nearestCorridor({ lat: 0, lon: 0 }), null);
  assert.ok(idx.all().length === idx.size());
  assert.ok(idx.all()[0].id);
});

test('Index mit eigener FeatureCollection', () => {
  const fc = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { id: 'a', name: 'A', kind: 'SFS' }, geometry: { type: 'LineString', coordinates: [[10, 50], [10.5, 50], [11, 50]] } },
    { type: 'Feature', properties: { id: 'b', name: 'B', kind: 'ABS' }, geometry: { type: 'LineString', coordinates: [[11, 50], [11, 50.5], [11, 51]] } },
    { type: 'Feature', properties: { id: 'leer' }, geometry: { type: 'Point', coordinates: [1, 1] } },
  ] };
  const idx = createCorridorIndex({ corridors: fc });
  assert.equal(idx.size(), 2);
  const direct = idx.routeBetween({ lon: 10.1, lat: 50.001 }, { lon: 10.9, lat: 50.001 });
  assert.ok(direct && direct.length >= 2);
  const chained = idx.routeBetween({ lon: 10.2, lat: 50 }, { lon: 11, lat: 50.8 });
  assert.ok(chained, 'Verkettung erwartet');
  assert.ok(chained.some((c) => c[0] === 11 && c[1] === 50), 'Verkettungspunkt enthalten');
});
