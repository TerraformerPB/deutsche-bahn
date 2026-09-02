import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICON_NAMES, ICON_PATHS, iconLabel, normalizeIconName, createWeatherIcon } from '../public/js/weather-icons.js';

test('Icon-Definitionen vollständig', () => {
  for (const n of ICON_NAMES) {
    assert.ok(Array.isArray(ICON_PATHS[n]) && ICON_PATHS[n].length > 0, n);
    assert.notEqual(iconLabel(n), 'unbekannt', n);
  }
  assert.equal(normalizeIconName('rain'), 'rain');
  assert.equal(normalizeIconName('xyz'), 'cloudy');
  assert.equal(iconLabel('xyz'), 'unbekannt');
});

test('createWeatherIcon nutzt DOM-APIs (Fake-Document)', () => {
  const nodes = [];
  const fakeDoc = {
    createElementNS(ns, tag) {
      const n = { ns, tag, attrs: {}, children: [], textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; } };
      nodes.push(n);
      return n;
    },
  };
  const svg = createWeatherIcon('thunderstorm', { document: fakeDoc, size: 30 });
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.attrs.width, '30');
  assert.equal(svg.attrs['aria-label'], 'Gewitter');
  assert.equal(svg.children[0].tag, 'title');
  assert.equal(svg.children.length, 1 + ICON_PATHS.thunderstorm.length);
});
