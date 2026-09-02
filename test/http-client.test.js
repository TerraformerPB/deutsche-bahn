import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, parseRetryAfterMs } from '../src/lib/http-client.js';
import {
  AppError, UpstreamError, UpstreamTimeoutError, RateLimitedError, UpstreamFormatError,
} from '../src/lib/errors.js';
import { createLogger } from '../src/logger.js';

const ORIGIN = 'https://api.example.org';
const URL_OK = `${ORIGIN}/stops/8011160/departures?duration=60&secret=1`;

/** Fake-Fetch, das eine Folge von Antworten (oder Fehlern/Funktionen) abarbeitet und Aufrufe protokolliert. */
function fakeFetch(sequence) {
  const calls = [];
  const queue = Array.isArray(sequence) ? [...sequence] : [sequence];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(url, init);
    if (next instanceof Error) throw next;
    // Statische Response-Objekte werden geklont, da ein Body nur einmal gelesen werden kann.
    return next instanceof Response ? next.clone() : next;
  };
  fn.calls = calls;
  return fn;
}

const json = (obj, init = {}) => new Response(JSON.stringify(obj), {
  status: 200,
  ...init,
  headers: { 'content-type': 'application/json', ...(init.headers || {}) },
});

function makeClient(overrides = {}) {
  const sleeps = [];
  const timers = [];
  const lines = [];
  const logger = createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l)) });
  const client = createHttpClient({
    allowedOrigins: [ORIGIN],
    userAgent: 'test-agent/1.0',
    timeoutMs: 5000,
    maxResponseBytes: 1024,
    retries: 2,
    retryBaseMs: 100,
    random: () => 0.5, // Jitter-Faktor 1.0
    sleep: async (ms) => { sleeps.push(ms); },
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl: () => {},
    logger,
    ...overrides,
  });
  return { client, sleeps, timers, lines };
}

const abortError = () => Object.assign(new Error('Vorgang abgebrochen'), { name: 'AbortError' });

test('Konstruktor validiert Optionen', () => {
  assert.throws(() => createHttpClient({ allowedOrigins: 'https://a.example' }), TypeError);
  assert.throws(() => createHttpClient({ allowedOrigins: ['nicht-eine-url'] }), TypeError);
  assert.throws(() => createHttpClient({ allowedOrigins: ['ftp://a.example'] }), TypeError);
  assert.throws(() => createHttpClient({ allowedOrigins: [ORIGIN], fetchImpl: null }), TypeError);
  assert.throws(() => createHttpClient({ allowedOrigins: [ORIGIN], retries: -1 }), RangeError);
  assert.throws(() => createHttpClient({ allowedOrigins: [ORIGIN], timeoutMs: 0 }), RangeError);
  assert.throws(() => createHttpClient({ allowedOrigins: [ORIGIN], maxResponseBytes: -1 }), RangeError);
  assert.throws(() => createHttpClient({ allowedOrigins: [ORIGIN], retryBaseMs: 0 }), RangeError);
  assert.throws(() => createHttpClient({ allowedOrigins: [ORIGIN], now: 1 }), TypeError);
  // Origins werden normalisiert (Pfad/Slash entfernt)
  const c = createHttpClient({ allowedOrigins: ['https://api.example.org/irgendwas/'], fetchImpl: async () => json({}) });
  assert.deepEqual(c.stats().allowedOrigins, [ORIGIN]);
  assert.equal(c.isAllowed(`${ORIGIN}/x`), true);
});

test('Origin-Allowlist blockiert vor dem Request (SSRF)', async () => {
  const fetchImpl = fakeFetch(json({}));
  const { client, lines } = makeClient({ fetchImpl });
  const cases = [
    'https://evil.example/stops',
    'https://api.example.org:8443/stops',
    'http://api.example.org/stops',
    'https://user:pw@api.example.org/stops',
    'ftp://api.example.org/stops',
    'file:///etc/passwd',
    'keine url',
    '',
    null,
  ];
  for (const url of cases) {
    await assert.rejects(client.getJson(url), (err) => {
      assert.ok(err instanceof AppError, `AppError erwartet für ${url}`);
      assert.equal(err.code, 'SSRF_BLOCKED');
      assert.equal(err.statusCode, 500);
      assert.ok(!err.message.includes('example'), 'Meldung enthält keine URL');
      return true;
    });
    assert.equal(client.isAllowed(url), false);
  }
  assert.equal(fetchImpl.calls.length, 0, 'fetch wurde nie aufgerufen');
  const s = client.stats();
  assert.equal(s.blocked, cases.length);
  assert.equal(s.failures, cases.length);
  assert.equal(s.lastErrorCode, 'SSRF_BLOCKED');
  const warn = lines.find((l) => l.level === 'warn' && l.msg.includes('blockiert'));
  assert.ok(warn);
  assert.equal(warn.code, 'SSRF_BLOCKED');
});

