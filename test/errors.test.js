import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError, ValidationError, NotFoundError, UpstreamError, UpstreamTimeoutError, RateLimitedError,
  CircuitOpenError, UpstreamFormatError, toPublicJson, isAppError, httpStatusOf,
} from '../src/lib/errors.js';

test('AppError: Standardwerte, cause und details', () => {
  const cause = new Error('tief');
  const e = new AppError('kaputt', { cause, details: { a: 1 } });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'AppError');
  assert.equal(e.message, 'kaputt');
  assert.equal(e.statusCode, 500);
  assert.equal(e.code, 'INTERNAL');
  assert.equal(e.cause, cause);
  assert.deepEqual(e.details, { a: 1 });

  const plain = new AppError('x');
  assert.equal(plain.cause, undefined);
  assert.equal(plain.details, null);
});

test('AppError: ungültige Statuscodes/Codes/Meldungen werden auf sichere Werte gesetzt', () => {
  assert.equal(new AppError('x', { statusCode: 42 }).statusCode, 500);
  assert.equal(new AppError('x', { statusCode: '404' }).statusCode, 500);
  assert.equal(new AppError('x', { code: '' }).code, 'INTERNAL');
  assert.equal(new AppError('x', { code: 7 }).code, 'INTERNAL');
  assert.equal(new AppError('x', { details: 'nein' }).details, null);
  assert.match(new AppError('').message, /Interner Fehler/);
  assert.match(new AppError(undefined).message, /Interner Fehler/);
});

test('AppError.toJSON enthält keinen Stack', () => {
  const j = JSON.parse(JSON.stringify(new UpstreamError('u', { upstreamStatus: 500 })));
  assert.deepEqual(j, { name: 'UpstreamError', code: 'UPSTREAM_ERROR', statusCode: 502, message: 'u' });
});

test('ValidationError / NotFoundError', () => {
  const v = new ValidationError('bbox ungültig');
  assert.equal(v.statusCode, 400);
  assert.equal(v.code, 'VALIDATION');
  assert.equal(v.name, 'ValidationError');
  assert.ok(v instanceof AppError);
  assert.equal(new ValidationError().message, 'Ungültige Eingabe.');
  assert.equal(new ValidationError('x', { details: { field: 'q' } }).details.field, 'q');

  const n = new NotFoundError();
  assert.equal(n.statusCode, 404);
  assert.equal(n.code, 'NOT_FOUND');
  assert.equal(n.name, 'NotFoundError');
  assert.equal(new NotFoundError('Fahrt unbekannt').message, 'Fahrt unbekannt');
});

test('UpstreamError: upstreamStatus und retryable', () => {
  const e = new UpstreamError('Serverfehler', { upstreamStatus: 503, retryable: true });
  assert.equal(e.statusCode, 502);
  assert.equal(e.code, 'UPSTREAM_ERROR');
  assert.equal(e.upstreamStatus, 503);
  assert.equal(e.retryable, true);
  const d = new UpstreamError();
  assert.equal(d.upstreamStatus, null);
  assert.equal(d.retryable, false);
  assert.equal(new UpstreamError('x', { upstreamStatus: 'abc', retryable: 'ja' }).upstreamStatus, null);
  assert.equal(new UpstreamError('x', { upstreamStatus: 'abc', retryable: 'ja' }).retryable, false);
  // Code kann überschrieben werden (z. B. RESPONSE_TOO_LARGE)
  assert.equal(new UpstreamError('x', { code: 'RESPONSE_TOO_LARGE' }).code, 'RESPONSE_TOO_LARGE');
});

test('UpstreamTimeoutError: 504, wiederholbar, Unterklasse von UpstreamError', () => {
  const e = new UpstreamTimeoutError();
  assert.equal(e.statusCode, 504);
  assert.equal(e.code, 'UPSTREAM_TIMEOUT');
  assert.equal(e.retryable, true);
  assert.equal(e.name, 'UpstreamTimeoutError');
  assert.ok(e instanceof UpstreamError);
  assert.ok(e instanceof AppError);
  assert.match(e.message, /nicht rechtzeitig/);
});

