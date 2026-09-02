/**
 * Formatierungshilfen (Deutsch), DOM-frei und in Node testbar.
 */
const TZ = 'Europe/Berlin';
const timeFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export const STATUS_LABELS = Object.freeze({
  on_time: 'pünktlich',
  slight: 'leicht verspätet',
  delayed: 'verspätet',
  heavy: 'stark verspätet',
  cancelled: 'ausgefallen',
  unknown: 'keine Echtzeitdaten',
});

export const STATUS_COLORS = Object.freeze({
  on_time: '#2e8b57',
  slight: '#d9a400',
  delayed: '#ef8a17',
  heavy: '#d7263d',
  cancelled: '#7a7a7a',
  unknown: '#6c8ebf',
});

export const STATE_LABELS = Object.freeze({
  scheduled: 'vor Abfahrt',
  en_route: 'unterwegs',
  at_stop: 'im Halt',
  finished: 'Fahrt beendet',
  cancelled: 'ausgefallen',
  unknown: 'unbekannt',
});

export const PRODUCT_LABELS = Object.freeze({
  nationalExpress: 'ICE',
  national: 'IC/EC',
  regionalExpress: 'RE/IR',
  regional: 'RB',
  suburban: 'S-Bahn',
});

export const LOAD_LABELS = Object.freeze({
  'low-to-medium': 'geringe bis mittlere Auslastung',
  high: 'hohe Auslastung',
  'very-high': 'sehr hohe Auslastung',
  'exceptionally-high': 'außergewöhnlich hohe Auslastung',
});

export const CATEGORY_LABELS = Object.freeze({
  strecke: 'Streckenstörung',
  bau: 'Bauarbeiten',
  zug: 'Zugmeldung',
  wetter: 'Unwetter',
  sonstiges: 'Hinweis',
});

export const SEVERITY_LABELS = Object.freeze({ hoch: 'hoch', mittel: 'mittel', niedrig: 'niedrig' });

export function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return timeFmt.format(d);
}

export function fmtDateTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return dateTimeFmt.format(d);
}

/** Sekunden → gerundete Minuten (null bleibt null). */
export function delayMinutes(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return null;
  return Math.round(sec / 60);
}

/** Verspätung als Text: "+5 min", "pünktlich", "−2 min", "–". */
export function fmtDelay(min) {
  if (min === null || min === undefined || !Number.isFinite(min)) return '–';
  if (min <= 0 && min > -1) return 'pünktlich';
  if (min < 0) return `−${Math.abs(min)} min`;
  return `+${min} min`;
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.unknown;
}

export function statusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.unknown;
}

export function stateLabel(state) {
  return STATE_LABELS[state] || STATE_LABELS.unknown;
}

export function productLabel(product, productName) {
  return productName || PRODUCT_LABELS[product] || 'Zug';
}

export function loadFactorLabel(lf) {
  return lf ? (LOAD_LABELS[lf] || lf) : null;
}

export function categoryLabel(cat) {
  return CATEGORY_LABELS[cat] || CATEGORY_LABELS.sonstiges;
}

/** Alter in Millisekunden → "vor 12 s" / "vor 3 min" / "vor 2 h". */
export function fmtAge(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `vor ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} min`;
  const h = Math.round(m / 60);
  return `vor ${h} h`;
}

export function fmtKmh(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return `${Math.round(v)} km/h`;
}

export function fmtTemp(t) {
  if (t === null || t === undefined || !Number.isFinite(t)) return '–';
  return `${Math.round(t)} °C`;
}

export function plural(n, singular, pluralForm) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Textsuche über Linie, Nummer, Richtung, Ziel (ohne Groß-/Kleinschreibung, Umlaut-tolerant). */
export function matchesQuery(props, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [props.line, props.fahrtNr, props.direction, props.destination, props.origin, props.nextStop]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q) || hay.replace(/\s+/g, '').includes(q.replace(/\s+/g, ''));
}

/** Sortierung: stark verspätet zuerst, dann nach Verspätung absteigend, dann Linie. */
export function compareTrains(a, b) {
  const da = a.cancelled ? 10_000 : (a.delayMin ?? -1);
  const db = b.cancelled ? 10_000 : (b.delayMin ?? -1);
  if (db !== da) return db - da;
  return String(a.line).localeCompare(String(b.line), 'de');
}
