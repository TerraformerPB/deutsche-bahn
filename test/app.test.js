import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createApp } from '../src/app.js';
import { createTripStore } from '../src/transport/trip-store.js';
import { normalizeTrip } from '../src/transport/normalize.js';
import { createGeometryCache } from '../src/transport/position.js';
import { NotFoundError, UpstreamError } from '../src/lib/errors.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/transport/trip-ice-polyline.json', import.meta.url), 'utf8'));

function fakeServices(now) {
  const store = createTripStore({ now });
  const trip = normalizeTrip(fixture, { fetchedAt: now() });
  store.upsert(trip, { discoveredVia: 'manual', fetchedAt: now() });
  const boards = new Map([['8011160', {
    stationId: '8011160',
    stationName: 'Berlin Hbf',
    fetchedAt: now(),
    departures: [
      { tripId: trip.id, lineName: 'ICE 1', direction: 'Hamburg', plannedWhen: '2026-09-02T12:00:00+02:00', when: '2026-09-02T12:10:00+02:00', delaySec: 600, platform: '5', plannedPlatform: '4', cancelled: false, remarks: [] },
      { tripId: 'x|2', lineName: 'ICE 2', direction: 'München', plannedWhen: '2026-09-02T12:20:00+02:00', when: null, delaySec: null, platform: null, plannedPlatform: '1', cancelled: true, remarks: [] },
    ],
  }]]);
  const poller = {
    stats: () => ({ running: true, trackedTrips: 1, activeTrips: 1, lastRefreshAt: now() - 30000, upstream: { state: 'closed' }, budget: { rpm: 40 } }),
    getBoard: (id) => boards.get(id) || null,
    requestBoard: async (id) => {
      if (id === '8000105') throw new UpstreamError('Upstream weg', { upstreamStatus: 503, retryable: true });
      return boards.get(id) || { stationId: id, stationName: '', fetchedAt: now(), departures: [] };
    },
    refreshTrip: async (id) => {
      if (id === trip.id) return store.get(id);
      throw new NotFoundError('Fahrt unbekannt');
    },
  };
  const disruptions = { list: () => [{ id: 'abc', category: 'strecke', severity: 'hoch', summary: 'Störung', text: 'Störung zwischen A und B', affectedTrips: [], affectedStops: [], segment: null }] };
  const weather = {
    current: () => ({ updatedAt: now(), provider: 'brightsky', attribution: 'DWD', items: [{ key: '8011160', stationId: '8011160', city: 'Berlin', weather: { icon: 'rain', temperature: 12 }, alerts: [] }] }),
    stats: () => ({ enabled: true, provider: 'brightsky' }),
    pointWeather: async (lat) => (lat > 60 ? null : { icon: 'cloudy', temperature: 9 }),
  };
  let tiles = 0;
  const httpClient = {
    async getBuffer(url) {
      tiles += 1;
      if (url.includes('/9/')) return { status: 200, body: Buffer.from('nicht bild'), contentType: 'text/html' };
      return { status: 200, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' };
    },
    tileCalls: () => tiles,
  };
  return { store, poller, disruptions, weather, httpClient, corridors: { routeBetween: () => null }, geometryCache: createGeometryCache(), trip };
}

async function startApp(env = {}) {
  const config = loadConfig({ NODE_ENV: 'test', RATE_LIMIT_PER_MIN: '1000', ...env });
  const lines = [];
  const logger = createLogger({ level: 'warn', write: (l) => lines.push(l) });
  const now = () => Date.parse('2026-09-02T12:30:00+02:00');
  const services = fakeServices(now);
  const app = createApp({ config, logger, services, now });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, services, lines, close: () => new Promise((r) => server.close(r)) };
}

