import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineM, bearingDeg, cumulativeLengths, lineLengthM, pointAtDistance, pointAlongLine,
  nearestVertexIndex, nearestPointOnLine, sliceLineByDistance, inBbox, bboxOf, isLonLat, roundCoord,
} from '../src/lib/geo.js';

const BERLIN = [13.369545, 52.525592];
const HAMBURG = [10.006909, 53.552736];
const HANNOVER = [9.741021, 52.376761];

test('haversine Berlin–Hamburg ≈ 255 km', () => {
  const d = haversineM(BERLIN, HAMBURG);
  assert.ok(d > 250_000 && d < 260_000, `unerwartet: ${d}`);
  assert.equal(haversineM(BERLIN, BERLIN), 0);
});

test('bearing nach Norden/Osten', () => {
  assert.ok(Math.abs(bearingDeg([10, 50], [10, 51]) - 0) < 0.01);
  assert.ok(Math.abs(bearingDeg([10, 50], [11, 50]) - 90) < 1);
  const b = bearingDeg(BERLIN, HAMBURG);
  assert.ok(b > 280 && b < 320, `Berlin→Hamburg sollte nach NW zeigen: ${b}`);
});

test('cumulativeLengths / lineLengthM', () => {
  const line = [BERLIN, HANNOVER, HAMBURG];
  const cum = cumulativeLengths(line);
  assert.equal(cum[0], 0);
  assert.ok(cum[1] > 0 && cum[2] > cum[1]);
  assert.equal(lineLengthM(line), cum[2]);
  assert.equal(lineLengthM([]), 0);
  assert.equal(lineLengthM([BERLIN]), 0);
});

test('pointAtDistance liegt auf der Strecke und behält Reihenfolge', () => {
  const line = [BERLIN, HANNOVER, HAMBURG];
  const cum = cumulativeLengths(line);
  const start = pointAtDistance(line, 0, cum);
  assert.deepEqual(start.point, BERLIN);
  const end = pointAtDistance(line, 1e9, cum);
  assert.deepEqual(end.point, HAMBURG);
  const mid = pointAtDistance(line, cum[1], cum);
  assert.ok(haversineM(mid.point, HANNOVER) < 1);
  const quarter = pointAtDistance(line, cum[1] / 2, cum);
  assert.ok(Math.abs(haversineM(BERLIN, quarter.point) - cum[1] / 2) < 500);
  assert.equal(quarter.index, 0);
  const half = pointAlongLine(line, 0.5, cum);
  const alongHalf = cum[half.index] + haversineM(line[half.index], half.point);
  assert.ok(Math.abs(alongHalf - cum[2] / 2) < 200, `Streckenposition ${alongHalf} statt ${cum[2] / 2}`);
});

test('pointAtDistance mit degenerierten Eingaben', () => {
  assert.equal(pointAtDistance([], 10), null);
  assert.deepEqual(pointAtDistance([BERLIN], 10).point, BERLIN);
  const dup = pointAtDistance([BERLIN, BERLIN, HAMBURG], 1000);
  assert.ok(isLonLat(dup.point));
});

test('nearestVertexIndex / nearestPointOnLine', () => {
  const line = [BERLIN, HANNOVER, HAMBURG];
  assert.equal(nearestVertexIndex(line, [9.75, 52.38]), 1);
  assert.equal(nearestVertexIndex(line, [9.75, 52.38], 2), 2);
  assert.equal(nearestVertexIndex([], BERLIN), -1);
  const near = nearestPointOnLine(line, [11.5, 52.5]);
  assert.equal(near.index, 0);
  assert.ok(near.t > 0 && near.t < 1);
  assert.ok(near.alongM > 0 && near.alongM < cumulativeLengths(line)[1]);
  assert.ok(near.distanceM < 60_000);
});

test('sliceLineByDistance liefert Teilstrecke', () => {
  const line = [BERLIN, HANNOVER, HAMBURG];
  const cum = cumulativeLengths(line);
  const part = sliceLineByDistance(line, cum[1] / 2, cum[1] + (cum[2] - cum[1]) / 2, cum);
  assert.ok(part.length === 3);
  assert.ok(haversineM(part[1], HANNOVER) < 1);
  const rev = sliceLineByDistance(line, cum[2], 0, cum);
  assert.deepEqual(rev[0], HAMBURG);
});

test('bbox-Hilfsfunktionen', () => {
  const bb = bboxOf([BERLIN, HAMBURG, HANNOVER]);
  assert.deepEqual(bb, [HANNOVER[0], HANNOVER[1], BERLIN[0], HAMBURG[1]]);
  assert.ok(inBbox(BERLIN, bb));
  assert.ok(!inBbox([0, 0], bb));
  assert.ok(isLonLat(BERLIN));
  assert.ok(!isLonLat([200, 0]));
  assert.ok(!isLonLat(null));
  assert.deepEqual(roundCoord([13.3695451234, 52.5255921234]), [13.36955, 52.52559]);
});
