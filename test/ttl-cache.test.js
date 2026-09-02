import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../src/lib/ttl-cache.js';
import { createFakeClock } from './helpers/fake-clock.js';

function makeCache(opts = {}) {
  const clock = createFakeClock();
  const cache = createTtlCache({ maxEntries: 3, defaultTtlMs: 1000, now: clock.now, ...opts });
  return { clock, cache };
}

test('Parameter werden validiert', () => {
  assert.throws(() => createTtlCache({ maxEntries: 0 }), RangeError);
  assert.throws(() => createTtlCache({ maxEntries: 2.5 }), RangeError);
  assert.throws(() => createTtlCache({ defaultTtlMs: 0 }), RangeError);
  assert.throws(() => createTtlCache({ defaultTtlMs: -1 }), RangeError);
  assert.throws(() => createTtlCache({ now: 'jetzt' }), TypeError);
  const { cache } = makeCache();
  assert.throws(() => cache.set('a', 1, -1), RangeError);
  assert.throws(() => cache.set('a', 1, 'lang'), RangeError);
  assert.throws(() => cache.set('a', 1, Number.NaN), RangeError);
  // Standardwerte ohne Optionen
  const def = createTtlCache();
  assert.equal(def.stats().maxEntries, 1000);
});

test('set/get/has/delete/clear/size', () => {
  const { cache } = makeCache();
  assert.equal(cache.set('a', 1), 1);
  cache.set('b', { x: 2 });
  assert.equal(cache.get('a'), 1);
  assert.deepEqual(cache.get('b'), { x: 2 });
  assert.equal(cache.get('c'), undefined);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('c'), false);
  assert.equal(cache.size(), 2);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  assert.equal(cache.size(), 1);
  cache.clear();
  assert.equal(cache.size(), 0);
  const s = cache.stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
});

test('Ablauf nach Standard-TTL und individueller TTL', () => {
  const { clock, cache } = makeCache();
  cache.set('a', 'A'); // 1000 ms
  cache.set('b', 'B', 5000);
  cache.set('c', 'C', Infinity);
  clock.advance(999);
  assert.equal(cache.get('a'), 'A');
  clock.advance(1);
  assert.equal(cache.get('a'), undefined, 'exakt zur Ablaufzeit verfallen');
  assert.equal(cache.has('a'), false);
  assert.equal(cache.get('b'), 'B');
  clock.advance(4000);
  assert.equal(cache.has('b'), false);
  clock.advance(10_000_000);
  assert.equal(cache.get('c'), 'C');
  const s = cache.stats();
  assert.equal(s.expired, 2);
  assert.equal(s.misses, 1);
});

test('ttlMs 0 speichert nicht und entfernt vorhandene Einträge', () => {
  const { cache } = makeCache();
  cache.set('a', 1);
  cache.set('a', 2, 0);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.size(), 0);
});

test('Ohne defaultTtlMs verfallen Einträge nie', () => {
  const clock = createFakeClock();
  const cache = createTtlCache({ now: clock.now });
  cache.set('a', 1);
  clock.advance(365 * 86400 * 1000);
  assert.equal(cache.get('a'), 1);
});

test('LRU-Verdrängung: get frischt Position auf', () => {
  const { cache } = makeCache({ maxEntries: 3 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1); // a wird jüngster Eintrag
  cache.set('d', 4); // verdrängt b
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.deepEqual(cache.keys(), ['c', 'a', 'd']);
  assert.equal(cache.stats().evictions, 1);
  cache.set('e', 5); // verdrängt c
  assert.deepEqual(cache.keys(), ['a', 'd', 'e']);
  assert.equal(cache.stats().evictions, 2);
  assert.equal(cache.size(), 3);
});

test('Überschreiben eines Schlüssels erneuert TTL und LRU-Position ohne Verdrängung', () => {
  const { clock, cache } = makeCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  clock.advance(900);
  cache.set('a', 11);
  assert.deepEqual(cache.keys(), ['b', 'a']);
  clock.advance(500);
  assert.equal(cache.get('a'), 11);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.stats().evictions, 0);
});

test('Bei vollem Cache werden zuerst abgelaufene Einträge entfernt', () => {
  const { clock, cache } = makeCache({ maxEntries: 3 });
  cache.set('alt', 1, 100);
  cache.set('b', 2);
  cache.set('c', 3);
  clock.advance(200);
  cache.set('d', 4);
  assert.equal(cache.stats().evictions, 0, 'kein LRU-Opfer nötig');
  assert.equal(cache.stats().expired, 1);
  assert.deepEqual(cache.keys(), ['b', 'c', 'd']);
});

test('peek liest ohne Statistik und LRU-Effekt', () => {
  const { clock, cache } = makeCache();
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.peek('a'), 1);
  assert.equal(cache.peek('zzz'), undefined);
  assert.deepEqual(cache.keys(), ['a', 'b']);
  assert.equal(cache.stats().hits, 0);
  clock.advance(1000);
  assert.equal(cache.peek('a'), undefined);
});

test('prune entfernt abgelaufene Einträge und liefert die Anzahl', () => {
  const { clock, cache } = makeCache();
  cache.set('a', 1, 100);
  cache.set('b', 2, 200);
  cache.set('c', 3, 10_000);
  assert.equal(cache.prune(), 0);
  clock.advance(150);
  assert.equal(cache.prune(), 1);
  assert.equal(cache.stats().size, 2);
  clock.advance(100);
  assert.equal(cache.size(), 1);
  assert.equal(cache.stats().expired, 2);
});

test('Objekt-Schlüssel und Falsy-Werte', () => {
  const { cache } = makeCache();
  const key = { id: 1 };
  cache.set(key, 0);
  cache.set('leer', null);
  assert.equal(cache.get(key), 0);
  assert.equal(cache.get('leer'), null);
  assert.equal(cache.has('leer'), true);
});
