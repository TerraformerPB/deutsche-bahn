/**
 * Minimaler strukturierter Logger (JSON Lines oder lesbar), ohne Abhängigkeiten.
 *
 * Datenschutz: IP-Adressen werden vor dem Protokollieren mit `anonymizeIp`
 * gekürzt (IPv4: letztes Oktett, IPv6: auf /48), so dass keine Rückführung
 * auf einzelne Personen möglich ist (DSGVO-Grundsatz der Datenminimierung).
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Kürzt eine IP-Adresse auf ein nicht personenbeziehbares Präfix. */
export function anonymizeIp(ip) {
  if (typeof ip !== 'string' || ip === '') return null;
  let v = ip.trim();
  if (v.startsWith('::ffff:')) v = v.slice(7); // IPv4-mapped IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    return v.replace(/\.\d{1,3}$/, '.0');
  }
  if (v.includes(':')) {
    const parts = v.split(':');
    return `${parts.slice(0, 3).map((p) => p || '0').join(':')}::`;
  }
  return 'unbekannt';
}

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  const out = { name: err.name, message: err.message };
  if (err.code) out.code = err.code;
  if (err.statusCode) out.statusCode = err.statusCode;
  if (err.stack) out.stack = err.stack;
  if (err.cause) out.cause = serializeError(err.cause);
  return out;
}

function normalizeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    out[k] = v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {'debug'|'info'|'warn'|'error'|'silent'} [opts.level]
 * @param {'json'|'pretty'} [opts.format]
 * @param {(line: string) => void} [opts.write] Ausgabe-Senke (Standard: stdout)
 * @param {object} [opts.base] Felder, die jeder Zeile hinzugefügt werden
 * @param {() => Date} [opts.now]
 */
export function createLogger({ level = 'info', format = 'json', write, base = {}, now = () => new Date() } = {}) {
  if (!(level in LEVELS)) throw new Error(`Unbekanntes Log-Level: ${level}`);
  const sink = write || ((line) => process.stdout.write(line + '\n'));
  const threshold = LEVELS[level];

  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const record = { time: now().toISOString(), level: lvl, msg: String(msg), ...base, ...normalizeFields(fields) };
    if (format === 'json') {
      sink(JSON.stringify(record));
    } else {
      const { time, level: l, msg: m, ...rest } = record;
      const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      sink(`${time} ${l.toUpperCase().padEnd(5)} ${m}${extra}`);
    }
  };

  const logger = {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (bindings) => createLogger({ level, format, write: sink, base: { ...base, ...bindings }, now }),
    isEnabled: (lvl) => LEVELS[lvl] >= threshold,
  };
  return logger;
}

/** Logger, der alles verwirft (für Tests). */
export const silentLogger = createLogger({ level: 'silent', write: () => {} });