test('Ohne erlaubte Origins wird gewarnt und alles blockiert', async () => {
  const { client, lines } = makeClient({ allowedOrigins: [], fetchImpl: fakeFetch(json({})) });
  assert.ok(lines.some((l) => l.level === 'warn' && /ohne erlaubte Origins/.test(l.msg)));
  await assert.rejects(client.getJson(URL_OK), { code: 'SSRF_BLOCKED' });
});

test('getJson: Erfolg mit Headern, redirect manual, Statistik und Debug-Log ohne Query', async () => {
  const fetchImpl = fakeFetch(json({ departures: [1, 2] }, { headers: { 'x-upstream': 'ja' } }));
  let t = 1_700_000_000_000;
  const { client, lines, timers } = makeClient({ fetchImpl, now: () => (t += 10) });
  const res = await client.getJson(new URL(URL_OK), { headers: { 'X-Extra': 'wert' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { departures: [1, 2] });
  assert.equal(res.headers['x-upstream'], 'ja');
  assert.equal(res.headers['content-type'], 'application/json');
  assert.ok(res.durationMs > 0);

  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, URL_OK);
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal instanceof AbortSignal);
  const h = new Headers(init.headers);
  assert.equal(h.get('user-agent'), 'test-agent/1.0');
  assert.equal(h.get('accept'), 'application/json');
  assert.equal(h.get('x-extra'), 'wert');
  assert.equal(timers.length, 1, 'Timeout-Timer gesetzt');
  assert.equal(timers[0].ms, 5000);

  const dbg = lines.find((l) => l.level === 'debug');
  assert.ok(dbg, 'Debug-Log vorhanden');
  assert.equal(dbg.url, `${ORIGIN}/stops/8011160/departures`);
  assert.equal(dbg.status, 200);
  assert.ok(!JSON.stringify(lines).includes('secret=1'), 'Query-String nie geloggt');

  const s = client.stats();
  assert.equal(s.requests, 1);
  assert.equal(s.successes, 1);
  assert.equal(s.failures, 0);
  assert.equal(s.retries, 0);
  assert.equal(s.inFlight, 0);
  assert.ok(s.bytesReceived > 0);
  assert.ok(s.lastSuccessAt > 0);
});

test('getJson: Timeout pro Anfrage überschreibt Standard', async () => {
  const { client, timers } = makeClient({ fetchImpl: fakeFetch(json({})) });
  await client.getJson(URL_OK, { timeoutMs: 250 });
  assert.equal(timers[0].ms, 250);
  await client.getJson(URL_OK, { timeoutMs: -1 });
  assert.equal(timers[1].ms, 5000, 'ungültiger Wert → Standard');
});

