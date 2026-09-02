import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymizeIp, createLogger } from '../src/logger.js';

test('anonymizeIp kürzt IPv4/IPv6', () => {
  assert.equal(anonymizeIp('192.168.10.77'), '192.168.10.0');
  assert.equal(anonymizeIp('::ffff:10.1.2.3'), '10.1.2.0');
  assert.equal(anonymizeIp('2001:db8:abcd:1234:5678::1'), '2001:db8:abcd::');
  assert.equal(anonymizeIp(''), null);
  assert.equal(anonymizeIp(undefined), null);
});

test('Logger schreibt JSON mit Level-Filter und Kindkontext', () => {
  const lines = [];
  const log = createLogger({ level: 'info', write: (l) => lines.push(l), now: () => new Date('2026-01-01T00:00:00Z') });
  log.debug('nicht sichtbar');
  log.info('hallo', { a: 1 });
  log.child({ mod: 'x' }).warn('achtung', { err: new Error('kaputt') });
  assert.equal(lines.length, 2);
  const r1 = JSON.parse(lines[0]);
  assert.equal(r1.msg, 'hallo');
  assert.equal(r1.a, 1);
  assert.equal(r1.time, '2026-01-01T00:00:00.000Z');
  const r2 = JSON.parse(lines[1]);
  assert.equal(r2.mod, 'x');
  assert.equal(r2.err.message, 'kaputt');
  assert.equal(r2.err.name, 'Error');
  assert.ok(log.isEnabled('warn'));
  assert.ok(!log.isEnabled('debug'));
});

test('Logger pretty-Format', () => {
  const lines = [];
  const log = createLogger({ level: 'debug', format: 'pretty', write: (l) => lines.push(l) });
  log.error('boom', { code: 7 });
  assert.match(lines[0], /ERROR boom \{"code":7\}/);
});
