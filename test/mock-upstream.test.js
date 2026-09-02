import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockUpstream, toBerlinIso, hashString, createRng, berlinMidnight } from '../scripts/mock-upstream.js';

const NOW = Date.parse('2026-09-02T12:00:00+02:00');
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

test('Hilfsfunktionen: Hash, PRNG, Berlin-Zeit', () => {
  assert.equal(hashString('a'), hashString('a'));
  assert.notEqual(hashString('a'), hashString('b'));
  const r1 = createRng(7); const r2 = createRng(7);
  assert.equal(r1(), r2());
  const iso = toBerlinIso(NOW);
  assert.equal(iso, '2026-09-02T12:00:00+02:00');
  assert.equal(toBerlinIso(Date.parse('2026-01-15T10:30:00Z')), '2026-01-15T11:30:00+01:00');
  assert.equal(toBerlinIso(berlinMidnight(NOW)), '2026-09-02T00:00:00+02:00');
});

test('Mock liefert Fahrten, Boards und Trips im transport.rest-Format', async () => {
  const mock = createMockUpstream({ now: () => NOW, seed: 1 });
  const base = await mock.listen(0);
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.ok(health.trips > 100, `nur ${health.trips} Fahrten`);

    const res = await fetch(`${base}/stops/8011160/departures?duration=60&nationalExpress=true&national=false`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.departures));
    assert.ok(body.departures.length > 0, 'keine Abfahrten in Berlin Hbf');
    assert.ok(Number.isInteger(body.realtimeDataUpdatedAt));
    for (const d of body.departures) {
      assert.match(d.tripId, /^1\|\d+\|0\|80\|\d{7,8}$/);
      assert.equal(d.line.product, 'nationalExpress');
      assert.match(d.plannedWhen, ISO_RE);
      if (d.when) assert.match(d.when, ISO_RE);
      assert.ok(d.delay === null || Number.isInteger(d.delay));
      assert.equal(d.stop.id, '8011160');
      assert.ok(typeof d.direction === 'string');
      assert.ok(Array.isArray(d.remarks));
      assert.ok(!('_sort' in d));
    }
    const plannedMs = body.departures.map((d) => Date.parse(d.plannedWhen));
    assert.ok(plannedMs.every((t) => t >= NOW - 1000 && t <= NOW + 60 * 60000));

    const tripId = body.departures[0].tripId;
    const tr = await (await fetch(`${base}/trips/${encodeURIComponent(tripId)}?stopovers=true&remarks=true&polyline=true`)).json();
    assert.equal(tr.trip.id, tripId);
    assert.ok(tr.trip.stopovers.length >= 3);
    assert.ok(tr.trip.stopovers[0].plannedDeparture);
    assert.equal(tr.trip.stopovers[0].plannedArrival, null);
    assert.ok(tr.trip.line.name.startsWith('ICE '));
    if (tr.trip.polyline) {
      assert.equal(tr.trip.polyline.type, 'FeatureCollection');
      assert.ok(tr.trip.polyline.features.length >= 2);
      assert.deepEqual(tr.trip.polyline.features[0].properties, {});
    }
    // Ohne polyline-Parameter keine Polyline
    const tr2 = await (await fetch(`${base}/trips/${encodeURIComponent(tripId)}`)).json();
    assert.ok(!('polyline' in tr2.trip));

    const arr = await (await fetch(`${base}/stops/8000105/arrivals?duration=60`)).json();
    assert.ok(Array.isArray(arr.arrivals));
    if (arr.arrivals.length) assert.ok(arr.arrivals[0].provenance);

    const nf = await fetch(`${base}/trips/unbekannt`);
    assert.equal(nf.status, 404);
    const bad = await fetch(`${base}/stops/1/departures`);
    assert.equal(bad.status, 404);
    const rl = await fetch(`${base}/stops/8011160/departures?simulate=429`);
    assert.equal(rl.status, 429);
    assert.equal(rl.headers.get('retry-after'), '2');

    const loc = await (await fetch(`${base}/locations?query=Hamburg&results=3`)).json();
    assert.equal(loc.length, 3);
    assert.equal(loc[0].type, 'station');
  } finally {
    await mock.close();
  }
});

test('Mock: Wetter-Endpunkte in Bright-Sky- und Open-Meteo-Format, Style', async () => {
  const mock = createMockUpstream({ now: () => NOW });
  const base = await mock.listen(0);
  try {
    const w = await (await fetch(`${base}/current_weather?lat=52.52&lon=13.37`)).json();
    assert.ok(typeof w.weather.temperature === 'number');
    assert.ok(w.weather.icon);
    assert.match(w.weather.timestamp, ISO_RE);
    assert.ok(Array.isArray(w.sources));
    const a = await (await fetch(`${base}/alerts?lat=54.3&lon=10.1`)).json();
    assert.ok(a.alerts.length >= 1);
    assert.equal(a.alerts[0].severity, 'severe');
    const none = await (await fetch(`${base}/alerts?lat=48.1&lon=11.5`)).json();
    assert.equal(none.alerts.length, 0);
    const om = await (await fetch(`${base}/v1/forecast?latitude=52.5,48.1&longitude=13.4,11.5&current=temperature_2m`)).json();
    assert.ok(Array.isArray(om) && om.length === 2);
    assert.ok(Number.isInteger(om[0].current.weather_code));
    const om1 = await (await fetch(`${base}/v1/forecast?latitude=52.5&longitude=13.4`)).json();
    assert.ok(!Array.isArray(om1) && om1.current);
    const bad = await fetch(`${base}/current_weather?lat=x`);
    assert.equal(bad.status, 400);
    const style = await (await fetch(`${base}/style/style.json`)).json();
    assert.equal(style.version, 8);
    assert.ok(style.layers.some((l) => l.type === 'background'));
  } finally {
    await mock.close();
  }
});

test('Mock ist deterministisch bei gleichem Seed', () => {
  const a = createMockUpstream({ now: () => NOW, seed: 5 }).trips();
  const b = createMockUpstream({ now: () => NOW, seed: 5 }).trips();
  const c = createMockUpstream({ now: () => NOW, seed: 6 }).trips();
  assert.deepEqual([...a.keys()], [...b.keys()]);
  assert.notDeepEqual([...a.keys()], [...c.keys()]);
  const delayed = [...a.values()].filter((t) => t.stopovers.some((s) => s.arrivalDelay > 0));
  const cancelled = [...a.values()].filter((t) => t.cancelled);
  assert.ok(delayed.length > 0 && cancelled.length > 0);
});