test('3xx wird nicht gefolgt und nicht wiederholt', async () => {
  const fetchImpl = fakeFetch(new Response(null, { status: 302, headers: { location: 'https://anderswo.example/' } }));
  const { client, sleeps } = makeClient({ fetchImpl });
  await assert.rejects(client.getJson(URL_OK), (err) => {
    assert.ok(err instanceof UpstreamError);
    assert.equal(err.code, 'UPSTREAM_REDIRECT');
    assert.equal(err.upstreamStatus, 302);
    assert.equal(err.retryable, false);
    assert.equal(err.statusCode, 502);
    assert.equal(err.details.location, 'https://anderswo.example/');
    assert.ok(!err.message.includes('anderswo'));
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('4xx (außer 429): UpstreamError mit upstreamStatus, kein Retry, Upstream-Text nur in details', async () => {
  const fetchImpl = fakeFetch(json({ error: true, msg: 'stop not found' }, { status: 404 }));
  const { client, sleeps, lines } = makeClient({ fetchImpl });
  await assert.rejects(client.getJson(URL_OK), (err) => {
    assert.ok(err instanceof UpstreamError);
    assert.equal(err.code, 'UPSTREAM_ERROR');
    assert.equal(err.upstreamStatus, 404);
    assert.equal(err.retryable, false);
    assert.equal(err.details.upstreamMessage, 'stop not found');
    assert.ok(!err.message.includes('stop not found'));
    assert.ok(!err.message.includes('example.org'));
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleeps, []);
  const warn = lines.find((l) => l.level === 'warn');
  assert.ok(warn);
  assert.equal(warn.upstreamStatus, 404);
  assert.equal(warn.url, `${ORIGIN}/stops/8011160/departures`);
  assert.equal(client.stats().failures, 1);
  assert.equal(client.stats().lastErrorCode, 'UPSTREAM_ERROR');

  // Nicht-JSON-Fehlertext wird gekürzt übernommen
  const fetch2 = fakeFetch(new Response('Forbidden by proxy', { status: 403 }));
  const c2 = makeClient({ fetchImpl: fetch2 }).client;
  await assert.rejects(c2.getJson(URL_OK), (err) => err.upstreamStatus === 403 && err.details.upstreamMessage === 'Forbidden by proxy');
});

test('5xx wird mit exponentiellem Backoff wiederholt und dann erfolgreich', async () => {
  const fetchImpl = fakeFetch([
    new Response('{"error":true,"msg":"upstream down"}', { status: 503 }),
    new Response('kaputt', { status: 500 }),
    json({ ok: true }),
  ]);
  const { client, sleeps, lines } = makeClient({ fetchImpl });
  const res = await client.getJson(URL_OK);
  assert.deepEqual(res.data, { ok: true });
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleeps, [100, 200]);
  const s = client.stats();
  assert.equal(s.retries, 2);
  assert.equal(s.successes, 1);
  assert.equal(s.failures, 0);
  const retryLogs = lines.filter((l) => l.level === 'warn' && /erneuter Versuch/.test(l.msg));
  assert.equal(retryLogs.length, 2);
  assert.equal(retryLogs[0].retryInMs, 100);
  assert.equal(retryLogs[0].upstreamStatus, 503);
  assert.equal(retryLogs[0].attempt, 1);
});

test('5xx: nach Erschöpfen der Versuche wird der letzte Fehler geworfen', async () => {
  const fetchImpl = fakeFetch(new Response('', { status: 502 }));
  const { client, sleeps } = makeClient({ fetchImpl });
  await assert.rejects(client.getJson(URL_OK), (err) => {
    assert.ok(err instanceof UpstreamError);
    assert.equal(err.upstreamStatus, 502);
    assert.equal(err.retryable, true);
    assert.equal(err.details.upstreamMessage, null);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleeps, [100, 200]);
  assert.equal(client.stats().failures, 1);
  assert.equal(client.stats().retries, 2);
});

test('Backoff: Jitter-Bereich und Obergrenze retryMaxMs', async () => {
  const fetch1 = fakeFetch(new Response('', { status: 500 }));
  const low = makeClient({ fetchImpl: fetch1, random: () => 0, retries: 3, retryBaseMs: 1000, retryMaxMs: 1500 });
  await assert.rejects(low.client.getJson(URL_OK));
  assert.deepEqual(low.sleeps, [500, 750, 750]);

  const fetch2 = fakeFetch(new Response('', { status: 500 }));
  const high = makeClient({ fetchImpl: fetch2, random: () => 0.999999, retries: 2, retryBaseMs: 1000 });
  await assert.rejects(high.client.getJson(URL_OK));
  assert.equal(high.sleeps.length, 2);
  assert.ok(high.sleeps[0] >= 1499 && high.sleeps[0] <= 1500, `Jitter-Obergrenze: ${high.sleeps[0]}`);
  assert.ok(high.sleeps[1] >= 2999 && high.sleeps[1] <= 3000, `Jitter-Obergrenze: ${high.sleeps[1]}`);
});

test('retryable:false unterdrückt Wiederholungen', async () => {
  const fetchImpl = fakeFetch(new Response('', { status: 500 }));
  const { client, sleeps } = makeClient({ fetchImpl });
  await assert.rejects(client.getJson(URL_OK, { retryable: false }), { upstreamStatus: 500 });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('retries: 0 → genau ein Versuch', async () => {
  const fetchImpl = fakeFetch(new Response('', { status: 500 }));
  const { client } = makeClient({ fetchImpl, retries: 0 });
  await assert.rejects(client.getJson(URL_OK));
  assert.equal(fetchImpl.calls.length, 1);
});

test('429 mit kurzem Retry-After wird nach der angegebenen Zeit wiederholt', async () => {
  const fetchImpl = fakeFetch([
    json({ error: true, msg: 'rate limited' }, { status: 429, headers: { 'retry-after': '2' } }),
    json({ ok: 1 }),
  ]);
  const { client, sleeps } = makeClient({ fetchImpl });
  const res = await client.getJson(URL_OK);
  assert.deepEqual(res.data, { ok: 1 });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(client.stats().rateLimited, 1);
  assert.equal(client.stats().retries, 1);
});

test('429 ohne Retry-After wird sofort als RateLimitedError geworfen', async () => {
  const fetchImpl = fakeFetch(json({ error: true, msg: 'rate limited' }, { status: 429 }));
  const { client, sleeps } = makeClient({ fetchImpl });
  await assert.rejects(client.getJson(URL_OK), (err) => {
    assert.ok(err instanceof RateLimitedError);
    assert.equal(err.statusCode, 503);
    assert.equal(err.code, 'UPSTREAM_RATE_LIMITED');
    assert.equal(err.retryAfterMs, null);
    assert.equal(err.upstreamStatus, 429);
    assert.equal(err.details.upstreamMessage, 'rate limited');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(client.stats().lastErrorCode, 'UPSTREAM_RATE_LIMITED');
});

test('429 mit langem Retry-After wird nicht wiederholt, retryAfterMs bleibt erhalten', async () => {
  const fetchImpl = fakeFetch(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  const { client } = makeClient({ fetchImpl });
  await assert.rejects(client.getJson(URL_OK), (err) => err instanceof RateLimitedError && err.retryAfterMs === 60_000);
  assert.equal(fetchImpl.calls.length, 1);
});

test('Retry-After als HTTP-Datum wird relativ zu now() berechnet', async () => {
  const now = 1_700_000_000_000;
  const date = new Date(now + 3000).toUTCString();
  const fetchImpl = fakeFetch([
    new Response('', { status: 429, headers: { 'retry-after': date } }),
    json({}),
  ]);
  const { client, sleeps } = makeClient({ fetchImpl, now: () => now });
  await client.getJson(URL_OK);
  assert.deepEqual(sleeps, [3000]);
});

test('parseRetryAfterMs', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseRetryAfterMs('5', now), 5000);
  assert.equal(parseRetryAfterMs(' 0 ', now), 0);
  assert.equal(parseRetryAfterMs('', now), null);
  assert.equal(parseRetryAfterMs(null, now), null);
  assert.equal(parseRetryAfterMs('bald', now), null);
  assert.equal(parseRetryAfterMs('999999999999', now), null, 'zu viele Ziffern → unbrauchbar');
  assert.equal(parseRetryAfterMs('999999999', now), 24 * 3600 * 1000, 'Deckelung auf 24 h');
  assert.equal(parseRetryAfterMs(new Date(now - 5000).toUTCString(), now), 0, 'Datum in der Vergangenheit → 0');
  assert.equal(parseRetryAfterMs(new Date(now + 10_000).toUTCString(), now), 10_000);
});

test('Timeout (Fake-Timer): Abbruch über AbortController → UpstreamTimeoutError, wird wiederholt', async () => {
  let resolveSecond;
  const fetchImpl = fakeFetch([
    (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(abortError()));
    }),
    () => new Promise((resolve) => { resolveSecond = () => resolve(json({ nach: 'timeout' })); }),
  ]);
  const { client, timers, sleeps } = makeClient({ fetchImpl, retries: 1 });
  const p = client.getJson(URL_OK);
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.length, 1);
  timers[0].fn(); // Timeout auslösen
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchImpl.calls.length, 2, 'zweiter Versuch gestartet');
  assert.ok(fetchImpl.calls[0].init.signal.aborted);
  resolveSecond();
  const res = await p;
  assert.deepEqual(res.data, { nach: 'timeout' });
  assert.deepEqual(sleeps, [100]);
  assert.equal(client.stats().timeouts, 1);
  assert.equal(client.stats().retries, 1);
});

test('Timeout ohne Wiederholung liefert 504 mit Code UPSTREAM_TIMEOUT', async () => {
  const fetchImpl = fakeFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(abortError()));
  }));
  const { client, timers } = makeClient({ fetchImpl, retries: 0 });
  const p = client.getJson(URL_OK);
  await new Promise((r) => setImmediate(r));
  timers[0].fn();
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof UpstreamTimeoutError);
    assert.equal(err.statusCode, 504);
    assert.equal(err.code, 'UPSTREAM_TIMEOUT');
    assert.equal(err.details.timeoutMs, 5000);
    return true;
  });
  assert.equal(client.stats().timeouts, 1);
  assert.equal(client.stats().failures, 1);
});

