import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenBucket } from '../src/lib/token-bucket.js';
import { createFakeClock } from './helpers/fake-clock.js';

function makeBucket(opts = {}) {
  const clock = createFakeClock();
  const bucket = createTokenBucket({
    ratePerMin: 60,
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    ...opts,
  });
  return { clock, bucket };
}

test('Parameter werden validiert', () => {
  assert.throws(() => createTokenBucket({ ratePerMin: 0 }), RangeError);
  assert.throws(() => createTokenBucket({ ratePerMin: -1 }), RangeError);
  assert.throws(() => createTokenBucket({ ratePerMin: 'schnell' }), RangeError);
  assert.throws(() => createTokenBucket({ ratePerMin: 10, burst: 0 }), RangeError);
  assert.throws(() => createTokenBucket({ ratePerMin: 10, now: 5 }), TypeError);
  assert.throws(() => createTokenBucket(), RangeError);
  const { bucket } = makeBucket({ burst: 5 });
  assert.throws(() => bucket.tryTake(0), RangeError);
  assert.throws(() => bucket.tryTake(1.5), RangeError);
  assert.throws(() => bucket.tryTake(6), /Kapazität/);
  assert.throws(() => bucket.msUntilAvailable(-1), RangeError);
});

test('take mit ungültiger Anzahl lehnt als Promise ab', async () => {
  const { bucket } = makeBucket({ burst: 2 });
  await assert.rejects(bucket.take(3), RangeError);
  await assert.rejects(bucket.take(0), RangeError);
});

test('tryTake: voller Eimer zum Start, danach Verweigerung und Nachfüllen', () => {
  const { clock, bucket } = makeBucket({ burst: 3 });
  assert.equal(bucket.available(), 3);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(2), true);
  assert.equal(bucket.tryTake(), false);
  assert.equal(bucket.available(), 0);
  // 60/min = 1 Token je Sekunde
  clock.advance(999);
  assert.equal(bucket.tryTake(), false);
  clock.advance(1);
  assert.equal(bucket.tryTake(), true);
  clock.advance(60_000);
  assert.equal(bucket.available(), 3, 'Kapazität wird nicht überschritten');
  const s = bucket.stats();
  assert.equal(s.taken, 4);
  assert.equal(s.denied, 2);
  assert.equal(s.ratePerMin, 60);
  assert.equal(s.burst, 3);
});

test('burst ist standardmäßig ratePerMin', () => {
  const { bucket } = makeBucket({ ratePerMin: 40 });
  assert.equal(bucket.available(), 40);
  assert.equal(bucket.stats().burst, 40);
});

test('msUntilAvailable rechnet mit der Nachfüllrate', () => {
  const { clock, bucket } = makeBucket({ burst: 5 });
  assert.equal(bucket.msUntilAvailable(), 0);
  assert.equal(bucket.tryTake(5), true);
  assert.equal(bucket.msUntilAvailable(1), 1000);
  assert.equal(bucket.msUntilAvailable(3), 3000);
  clock.advance(500);
  assert.equal(bucket.msUntilAvailable(1), 500);
  assert.equal(bucket.available(), 0.5);
});

test('take: sofort bei vorhandenen Token, sonst Warten über den Timer', async () => {
  const { clock, bucket } = makeBucket({ burst: 1 });
  await bucket.take(); // sofort
  let resolved = false;
  const p = bucket.take().then(() => { resolved = true; });
  await clock.flush();
  assert.equal(resolved, false);
  assert.equal(clock.pending(), 1, 'ein Timer wurde geplant');
  assert.deepEqual(clock.pendingDelays(), [1000]);
  assert.equal(bucket.stats().waiting, 1);
  await clock.advanceAsync(999);
  assert.equal(resolved, false);
  await clock.advanceAsync(1);
  await p;
  assert.equal(resolved, true);
  assert.equal(bucket.stats().waiting, 0);
  assert.equal(bucket.stats().waited, 1);
  assert.equal(clock.pending(), 0);
});

test('take: FIFO – ein großer Wartender wird nicht von kleineren überholt', async () => {
  const { clock, bucket } = makeBucket({ burst: 3 });
  assert.equal(bucket.tryTake(3), true);
  const order = [];
  const p1 = bucket.take(2).then(() => order.push('zwei'));
  const p2 = bucket.take(1).then(() => order.push('eins'));
  await clock.flush();
  assert.deepEqual(order, []);
  // nach 1 s wäre 1 Token da – der Einser darf trotzdem nicht vorbei
  await clock.advanceAsync(1000);
  assert.deepEqual(order, []);
  assert.equal(bucket.tryTake(), false, 'tryTake verweigert, solange jemand wartet');
  await clock.advanceAsync(1000);
  assert.deepEqual(order, ['zwei']);
  await clock.advanceAsync(1000);
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['zwei', 'eins']);
});

test('take mehrerer Wartender innerhalb eines Timer-Laufs', async () => {
  const { clock, bucket } = makeBucket({ ratePerMin: 600, burst: 2 }); // 10 Token/s
  assert.equal(bucket.tryTake(2), true);
  const done = [];
  const ps = [1, 2, 3].map((i) => bucket.take().then(() => done.push(i)));
  await clock.advanceAsync(100);
  assert.deepEqual(done, [1]);
  await clock.advanceAsync(200);
  await Promise.all(ps);
  assert.deepEqual(done, [1, 2, 3]);
});

test('close weist Wartende ab und räumt den Timer auf', async () => {
  const { clock, bucket } = makeBucket({ burst: 1 });
  bucket.tryTake();
  const p = bucket.take();
  await clock.flush();
  assert.equal(clock.pending(), 1);
  bucket.close();
  await assert.rejects(p, /geschlossen/);
  assert.equal(clock.pending(), 0);
  assert.equal(bucket.stats().waiting, 0);
});

test('Rückwärts laufende Uhr führt nicht zu negativen Token', () => {
  let t = 1_000_000;
  const bucket = createTokenBucket({ ratePerMin: 60, burst: 2, now: () => t });
  bucket.tryTake(2);
  t -= 10_000;
  assert.equal(bucket.available(), 0);
  t += 1000;
  assert.equal(bucket.available(), 1);
});

test('Standard-Timer (echte Uhr) funktionieren', async () => {
  const bucket = createTokenBucket({ ratePerMin: 60_000, burst: 1 }); // 1 Token/ms
  await bucket.take();
  const start = Date.now();
  await bucket.take();
  assert.ok(Date.now() - start < 500);
});