test('RateLimitedError: 503, retryAfterMs normalisiert', () => {
  const e = new RateLimitedError(undefined, { retryAfterMs: 1500.4 });
  assert.equal(e.statusCode, 503);
  assert.equal(e.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(e.upstreamStatus, 429);
  assert.equal(e.retryable, true);
  assert.equal(e.retryAfterMs, 1500);
  assert.ok(e instanceof UpstreamError);
  assert.equal(new RateLimitedError().retryAfterMs, null);
  assert.equal(new RateLimitedError('x', { retryAfterMs: -5 }).retryAfterMs, null);
  assert.equal(new RateLimitedError('x', { retryAfterMs: 'bald' }).retryAfterMs, null);
  assert.equal(new RateLimitedError('x', { retryAfterMs: 0 }).retryAfterMs, 0);
});

test('CircuitOpenError: 503 mit nextTryAt', () => {
  const e = new CircuitOpenError(undefined, { nextTryAt: 1234 });
  assert.equal(e.statusCode, 503);
  assert.equal(e.code, 'CIRCUIT_OPEN');
  assert.equal(e.nextTryAt, 1234);
  assert.equal(e.name, 'CircuitOpenError');
  assert.ok(!(e instanceof UpstreamError));
  assert.equal(new CircuitOpenError().nextTryAt, null);
  assert.equal(new CircuitOpenError('x', { nextTryAt: 'x' }).nextTryAt, null);
});

test('UpstreamFormatError: 502, nicht wiederholbar', () => {
  const e = new UpstreamFormatError();
  assert.equal(e.statusCode, 502);
  assert.equal(e.code, 'UPSTREAM_FORMAT');
  assert.equal(e.retryable, false);
  assert.equal(e.name, 'UpstreamFormatError');
  assert.ok(e instanceof UpstreamError);
  assert.equal(new UpstreamFormatError('kein JSON', { upstreamStatus: 200 }).upstreamStatus, 200);
});

test('toPublicJson: AppError liefert nur code und message', () => {
  const e = new UpstreamError('Die Datenquelle meldet einen Serverfehler.', {
    upstreamStatus: 500,
    details: { url: 'https://intern.example/geheim?x=1' },
    cause: new Error('stack intern'),
  });
  const pub = toPublicJson(e);
  assert.deepEqual(pub, { error: { code: 'UPSTREAM_ERROR', message: 'Die Datenquelle meldet einen Serverfehler.' } });
  assert.equal(Object.keys(pub.error).length, 2);
  assert.ok(!JSON.stringify(pub).includes('intern.example'));
});

test('toPublicJson: fremde Fehler werden vollständig maskiert', () => {
  const pub = toPublicJson(new TypeError('Cannot read properties of undefined /srv/app/x.js'));
  assert.equal(pub.error.code, 'INTERNAL');
  assert.ok(!pub.error.message.includes('/srv/app'));
  assert.match(pub.error.message, /Interner Fehler/);
  assert.deepEqual(toPublicJson('kaputt'), toPublicJson(undefined));
  assert.equal(toPublicJson(null).error.code, 'INTERNAL');
});

test('isAppError / httpStatusOf', () => {
  assert.equal(isAppError(new ValidationError()), true);
  assert.equal(isAppError(new Error('x')), false);
  assert.equal(isAppError(null), false);
  assert.equal(httpStatusOf(new NotFoundError()), 404);
  assert.equal(httpStatusOf(new Error('x')), 500);
  assert.equal(httpStatusOf({ status: 404 }), 404);
  assert.equal(httpStatusOf({ statusCode: 429 }), 429);
  assert.equal(httpStatusOf({ status: 200 }), 500);
  assert.equal(httpStatusOf(undefined), 500);
});
