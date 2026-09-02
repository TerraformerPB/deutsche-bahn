import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrightSkyProvider, normalizeBrightSkyCurrent, normalizeBrightSkyAlerts } from '../src/weather/brightsky.js';
import { createOpenMeteoProvider, normalizeOpenMeteoItem } from '../src/weather/open-meteo.js';
import { createWeatherService } from '../src/weather/weather-service.js';
import { wmoCodeToIcon, normalizeIcon, iconLabelDe, ICONS } from '../src/weather/icons.js';
import { ICON_NAMES } from '../public/js/weather-icons.js';
import { UpstreamError, UpstreamFormatError } from '../src/lib/errors.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/weather/${n}`, import.meta.url), 'utf8'));
const POINTS = [
  { key: 'berlin', stationId: '8011160', city: 'Berlin', lat: 52.5, lon: 13.4 },
  { key: 'muenchen', stationId: '8000261', city: 'München', lat: 48.1, lon: 11.6 },
];

function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      calls.push(url);
      return { status: 200, data: handler(url), headers: {}, durationMs: 1 };
    },
  };
}

test('Icon-Set stimmt zwischen Backend und Frontend überein', () => {
  assert.deepEqual([...ICONS], [...ICON_NAMES]);
  assert.equal(wmoCodeToIcon(0, true), 'clear-day');
  assert.equal(wmoCodeToIcon(0, false), 'clear-night');
  assert.equal(wmoCodeToIcon(2, false), 'partly-cloudy-night');
  assert.equal(wmoCodeToIcon(45), 'fog');
  assert.equal(wmoCodeToIcon(63), 'rain');
  assert.equal(wmoCodeToIcon(67), 'sleet');
  assert.equal(wmoCodeToIcon(75), 'snow');
  assert.equal(wmoCodeToIcon(95), 'thunderstorm');
  assert.equal(wmoCodeToIcon(99), 'hail');
  assert.equal(wmoCodeToIcon('x'), 'cloudy');
  assert.equal(normalizeIcon('unsinn'), 'cloudy');
  assert.equal(normalizeIcon(null), null);
  assert.equal(iconLabelDe('rain'), 'Regen');
});

test('Bright Sky: Normalisierung und Provider', async () => {
  const w = normalizeBrightSkyCurrent(fx('brightsky-current.json'));
  assert.equal(w.temperature, 16.4);
  assert.equal(w.icon, 'rain');
  assert.equal(w.iconLabel, 'Regen');
  assert.equal(w.windSpeedKmh, 14);
  assert.equal(w.precipitationMm, 2.1);
  assert.equal(w.source.stationName, 'Berlin-Tempelhof');
  assert.throws(() => normalizeBrightSkyCurrent({}), UpstreamFormatError);
  const alerts = normalizeBrightSkyAlerts(fx('brightsky-alerts.json'), Date.parse('2026-09-02T12:00:00+02:00'));
  assert.equal(alerts.length, 1, 'abgelaufene Warnung muss entfernt sein');
  assert.equal(alerts[0].severity, 'severe');
  assert.equal(alerts[0].event, 'STURMBÖEN');
  assert.equal(alerts[0].regionName, 'Stadt Berlin');

  const http = fakeHttp((url) => {
    if (url.includes('/alerts')) return url.includes('lat=52.5') ? fx('brightsky-alerts.json') : { alerts: [], location: null };
    if (url.includes('lat=48.1')) throw new UpstreamError('kaputt', { upstreamStatus: 500, retryable: true });
    return fx('brightsky-current.json');
  });
  const p = createBrightSkyProvider({ httpClient: http, baseUrl: 'https://api.brightsky.dev/', now: () => Date.parse('2026-09-02T12:00:00+02:00') });
  const cur = await p.current(POINTS);
  assert.equal(cur.size, 1, 'Teilausfall wird toleriert');
  assert.ok(cur.get('berlin'));
  const al = await p.alerts(POINTS);
  assert.equal(al.get('berlin').length, 1);
  assert.equal(al.get('muenchen').length, 0);
  assert.ok(http.calls.every((u) => u.startsWith('https://api.brightsky.dev/')));
  const allFail = createBrightSkyProvider({ httpClient: fakeHttp(() => { throw new UpstreamError('down', { upstreamStatus: 503, retryable: true }); }), baseUrl: 'https://x' });
  await assert.rejects(allFail.current(POINTS), UpstreamError);
});