test('Timeout mit echten Timern (Standard-setTimeout, unref)', async () => {
  const fetchImpl = fakeFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(abortError()));
  }));
  const client = createHttpClient({ allowedOrigins: [ORIGIN], fetchImpl, timeoutMs: 20, retries: 0 });
  // Der Timeout-Timer ist bewusst unref()t; im echten Betrieb hält der Socket die Event-Loop offen,
  // hier übernimmt das ein Keep-Alive-Timer.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const start = Date.now();
    await assert.rejects(client.getJson(URL_OK), UpstreamTimeoutError);
    assert.ok(Date.now() - start < 2000);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('Timeout während des Lesens des Bodys', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"teil":'));
        init.signal.addEventListener('abort', () => controller.error(abortError()));
      },
    });
    return new Response(stream, { status: 200 });
  });
  const { client, timers } = makeClient({ fetchImpl, retries: 0 });
  const p = client.getJson(URL_OK);
  await new Promise((r) => setImmediate(r));
  timers[0].fn();
  await assert.rejects(p, UpstreamTimeoutError);
});

test('Netzwerkfehler wird als UPSTREAM_NETWORK wiederholt', async () => {
  const fetchImpl = fakeFetch([new TypeError('fetch failed'), json({ ok: true })]);
  const { client, sleeps } = makeClient({ fetchImpl });
  const res = await client.getJson(URL_OK);
  assert.deepEqual(res.data, { ok: true });
  assert.deepEqual(sleeps, [100]);

  const fetch2 = fakeFetch(new TypeError('fetch failed'));
  const c2 = makeClient({ fetchImpl: fetch2, retries: 0 }).client;
  await assert.rejects(c2.getJson(URL_OK), (err) => {
    assert.ok(err instanceof UpstreamError);
    assert.equal(err.code, 'UPSTREAM_NETWORK');
    assert.equal(err.retryable, true);
    assert.equal(err.cause.message, 'fetch failed');
    assert.ok(!err.message.includes('fetch failed'));
    return true;
  });
});

