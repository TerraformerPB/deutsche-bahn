import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, fmtDateTime, fmtDelay, delayMinutes, statusLabel, statusColor, stateLabel, productLabel, loadFactorLabel, categoryLabel, fmtAge, fmtKmh, fmtTemp, plural, matchesQuery, compareTrains } from '../public/js/format.js';

test('Zeiten in Europe/Berlin', () => {
  assert.equal(fmtTime('2026-09-02T18:04:00+02:00'), '18:04');
  assert.equal(fmtTime('2026-01-15T10:30:00Z'), '11:30');
  assert.equal(fmtTime(null), '–');
  assert.equal(fmtTime('kaputt'), '–');
  assert.match(fmtDateTime('2026-09-02T18:04:00+02:00'), /02\.09\., 18:04/);
});

test('Verspätung', () => {
  assert.equal(delayMinutes(300), 5);
  assert.equal(delayMinutes(null), null);
  assert.equal(fmtDelay(0), 'pünktlich');
  assert.equal(fmtDelay(7), '+7 min');
  assert.equal(fmtDelay(-3), '−3 min');
  assert.equal(fmtDelay(null), '–');
});

test('Labels', () => {
  assert.equal(statusLabel('heavy'), 'stark verspätet');
  assert.equal(statusLabel('x'), 'keine Echtzeitdaten');
  assert.match(statusColor('on_time'), /^#/);
  assert.equal(stateLabel('en_route'), 'unterwegs');
  assert.equal(productLabel('nationalExpress'), 'ICE');
  assert.equal(productLabel('nationalExpress', 'ICE'), 'ICE');
  assert.equal(loadFactorLabel('high'), 'hohe Auslastung');
  assert.equal(loadFactorLabel(null), null);
  assert.equal(categoryLabel('bau'), 'Bauarbeiten');
  assert.equal(fmtAge(12000), 'vor 12 s');
  assert.equal(fmtAge(180000), 'vor 3 min');
  assert.equal(fmtAge(7200000), 'vor 2 h');
  assert.equal(fmtAge(-1), '–');
  assert.equal(fmtKmh(187.4), '187 km/h');
  assert.equal(fmtTemp(17.6), '18 °C');
  assert.equal(plural(1, 'Zug', 'Züge'), '1 Zug');
  assert.equal(plural(2, 'Zug', 'Züge'), '2 Züge');
});

test('Suche und Sortierung', () => {
  const p = { line: 'ICE 597', fahrtNr: '597', direction: 'München Hbf', destination: 'München Hbf' };
  assert.ok(matchesQuery(p, 'ice 597'));
  assert.ok(matchesQuery(p, 'ICE597'));
  assert.ok(matchesQuery(p, 'münchen'));
  assert.ok(!matchesQuery(p, 'Hamburg'));
  assert.ok(matchesQuery(p, ''));
  const list = [{ line: 'ICE 1', delayMin: 0 }, { line: 'ICE 2', delayMin: 30, cancelled: false }, { line: 'ICE 3', cancelled: true }, { line: 'ICE 4', delayMin: null }];
  const sorted = [...list].sort(compareTrains).map((x) => x.line);
  assert.deepEqual(sorted, ['ICE 3', 'ICE 2', 'ICE 1', 'ICE 4']);
});
