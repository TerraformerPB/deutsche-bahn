#!/usr/bin/env node
/**
 * Demo-Betrieb ohne Internet: startet den Mock-Upstream (transport.rest, Bright Sky,
 * Open-Meteo, Kartenserver-Style) auf 127.0.0.1:3999 und anschließend die Anwendung
 * mit passender Konfiguration. Aufruf: `npm run demo` → http://127.0.0.1:3000
 */
import { createMockUpstream } from './mock-upstream.js';

const mockPort = Number.parseInt(process.env.MOCK_PORT || '3999', 10);
const mock = createMockUpstream();
const base = await mock.listen(mockPort, '127.0.0.1');

const defaults = {
  DEMO_MODE: 'true',
  NODE_ENV: 'development',
  LOG_FORMAT: 'pretty',
  TRANSPORT_API_BASE_URL: base,
  BRIGHTSKY_BASE_URL: base,
  OPEN_METEO_BASE_URL: base,
  MAP_STYLE_URL: `${base}/style/style.json`,
  UPSTREAM_MAX_RPM: '600',
  HUB_POLL_INTERVAL_SEC: '60',
  TRIP_REFRESH_MIN_SEC: '30',
  WEATHER_REFRESH_SEC: '120',
};
for (const [k, v] of Object.entries(defaults)) {
  if (!process.env[k]) process.env[k] = v;
}
process.stderr.write(`[demo] Mock-Upstream auf ${base} (${mock.trips().size} synthetische Fahrten)\n`);
await import('../src/server.js');
