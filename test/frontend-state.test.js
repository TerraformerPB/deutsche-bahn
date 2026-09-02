import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, createPrefs } from '../public/js/state.js';

test('Store: set/subscribe mit Schlüsselfilter', () => {
  const s = createStore({ a: 1, b: 2 });
  const seen = [];
  const unsub = s.subscribe((state, changed) => seen.push(changed), ['a']);
  s.set({ b: 3 });
  assert.equal(seen.length, 0);
  s.set({ a: 2 });
  assert.deepEqual(seen, [['a']]);
  s.set((st) => ({ a: st.a + 1 }));
  assert.equal(s.get().a, 3);
  s.set({ a: 3 }); // unverändert → keine Benachrichtigung
  assert.equal(seen.length, 2);
  unsub();
  s.set({ a: 4 });
  assert.equal(seen.length, 2);
  assert.equal(s.listenerCount(), 0);
  s.set(null);
});

test('Prefs: robust ohne Storage und bei Fehlern', () => {
  const none = createPrefs(null);
  assert.equal(none.read('x', 5), 5);
  assert.equal(none.write('x', 1), false);
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  const p = createPrefs(storage, 't.');
  assert.ok(p.write('theme', 'dark'));
  assert.equal(p.read('theme', null), 'dark');
  assert.ok(mem.has('t.theme'));
  const broken = createPrefs({ getItem: () => { throw new Error('nein'); }, setItem: () => { throw new Error('nein'); } });
  assert.equal(broken.read('a', 'b'), 'b');
  assert.equal(broken.write('a', 1), false);
});
