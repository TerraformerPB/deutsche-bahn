import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError } from '../public/js/api.js';

test('API: JSON, Fehler und Timeout', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.includes('/api/trains/')) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Fahrt unbekannt' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/status')) return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('abgebrochen'), { name: 'AbortError' }))));
    return new Response(JSON.stringify({ ok: true, url }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const api = createApi({ fetchImpl, timeoutMs: 30 });
  const r = await api.trains({ product: 'nationalExpress', bbox: '' });
  assert.equal(r.url, '/api/trains?product=nationalExpress');
  await assert.rejects(api.train('1|2|3'), (e) => e instanceof ApiError && e.status === 404 && e.code === 'NOT_FOUND' && e.message === 'Fahrt unbekannt');
  await assert.rejects(api.status(), (e) => e instanceof ApiError && e.code === 'TIMEOUT');
  await api.weatherPoint(52.52346, 13.4);
  assert.ok(calls.some((u) => u === '/api/weather/point?lat=52.5235&lon=13.4000'));
  assert.ok(calls.some((u) => u === '/api/trains/1%7C2%7C3'));
});
