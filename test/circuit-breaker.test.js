import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker } from '../src/lib/circuit-breaker.js';
import { createFakeClock } from './helpers/fake-clock.js';

function makeBreaker(opts = {}) {
  const clock = createFakeClock();
  const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000, now: clock.now, ...opts });
  return { clock, breaker };
}

class FakeUpstreamError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'FakeUpstreamError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

test('Parameter werden validiert', () => {
  assert.throws(() => createCircuitBreaker({ cooldownMs: 0 }), RangeError);
  assert.throws(() => createCircuitBreaker({}), RangeError);
  assert.throws(() => createCircuitBreaker({ cooldownMs: 100, failureThreshold: 0 }), RangeError);
  assert.throws(() => createCircuitBreaker({ cooldownMs: 100, failureThreshold: 1.5 }), RangeError);
  assert.throws(() => createCircuitBreaker({ cooldownMs: 100, halfOpenMax: 0 }), RangeError);
  assert.throws(() => createCircuitBreaker({ cooldownMs: 100, now: null }), TypeError);
});

test('closed: Fehler unter der Schwelle, Erfolg setzt Zähler zurück', () => {
  const { breaker } = makeBreaker();
  assert.equal(breaker.state(), 'closed');
  assert.equal(breaker.canRequest(), true);
  breaker.recordFailure(new Error('a'));
  breaker.recordFailure(new Error('b'));
  assert.equal(breaker.state(), 'closed');
  assert.equal(breaker.snapshot().failures, 2);
  breaker.recordSuccess();
  assert.equal(breaker.snapshot().failures, 0);
  breaker.recordFailure(new Error('c'));
  breaker.recordFailure(new Error('d'));
  assert.equal(breaker.state(), 'closed', 'Zähler wurde durch Erfolg zurückgesetzt');
  const s = breaker.snapshot();
  assert.equal(s.totalFailures, 4);
  assert.equal(s.totalSuccesses, 1);
  assert.equal(s.lastSuccessAt, 1_700_000_000_000);
});

test('öffnet nach failureThreshold Fehlern und blockiert während der Abkühlzeit', () => {
  const { clock, breaker } = makeBreaker();
  const t0 = clock.now();
  breaker.recordFailure(new FakeUpstreamError('Serverfehler', 'UPSTREAM_ERROR', 502));
  breaker.recordFailure(new FakeUpstreamError('Timeout', 'UPSTREAM_TIMEOUT', 504));
  clock.advance(1000);
  breaker.recordFailure(new FakeUpstreamError('Timeout', 'UPSTREAM_TIMEOUT', 504));
  assert.equal(breaker.state(), 'open');
  assert.equal(breaker.canRequest(), false);
  assert.equal(breaker.canRequest(), false);
  const s = breaker.snapshot();
  assert.equal(s.state, 'open');
  assert.equal(s.failures, 3);
  assert.equal(s.openedAt, t0 + 1000);
  assert.equal(s.nextTryAt, t0 + 61_000);
  assert.equal(s.opens, 1);
  assert.equal(s.rejected, 2);
  assert.equal(s.lastError.code, 'UPSTREAM_TIMEOUT');
  assert.equal(s.lastError.message, 'Timeout');
  assert.equal(s.lastError.statusCode, 504);
  assert.equal(s.lastError.name, 'FakeUpstreamError');
  assert.equal(s.lastError.at, t0 + 1000);
  assert.equal(s.lastFailureAt, t0 + 1000);
  assert.equal(JSON.stringify(s).includes('stack'), false);
  clock.advance(59_999);
  assert.equal(breaker.canRequest(), false);
});

test('half-open: eine Probe, Erfolg schließt den Kreis', () => {
  const { clock, breaker } = makeBreaker();
  for (let i = 0; i < 3; i++) breaker.recordFailure(new Error('x'));
  clock.advance(60_000);
  assert.equal(breaker.state(), 'half-open');
  assert.equal(breaker.canRequest(), true, 'erste Probe erlaubt');
  assert.equal(breaker.canRequest(), false, 'zweite Probe nicht erlaubt (halfOpenMax=1)');
  assert.equal(breaker.snapshot().halfOpenInFlight, 1);
  breaker.recordSuccess();
  assert.equal(breaker.state(), 'closed');
  const s = breaker.snapshot();
  assert.equal(s.failures, 0);
  assert.equal(s.openedAt, null);
  assert.equal(s.nextTryAt, null);
  assert.equal(s.halfOpenInFlight, 0);
  assert.equal(breaker.canRequest(), true);
});

