import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStation, searchStations, normalizeStationName, stations, isStationId, stationToLocation } from '../src/data/stations.js';
import { capitals, capitalsGeoJson } from '../src/data/capitals.js';
import { hubs } from '../src/data/hubs.js';

test('Stationsverzeichnis geladen', () => {
  assert.ok(stations.length > 5000);
  assert.ok(isStationId('8011160'));
  assert.ok(!isStationId('12'));
  assert.ok(!isStationId('abc'));
});

test('normalizeStationName gleicht Schreibweisen an', () => {
  assert.equal(normalizeStationName('Frankfurt(Main)Hbf'), normalizeStationName('Frankfurt (Main) Hbf'));
  assert.equal(normalizeStationName('Berlin Hauptbahnhof'), normalizeStationName('Berlin Hbf'));
  assert.equal(normalizeStationName('Köln Hbf'), 'kolnhbf');
  assert.equal(normalizeStationName('Straßburg'), 'strassburg');
});

test('findStation per ID und Name (HAFAS-Schreibweise)', () => {
  assert.equal(findStation('8011160').name, 'Berlin Hauptbahnhof');
  assert.equal(findStation('Berlin Hbf').id, '8011160');
  assert.equal(findStation('Frankfurt(Main)Hbf').id, '8000105');
  assert.equal(findStation('München Hbf').id, '8000261');
  assert.equal(findStation('Celle').id, '8000064');
  assert.equal(findStation('Kassel-Wilhelmshöhe').id, '8003200');
  assert.equal(findStation('Gibt es nicht 123'), null);
  assert.equal(findStation(''), null);
  assert.equal(findStation(null), null);
});

test('searchStations findet Präfixe zuerst', () => {
  const r = searchStations('Hamb', 5);
  assert.ok(r.length > 0);
  assert.ok(r[0].name.startsWith('Hamburg'));
  assert.deepEqual(searchStations('h'), []);
});

test('stationToLocation', () => {
  const l = stationToLocation(findStation('8000105'));
  assert.equal(l.type, 'station');
  assert.equal(l.location.latitude, 50.107145);
});

test('16 Landeshauptstädte mit Koordinaten', () => {
  assert.equal(capitals.length, 16);
  const ids = new Set(capitals.map((c) => c.stateId));
  assert.equal(ids.size, 16);
  for (const c of capitals) {
    assert.ok(c.lat > 47 && c.lat < 55.1, c.city);
    assert.ok(c.lon > 5.8 && c.lon < 15.1, c.city);
    assert.ok(c.stationName);
  }
  assert.equal(capitalsGeoJson().features.length, 16);
});

test('Knotenbahnhöfe aufgelöst, eindeutig und enthalten alle Landeshauptstädte', () => {
  assert.ok(hubs.length >= 80, `nur ${hubs.length} Knoten`);
  assert.equal(new Set(hubs.map((h) => h.id)).size, hubs.length);
  for (const c of capitals) assert.ok(hubs.some((h) => h.id === c.stationId), c.city);
  assert.ok(hubs.filter((h) => h.tier === 1).length >= 25);
});
