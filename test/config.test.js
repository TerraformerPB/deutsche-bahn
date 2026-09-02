import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig, ConfigError } from '../src/config.js';

test('Standardkonfiguration ist gültig und eingefroren', () => {
  const c = loadConfig({});
  assert.equal(c.server.port, 3000);
  assert.equal(c.map.mode, 'vector');
  assert.equal(c.map.styleUrl, 'https://maps.paulbartsch.de/style/style.json');
  assert.deepEqual(c.map.origins, ['https://maps.paulbartsch.de']);
  assert.deepEqual(c.transport.products, ['nationalExpress']);
  assert.ok(c.security.allowedUpstreamOrigins.includes('https://v6.db.transport.rest'));
  assert.ok(c.security.allowedUpstreamOrigins.includes('https://api.brightsky.dev'));
  assert.ok(!c.security.allowedUpstreamOrigins.includes('http://127.0.0.1:8080'));
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.transport));
});

test('Umgebungsvariablen werden geparst und validiert', () => {
  const c = loadConfig({ PORT: '8080', TRACK_PRODUCTS: 'nationalExpress, national', MAP_MODE: 'raster', TRUST_PROXY: '1', WEATHER_PROVIDERS: 'none', LOG_FORMAT: 'pretty' });
  assert.equal(c.server.port, 8080);
  assert.deepEqual(c.transport.products, ['nationalExpress', 'national']);
  assert.equal(c.server.trustProxy, 1);
  assert.equal(c.weather.enabled, false);
  assert.ok(c.security.allowedUpstreamOrigins.includes('http://127.0.0.1:8080'));
  assert.throws(() => loadConfig({ PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ PORT: '70000' }), ConfigError);
  assert.throws(() => loadConfig({ TRACK_PRODUCTS: 'flugzeug' }), ConfigError);
  assert.throws(() => loadConfig({ MAP_STYLE_URL: 'ftp://x' }), ConfigError);
  assert.throws(() => loadConfig({ MAP_STYLE_URL: 'https://user:pw@example.org/style.json' }), ConfigError);
  assert.throws(() => loadConfig({ MAP_EXTRA_ORIGINS: 'https://a.example.org/pfad' }), ConfigError);
  assert.throws(() => loadConfig({ DEMO_MODE: 'vielleicht' }), ConfigError);
  assert.throws(() => loadConfig({ MAP_RASTER_URL_TEMPLATE: 'http://x/{z}/{x}.png' }), ConfigError);
});

test('publicConfig enthält keine internen Upstream-URLs', () => {
  const p = publicConfig(loadConfig({ MAP_MODE: 'raster' }));
  const s = JSON.stringify(p);
  assert.ok(!s.includes('transport.rest'));
  assert.ok(!s.includes('127.0.0.1'));
  assert.equal(p.map.styleUrl, null);
  assert.equal(publicConfig(loadConfig({})).map.styleUrl, 'https://maps.paulbartsch.de/style/style.json');
});