test('Sicherheitsheader, Startseite, Vendor-Dateien, 404', async () => {
  const { base, close } = await startApp({ MAP_STYLE_URL: 'https://maps.example.org/style/style.json' });
  try {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("script-src 'self'"));
    assert.ok(csp.includes("connect-src 'self' https://maps.example.org"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.ok(r.headers.get('permissions-policy').includes('geolocation=()'));
    assert.equal(r.headers.get('strict-transport-security'), null);
    const v = await fetch(`${base}/vendor/pmtiles.js`);
    assert.equal(v.status, 200);
    assert.match(v.headers.get('cache-control'), /immutable/);
    const nf = await fetch(`${base}/gibt-es-nicht`);
    assert.equal(nf.status, 404);
    const nfApi = await fetch(`${base}/api/gibt-es-nicht`);
    assert.equal(nfApi.status, 404);
    assert.equal((await nfApi.json()).error.code, 'NOT_FOUND');
    const dot = await fetch(`${base}/.env`);
    assert.equal(dot.status, 404);
  } finally {
    await close();
  }
});

test('API-Endpunkte liefern die vertraglichen Formen', async () => {
  const { base, services, close } = await startApp();
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.status, 'ok');
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.ok(Array.isArray(cfg.attributions) && cfg.attributions.length >= 5);
    assert.ok(cfg.disclaimer.includes('Deutschen Bahn AG'));
    assert.ok(!JSON.stringify(cfg.map).includes('transport.rest'), 'keine Upstream-Basis-URL in der Kartenkonfiguration');
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.poller.trackedTrips, 1);
    assert.equal(status.disruptions.count, 1);

    const trains = await (await fetch(`${base}/api/trains?includeScheduled=true&includeFinished=true`)).json();
    assert.equal(trains.type, 'FeatureCollection');
    assert.equal(trains.features.length, 1);
    const p = trains.features[0].properties;
    assert.equal(p.tripId, services.trip.id);
    assert.ok(['scheduled', 'en_route', 'at_stop', 'finished', 'cancelled', 'unknown'].includes(p.state));
    assert.ok('delayMin' in p && 'status' in p && 'nextStop' in p);
    assert.equal(trains.meta.count, 1);
    assert.equal(trains.meta.dataAgeSec, 30);
    const filtered = await (await fetch(`${base}/api/trains?product=national&includeScheduled=true&includeFinished=true`)).json();
    assert.equal(filtered.features.length, 0);
    const bad = await fetch(`${base}/api/trains?bbox=1,2,3`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'VALIDATION');

    const detail = await (await fetch(`${base}/api/trains/${encodeURIComponent(services.trip.id)}`)).json();
    assert.equal(detail.trip.id, services.trip.id);
    assert.ok(!('polyline' in detail.trip));
    assert.equal(detail.polyline.type, 'LineString');
    assert.ok(detail.position && detail.geometry.source);
    const missing = await fetch(`${base}/api/trains/${encodeURIComponent('1|999999|0|80|2092026')}`);
    assert.equal(missing.status, 404);

    const dis = await (await fetch(`${base}/api/disruptions`)).json();
    assert.equal(dis.items.length, 1);

    const st = await (await fetch(`${base}/api/stations`)).json();
    assert.equal(st.capitals.length, 16);
    const berlin = st.capitals.find((c) => c.stationId === '8011160');
    assert.equal(berlin.board.departures, 2);
    assert.equal(berlin.board.delayed, 1);
    assert.equal(berlin.board.cancelled, 1);
    assert.equal(berlin.board.maxDelayMin, 10);
    assert.equal(berlin.weather.icon, 'rain');
    assert.ok(st.hubs.length > 50);

    const search = await (await fetch(`${base}/api/stations/search?q=Fulda`)).json();
    assert.equal(search[0].id, '8000115');
    assert.equal((await fetch(`${base}/api/stations/search?q=F`)).status, 400);

    const dep = await (await fetch(`${base}/api/stations/8011160/departures`)).json();
    assert.equal(dep.station.name, 'Berlin Hauptbahnhof');
    assert.equal(dep.departures.length, 2);
    const depErr = await fetch(`${base}/api/stations/8000105/departures`);
    assert.equal(depErr.status, 502);
    assert.equal((await depErr.json()).error.code, 'UPSTREAM_ERROR');
    assert.equal((await fetch(`${base}/api/stations/1/departures`)).status, 400);

    const wx = await (await fetch(`${base}/api/weather`)).json();
    assert.equal(wx.provider, 'brightsky');
    const pt = await (await fetch(`${base}/api/weather/point?lat=50&lon=8`)).json();
    assert.equal(pt.weather.icon, 'cloudy');
    assert.equal((await fetch(`${base}/api/weather/point?lat=x&lon=8`)).status, 400);

    for (const path of ['/api/corridors', '/api/bundeslaender', '/api/capitals']) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('cache-control'), /max-age=86400/);
      const etag = r.headers.get('etag');
      const r2 = await fetch(`${base}${path}`, { headers: { 'if-none-match': etag } });
      assert.equal(r2.status, 304);
      const body = await r.json();
      assert.equal(body.type, 'FeatureCollection');
    }
    assert.equal((await fetch(`${base}/map/style.json`)).status, 404);
  } finally {
    await close();
  }
});

test('Rate-Limit greift pro Client', async () => {
  const { base, close } = await startApp({ RATE_LIMIT_PER_MIN: '3' });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/api/config`)).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal((await fetch(`${base}/api/health`)).status, 200, 'Health ist ausgenommen');
  } finally {
    await close();
  }
});

test('Raster-Modus: Style und Kachel-Proxy mit Validierung und Cache', async () => {
  const { base, services, close } = await startApp({ MAP_MODE: 'raster', MAP_RASTER_URL_TEMPLATE: 'http://127.0.0.1:8080/raster/{z}/{x}/{y}.png' });
  try {
    const style = await (await fetch(`${base}/map/style.json`)).json();
    assert.equal(style.sources.basemap.tiles[0], '/map/raster/{z}/{x}/{y}.png');
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.map.styleUrl, null);
    const t1 = await fetch(`${base}/map/raster/6/33/21.png`);
    assert.equal(t1.status, 200);
    assert.equal(t1.headers.get('content-type'), 'image/png');
    await fetch(`${base}/map/raster/6/33/21.png`);
    assert.equal(services.httpClient.tileCalls(), 1, 'zweiter Abruf aus dem Cache');
    assert.equal((await fetch(`${base}/map/raster/20/0/0.png`)).status, 400);
    assert.equal((await fetch(`${base}/map/raster/6/99/21.png`)).status, 400);
    const badType = await fetch(`${base}/map/raster/9/1/1.png`);
    assert.equal(badType.status, 502);
    const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
    assert.ok(!csp.includes('maps.paulbartsch.de'), 'im Raster-Modus keine fremden Origins');
  } finally {
    await close();
  }
});

test('Nutzerausgelöste Upstream-Abrufe sind kontingentiert und auf bekannte Fahrten beschränkt', async () => {
  const { base, close } = await startApp({ CLIENT_UPSTREAM_PER_MIN: '1' });
  try {
    // 8011160 ist im Cache (kein Kontingent nötig); Fulda (8000115) und Kassel (8003200) sind nicht gecacht
    assert.equal((await fetch(`${base}/api/stations/8011160/departures`)).status, 200);
    assert.equal((await fetch(`${base}/api/stations/8000115/departures`)).status, 200);
    const limited = await fetch(`${base}/api/stations/8003200/departures`);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
    // Unbekannte Fahrt: 404 ohne Upstream-Abruf
    const unknown = await fetch(`${base}/api/trains/${encodeURIComponent('1|424242|0|80|2092026')}`);
    assert.equal(unknown.status, 404);
  } finally {
    await close();
  }
});