test('half-open: Fehler öffnet erneut mit neuer Abkühlzeit', () => {
  const { clock, breaker } = makeBreaker({ cooldownMs: 10_000 });
  for (let i = 0; i < 3; i++) breaker.recordFailure(new Error('x'));
  clock.advance(10_000);
  assert.equal(breaker.canRequest(), true);
  const tProbe = clock.now();
  breaker.recordFailure(new Error('immer noch kaputt'));
  assert.equal(breaker.state(), 'open');
  const s = breaker.snapshot();
  assert.equal(s.openedAt, tProbe);
  assert.equal(s.nextTryAt, tProbe + 10_000);
  assert.equal(s.opens, 2);
  assert.equal(breaker.canRequest(), false);
  clock.advance(10_000);
  assert.equal(breaker.state(), 'half-open');
  assert.equal(breaker.canRequest(), true);
});

test('halfOpenMax > 1 erlaubt mehrere Proben', () => {
  const { clock, breaker } = makeBreaker({ halfOpenMax: 2, failureThreshold: 1 });
  breaker.recordFailure(new Error('x'));
  assert.equal(breaker.state(), 'open');
  clock.advance(60_000);
  assert.equal(breaker.canRequest(), true);
  assert.equal(breaker.canRequest(), true);
  assert.equal(breaker.canRequest(), false);
  breaker.recordSuccess();
  assert.equal(breaker.state(), 'closed');
});

test('half-open: hängende Probe ohne Rückmeldung gibt nach Abkühlzeit einen neuen Platz frei', () => {
  const { clock, breaker } = makeBreaker({ cooldownMs: 5000 });
  for (let i = 0; i < 3; i++) breaker.recordFailure(new Error('x'));
  clock.advance(5000);
  assert.equal(breaker.canRequest(), true);
  assert.equal(breaker.canRequest(), false);
  clock.advance(4999);
  assert.equal(breaker.canRequest(), false);
  clock.advance(1);
  assert.equal(breaker.canRequest(), true, 'Probeplatz wieder frei');
  assert.equal(breaker.state(), 'half-open');
});

test('Fehlermeldung im Zustand open verlängert die Sperre nicht', () => {
  const { clock, breaker } = makeBreaker();
  for (let i = 0; i < 3; i++) breaker.recordFailure(new Error('x'));
  const nextTryAt = breaker.snapshot().nextTryAt;
  clock.advance(30_000);
  breaker.recordFailure(new Error('verspätete Meldung'));
  assert.equal(breaker.snapshot().nextTryAt, nextTryAt);
  assert.equal(breaker.snapshot().opens, 1);
  assert.equal(breaker.snapshot().lastError.message, 'verspätete Meldung');
});

test('Erfolgsmeldung im Zustand open schließt den Kreis (verspäteter Erfolg)', () => {
  const { breaker } = makeBreaker();
  for (let i = 0; i < 3; i++) breaker.recordFailure(new Error('x'));
  assert.equal(breaker.state(), 'open');
  breaker.recordSuccess();
  assert.equal(breaker.state(), 'closed');
});

test('onStateChange wird mit (von, nach, snapshot) aufgerufen; Hook-Fehler werden ignoriert', () => {
  const calls = [];
  const { clock, breaker } = makeBreaker({
    failureThreshold: 1,
    onStateChange: (from, to, snap) => {
      calls.push([from, to, snap.state]);
      throw new Error('Hook kaputt');
    },
  });
  breaker.recordFailure(new Error('x'));
  clock.advance(60_000);
  breaker.state();
  breaker.canRequest();
  breaker.recordSuccess();
  assert.deepEqual(calls, [
    ['closed', 'open', 'open'],
    ['open', 'half-open', 'half-open'],
    ['half-open', 'closed', 'closed'],
  ]);
});

test('reset setzt alles zurück', () => {
  const { breaker } = makeBreaker({ failureThreshold: 1 });
  breaker.recordFailure('nur ein String');
  assert.equal(breaker.state(), 'open');
  assert.equal(breaker.snapshot().lastError.message, 'nur ein String');
  breaker.reset();
  assert.equal(breaker.state(), 'closed');
  assert.equal(breaker.snapshot().lastError, null);
  assert.equal(breaker.snapshot().failures, 0);
  assert.equal(breaker.canRequest(), true);
});

test('lastError bei recordFailure ohne Argument', () => {
  const { breaker } = makeBreaker();
  breaker.recordFailure();
  const e = breaker.snapshot().lastError;
  assert.equal(e.code, null);
  assert.match(e.message, /unbekannt/);
  breaker.recordFailure({ code: 'X' });
  assert.equal(breaker.snapshot().lastError.message, '[object Object]');
});

test('Standardwerte: failureThreshold 3, halfOpenMax 1, echte Uhr', () => {
  const breaker = createCircuitBreaker({ cooldownMs: 1000 });
  const s = breaker.snapshot();
  assert.equal(s.failureThreshold, 3);
  assert.equal(s.cooldownMs, 1000);
  assert.equal(s.state, 'closed');
  breaker.recordFailure(new Error('1'));
  breaker.recordFailure(new Error('2'));
  breaker.recordFailure(new Error('3'));
  assert.equal(breaker.state(), 'open');
  assert.ok(Math.abs(breaker.snapshot().nextTryAt - (Date.now() + 1000)) < 200);
});