test('Fehler beim Lesen des Bodys (kein Abbruch) wird als Netzwerkfehler behandelt', async () => {
  const fetchImpl = fakeFetch(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
      controller.error(new Error('ECONNRESET'));
    },
  }), { status: 200 }));
  const { client } = makeClient({ fetchImpl, retries: 0 });
  await assert.rejects(client.getJson(URL_OK), { code: 'UPSTREAM_NETWORK', retryable: true });
});

test('Content-Length über dem Limit → RESPONSE_TOO_LARGE, kein Retry', async () => {
  const fetchImpl = fakeFetch(new Response('abc', { status: 200, headers: { 'content-length': '999999' } }));
  const { client, sleeps } = makeClient({ fetchImpl });
  await assert.rejects(client.getJson(URL_OK), (err) => {
    assert.ok(err instanceof UpstreamError);
    assert.equal(err.code, 'RESPONSE_TOO_LARGE');
    assert.equal(err.retryable, false);
    assert.equal(err.details.declaredBytes, 999999);
    assert.equal(err.details.limit, 1024);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('Gestreamter Body über dem Limit → RESPONSE_TOO_LARGE und Stream wird abgebrochen', async () => {
  let cancelled = false;
  const fetchImpl = fakeFetch(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(600));
      controller.enqueue(new Uint8Array(600));
      controller.enqueue(new Uint8Array(600));
      controller.close();
    },
    cancel() { cancelled = true; },
  }), { status: 200 }));
  const { client } = makeClient({ fetchImpl });
  await assert.rejects(client.getJson(URL_OK), (err) => {
    assert.equal(err.code, 'RESPONSE_TOO_LARGE');
    assert.equal(err.details.readBytes, 1200);
    return true;
  });
  assert.equal(cancelled, true, 'Stream wurde abgebrochen');
  assert.equal(client.stats().failures, 1);
});