test('Open-Meteo: Normalisierung, Bündelung, Einzelobjekt', async () => {
  const items = fx('open-meteo-multi.json');
  const w = normalizeOpenMeteoItem(items[1]);
  assert.equal(w.icon, 'thunderstorm');
  assert.equal(w.condition, 'thunderstorm');
  assert.equal(w.temperature, 21);
  assert.equal(w.provider, 'open-meteo');
  assert.throws(() => normalizeOpenMeteoItem({}), UpstreamFormatError);
  const http = fakeHttp((url) => (url.includes('latitude=52.5000,48.1000') ? items : fx('open-meteo-single.json')));
  const p = createOpenMeteoProvider({ httpClient: http, baseUrl: 'https://api.open-meteo.com' });
  const cur = await p.current(POINTS);
  assert.equal(cur.size, 2);
  assert.equal(cur.get('berlin').icon, 'partly-cloudy-day');
  assert.equal(http.calls.length, 1);
  assert.match(http.calls[0], /wind_speed_unit=kmh/);
  const single = await p.current([POINTS[0]]);
  assert.equal(single.get('berlin').icon, 'clear-day');
  await assert.rejects(p.current([POINTS[0], POINTS[1], { key: 'x', lat: 1, lon: 1 }]), UpstreamFormatError);
});

test('Wetterdienst: Provider-Kette, Fallback, Warnungen, Stale, Punktabfrage', async () => {
  let t = Date.parse('2026-09-02T12:00:00+02:00');
  const now = () => t;
  let brightskyDown = false;
  const timers = [];
  const bs = {
    name: 'brightsky',
    attribution: 'DWD',
    async current(points) {
      if (brightskyDown) throw new UpstreamError('down', { upstreamStatus: 503, retryable: true });
      return new Map(points.map((p) => [p.key, { icon: 'rain', temperature: 10, provider: 'brightsky' }]));
    },
    async alerts(points) {
      return new Map(points.map((p) => [p.key, p.key === 'berlin' ? [{ id: '1', severity: 'severe' }] : []]));
    },
  };
  const om = {
    name: 'open-meteo',
    attribution: 'OM',
    async current(points) { return new Map(points.map((p) => [p.key, { icon: 'cloudy', temperature: 12, provider: 'open-meteo' }])); },
  };
  const config = { providers: ['brightsky', 'open-meteo'], refreshSec: 600, alerts: true, timeoutMs: 1000, pointQueriesPerMin: 2 };
  const svc = createWeatherService({
    config, httpClient: null, now, points: POINTS, providers: [bs, om],
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl: () => {},
  });
  assert.equal(svc.current().updatedAt, null);
  svc.start();
  assert.equal(timers.length, 1);
  await timers[0].fn();
  let cur = svc.current();
  assert.equal(cur.provider, 'brightsky');
  assert.equal(cur.items.length, 2);
  assert.equal(cur.items[0].weather.temperature, 10);
  assert.equal(cur.items[0].alerts.length, 1);
  assert.equal(cur.items[1].alerts.length, 0);
  assert.equal(cur.stale, false);
  assert.equal(timers.length, 2, 'nächster Lauf geplant');
  assert.equal(timers[1].ms, 600000);

  brightskyDown = true;
  t += 600000;
  await svc.refresh();
  cur = svc.current();
  assert.equal(cur.provider, 'open-meteo', 'Fallback greift');
  assert.equal(cur.items[0].weather.temperature, 12);
  assert.equal(cur.attribution, 'OM');

  const failing = createWeatherService({ config, now, points: POINTS, providers: [{ name: 'x', async current() { throw new Error('nein'); } }], setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} });
  await failing.refresh();
  assert.equal(failing.current().updatedAt, null);
  assert.equal(failing.stats().failures, 1);
  assert.equal(failing.stats().lastError.message, 'nein');

  // Stale: nach mehr als 3 h ohne Erfolg werden Werte gelöscht
  const oneShot = {
    name: 'once',
    calls: 0,
    async current(points) {
      this.calls += 1;
      if (this.calls > 1) throw new Error('weg');
      return new Map(points.map((p) => [p.key, { icon: 'fog', temperature: 1 }]));
    },
  };
  const s2 = createWeatherService({ config, now, points: POINTS, providers: [oneShot], setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} });
  await s2.refresh();
  assert.equal(s2.current().items[0].weather.temperature, 1);
  t += 4 * 3600e3;
  await s2.refresh();
  assert.equal(s2.current().stale, true);
  assert.equal(s2.current().items[0].weather, null);

  // Punktabfrage: Cache-Raster und Budget
  const w1 = await svc.pointWeather(50.1234, 8.6);
  assert.equal(w1.provider, 'open-meteo');
  const w2 = await svc.pointWeather(50.11, 8.61); // gleiche Rasterzelle → Cache
  assert.equal(w2, w1);
  await svc.pointWeather(51.0, 9.0);
  await assert.rejects(svc.pointWeather(53.0, 10.0), (e) => e.statusCode === 429);
  assert.equal(await svc.pointWeather(NaN, 1), null);
  svc.stop();
  assert.equal(svc.stats().enabled, true);
});