test('maxResponseBytes pro Anfrage überschreibbar', async () => {
  const fetchImpl = fakeFetch(json({ a: 1 }));
  const { client } = makeClient({ fetchImpl });
  await assert.rejects(client.getJson(URL_OK, { maxResponseBytes: 3 }), { code: 'RESPONSE_TOO_LARGE' });
  const res = await client.getJson(URL_OK, { maxResponseBytes: 1_000_000 });
  assert.deepEqual(res.data, { a: 1 });
});

test('Ungültiges JSON → UpstreamFormatError, kein Retry', async () => {
  const fetchImpl = fakeFetch(new Response('<html>Wartungsseite</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  const { client, sleeps, lines } = makeClient({ fetchImpl });
  await assert.rejects(client.getJson(URL_OK), (err) => {
    assert.ok(err instanceof UpstreamFormatError);
    assert.equal(err.statusCode, 502);
    assert.equal(err.code, 'UPSTREAM_FORMAT');
    assert.equal(err.upstreamStatus, 200);
    assert.equal(err.details.contentType, 'text/html');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(client.stats().formatErrors, 1);
  assert.equal(client.stats().failures, 1);
  assert.equal(client.stats().successes, 0);
  assert.ok(lines.some((l) => l.level === 'warn' && l.code === 'UPSTREAM_FORMAT'));
});

test('Leerer Body → UpstreamFormatError; BOM wird toleriert', async () => {
  const { client } = makeClient({ fetchImpl: fakeFetch(new Response('', { status: 200 })) });
  await assert.rejects(client.getJson(URL_OK), (err) => err instanceof UpstreamFormatError && /leere Antwort/.test(err.message));
  const c2 = makeClient({ fetchImpl: fakeFetch(new Response('﻿{"bom":true}', { status: 200 })) }).client;
  assert.deepEqual((await c2.getJson(URL_OK)).data, { bom: true });
  const c3 = makeClient({ fetchImpl: fakeFetch(new Response(null, { status: 204 })) }).client;
  await assert.rejects(c3.getJson(URL_OK), UpstreamFormatError);
});

test('Ungültiges Antwortobjekt → UpstreamFormatError', async () => {
  const { client } = makeClient({ fetchImpl: fakeFetch(() => ({})) });
  await assert.rejects(client.getJson(URL_OK), UpstreamFormatError);
  const c2 = makeClient({ fetchImpl: fakeFetch(() => null) }).client;
  await assert.rejects(c2.getJson(URL_OK), UpstreamFormatError);
});

test('Antwortobjekt ohne Stream (nur text()/arrayBuffer()) wird unterstützt', async () => {
  const c1 = makeClient({ fetchImpl: fakeFetch(() => ({ status: 200, headers: new Headers(), text: async () => '{"a":1}' })) }).client;
  assert.deepEqual((await c1.getJson(URL_OK)).data, { a: 1 });
  const c2 = makeClient({
    fetchImpl: fakeFetch(() => ({ status: 200, headers: new Headers(), arrayBuffer: async () => new TextEncoder().encode('{"b":2}').buffer })),
  }).client;
  assert.deepEqual((await c2.getJson(URL_OK)).data, { b: 2 });
  const c3 = makeClient({ fetchImpl: fakeFetch(() => ({ status: 200, headers: new Headers(), text: async () => 'x'.repeat(5000) })) }).client;
  await assert.rejects(c3.getJson(URL_OK), { code: 'RESPONSE_TOO_LARGE' });
});

test('Unerwarteter 1xx-Status → UpstreamError ohne Retry', async () => {
  const { client } = makeClient({ fetchImpl: fakeFetch(() => ({ status: 199, headers: new Headers(), body: null })) });
  await assert.rejects(client.getJson(URL_OK), (err) => err instanceof UpstreamError && err.upstreamStatus === 199 && err.retryable === false);
});

test('Nicht-Error-Ausnahme aus fetch wird als Netzwerkfehler behandelt', async () => {
  const fetchImpl = fakeFetch(() => { throw 'kaputt'; }); // eslint-disable-line no-throw-literal
  const { client } = makeClient({ fetchImpl, retries: 0 });
  await assert.rejects(client.getJson(URL_OK), { code: 'UPSTREAM_NETWORK' });
});

test('getBuffer liefert Buffer, Content-Type und akzeptiert beliebige Typen', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fetchImpl = fakeFetch(new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'max-age=60' } }));
  const { client } = makeClient({ fetchImpl });
  const res = await client.getBuffer(`${ORIGIN}/raster/5/16/10.png`);
  assert.equal(res.status, 200);
  assert.ok(Buffer.isBuffer(res.body));
  assert.deepEqual(res.body, png);
  assert.equal(res.contentType, 'image/png');
  assert.equal(res.headers['cache-control'], 'max-age=60');
  assert.equal(typeof res.durationMs, 'number');
  assert.equal(new Headers(fetchImpl.calls[0].init.headers).get('accept'), '*/*');
  assert.equal(new Headers(fetchImpl.calls[0].init.headers).get('user-agent'), 'test-agent/1.0');

  await client.getBuffer(`${ORIGIN}/raster/5/16/10.png`, { accept: 'image/png,image/webp' });
  assert.equal(new Headers(fetchImpl.calls[1].init.headers).get('accept'), 'image/png,image/webp');
  assert.equal(client.stats().bytesReceived, png.length * 2);
});

test('getBuffer: Fehlerpfade (SSRF, 404, zu groß)', async () => {
  const { client } = makeClient({ fetchImpl: fakeFetch(new Response('nein', { status: 404 })) });
  await assert.rejects(client.getBuffer('https://evil.example/x.png'), { code: 'SSRF_BLOCKED' });
  await assert.rejects(client.getBuffer(`${ORIGIN}/x.png`), { code: 'UPSTREAM_ERROR', upstreamStatus: 404 });
  const big = makeClient({ fetchImpl: fakeFetch(() => new Response(new Uint8Array(2048), { status: 200 })) }).client;
  await assert.rejects(big.getBuffer(`${ORIGIN}/x.png`), { code: 'RESPONSE_TOO_LARGE' });
});

test('Standard-sleep nutzt setTimeoutImpl', async () => {
  const fetchImpl = fakeFetch([new Response('', { status: 500 }), json({ ok: 1 })]);
  const timers = [];
  const client = createHttpClient({
    allowedOrigins: [ORIGIN],
    fetchImpl,
    retries: 1,
    retryBaseMs: 100,
    random: () => 0.5,
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); fn(); return timers.length; },
    clearTimeoutImpl: () => {},
  });
  const res = await client.getJson(URL_OK);
  assert.deepEqual(res.data, { ok: 1 });
  // Timer: Timeout (Versuch 1), Sleep (100 ms), Timeout (Versuch 2)
  assert.ok(timers.some((t) => t.ms === 100), 'Backoff-Sleep über setTimeoutImpl');
});

test('Ohne injizierte Timer wartet der Backoff mit echten Timern', async () => {
  const fetchImpl = fakeFetch([new Response('', { status: 500 }), json({ ok: 2 })]);
  const client = createHttpClient({ allowedOrigins: [ORIGIN], fetchImpl, retries: 1, retryBaseMs: 5, random: () => 0.5 });
  const start = Date.now();
  const res = await client.getJson(URL_OK);
  assert.deepEqual(res.data, { ok: 2 });
  assert.ok(Date.now() - start >= 4, 'es wurde tatsächlich gewartet');
  assert.equal(client.stats().retries, 1);
});

test('stats liefert einen Schnappschuss ohne interne Referenzen', () => {
  const { client } = makeClient({ fetchImpl: fakeFetch(json({})) });
  const s = client.stats();
  s.requests = 99;
  s.allowedOrigins.push('https://manipuliert.example');
  assert.equal(client.stats().requests, 0);
  assert.deepEqual(client.stats().allowedOrigins, [ORIGIN]);
});
