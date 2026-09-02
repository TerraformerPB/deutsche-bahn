/**
 * Störungs-Aggregator.
 *
 * Sammelt aus den Remarks (HIM-Meldungen, Statusmeldungen) von Fahrten und
 * Abfahrtstafeln die relevanten Störungen, dedupliziert sie über den
 * normalisierten Meldungstext (SHA-1-Kurz-ID), ordnet Kategorie und
 * Schweregrad zu, erkennt betroffene Halte aus dem Text („zwischen X und Y“,
 * „in X“, „ab X“, „bis X“, …) und verwaltet Ablauf (TTL) sowie eine
 * Größenobergrenze. Alle Funktionen sind ohne Netzwerk- oder Zeitzugriff
 * testbar; die Zeitquelle wird injiziert.
 *
 * Koordinaten in Segmenten folgen der GeoJSON-Reihenfolge `[lon, lat]`.
 */
import { createHash } from 'node:crypto';
import { findStation, normalizeStationName } from '../data/stations.js';
import { silentLogger } from '../logger.js';

/** @typedef {{id:string|null, name:string, lat:number|null, lon:number|null}} Stop */
/** @typedef {{type:string, code?:string|null, summary?:string|null, text?:string|null, modified?:string|null, priority?:number|null}} Remark */
/**
 * @typedef {{
 *   id:string,
 *   category:'strecke'|'bau'|'zug'|'wetter'|'sonstiges',
 *   type:'warning'|'status',
 *   severity:'hoch'|'mittel'|'niedrig',
 *   summary:string|null, text:string|null, priority:number|null, modified:string|null,
 *   firstSeen:number, lastSeen:number,
 *   affectedTrips:Array<{tripId:string, lineName:string|null}>,
 *   affectedStops:Array<{id:string|null, name:string, lat:number|null, lon:number|null}>,
 *   segment:[[number,number],[number,number]]|null,
 *   active:boolean
 * }} Disruption
 */

export const CATEGORIES = Object.freeze(['strecke', 'bau', 'zug', 'wetter', 'sonstiges']);
export const SEVERITIES = Object.freeze(['hoch', 'mittel', 'niedrig']);
export const DEFAULT_TTL_MS = 6 * 3600e3;
export const DEFAULT_MAX_ITEMS = 500;
export const MAX_AFFECTED_TRIPS = 50;
export const MAX_AFFECTED_STOPS = 20;

/** Längenbegrenzungen für Eingaben (defensiv gegen überlange Upstream-Texte). */
const LIMITS = Object.freeze({
  summary: 300,
  text: 2000,
  phrase: 120,
  windowWords: 6,
  mentions: 8,
  modified: 40,
  tripId: 512,
  lineName: 64,
  stopName: 120,
});

const SEVERITY_RANK = Object.freeze({ hoch: 0, mittel: 1, niedrig: 2 });
const ACCEPTED_TYPES = new Set(['warning', 'status']);
const RE_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// ---------------------------------------------------------------------------
// Textaufbereitung
// ---------------------------------------------------------------------------

/**
 * Entfernt Steuerzeichen, fasst Whitespace zusammen und begrenzt die Länge.
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(RE_CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Faltet Text für Stichwortvergleiche: NFKC, Kleinschreibung, Umlaute → ae/oe/ue, ß → ss.
 * @param {string} s
 */
function foldText(s) {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

/**
 * Kombiniert Überschrift und Text einer Meldung zu einem Analyse-Text. Ist die
 * Überschrift bereits im Text enthalten, wird nur der Text verwendet.
 * @param {string|null} summary
 * @param {string|null} text
 * @returns {string}
 */
function combineText(summary, text) {
  if (summary && text) {
    return foldText(text).includes(foldText(summary)) ? text : `${summary}. ${text}`;
  }
  return text || summary || '';
}

/**
 * Normalisiert den Meldungstext für die Dedup-ID: gefaltet, nur Buchstaben/Ziffern,
 * einfache Leerzeichen. Leer, wenn kein Text vorhanden ist.
 * @param {unknown} summary
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeDisruptionText(summary, text) {
  const s = cleanText(summary, LIMITS.summary);
  const t = cleanText(text, LIMITS.text);
  const combined = combineText(s, t);
  return foldText(combined).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Stabile Kurz-ID (12 Hex-Zeichen aus SHA-1 des normalisierten Textes).
 * @param {unknown} summary
 * @param {unknown} text
 * @returns {string|null} `null`, wenn kein Text vorhanden ist
 */
export function disruptionId(summary, text) {
  const key = normalizeDisruptionText(summary, text);
  if (!key) return null;
  return createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Relevanz, Kategorie, Schweregrad (Stichwortregeln auf gefaltetem Text)
// ---------------------------------------------------------------------------

/** Stichworte, die eine Meldung überhaupt zur Störung machen (Brief Abschnitt 4.D). */
const RE_RELEVANT = /stoerung|gesperrt|sperrung|bauarbeit|baustell|ausfall|ausfaell|faellt aus|fallen aus|entfaellt|entfallen|umleitung|umgeleitet|polizei|notarzt|feuerwehr|rettungseinsatz|oberleitung|stellwerk|signal|weiche|unwetter|sturm|orkan|hochwasser|schnee|glatteis|streik|personen im gleis|person im gleis|reparatur|verspaet|gleiswechsel|wagenreihung|unfall|boeschungsbrand|evakuier/;

const RE_CATEGORY = Object.freeze({
  bau: /bauarbeit|baustell|baumassnahm|gleisbau|brueckenbau|streckenausbau/,
  wetter: /unwetter|sturm|orkan|schnee|glatteis|eisregen|hochwasser|ueberschwemm|starkregen|gewitter|witterung|wetterbedingt|hitze|blitz/,
  strecke: /sperrung|gesperrt|stellwerk|oberleitung|signal|weiche|personen im gleis|person im gleis|streck|bahnuebergang|boeschung|gleisstoerung|umleitung|umgeleitet|polizei|notarzt|feuerwehr|rettungseinsatz|unfall|evakuier/,
  zug: /faellt aus|fallen aus|ausfall|ausfaell|entfaellt|entfallen|verspaet|gleiswechsel|wagenreihung|reparatur|defekt|technische stoerung|technischen stoerung|zug/,
});

const RE_SEVERITY_HIGH = /faellt aus|fallen aus|ausfall|ausfaell|gesperrt|sperrung|personen im gleis|person im gleis|unwetter|sturm|orkan|hochwasser|streik|polizei|notarzt|feuerwehr|rettungseinsatz|unfall|boeschungsbrand|evakuier/;
const RE_SEVERITY_MEDIUM = /bauarbeit|baustell|umleitung|umgeleitet|stellwerk|oberleitung|signal|weiche|stoerung|reparatur|schnee|glatteis|eisregen|gewitter|entfaellt|entfallen|defekt/;
const RE_DELAY_MINUTES = /(\d{1,3})\s*(?:min\b|minuten)/g;
const RE_DELAY_HOURS = /(?:\d{1,2}|einer?|zwei|drei|mehreren)\s*stunden?/;

/**
 * Prüft, ob eine Meldung als Störung aufgenommen wird: nur `warning`/`status`
 * mit einem relevanten Stichwort. Reine Komfort-Hinweise (`hint`) werden ignoriert.
 * @param {unknown} remark
 * @returns {boolean}
 */
export function isRelevantRemark(remark) {
  if (!remark || typeof remark !== 'object' || Array.isArray(remark)) return false;
  const type = typeof remark.type === 'string' ? remark.type.trim().toLowerCase() : '';
  if (!ACCEPTED_TYPES.has(type)) return false;
  const key = normalizeDisruptionText(remark.summary, remark.text);
  if (!key) return false;
  return RE_RELEVANT.test(key);
}

/**
 * Kategorie einer Meldung (Reihenfolge: Bau, Wetter, Strecke, Zug, Sonstiges).
 * @param {string} text Beliebiger Meldungstext (wird intern gefaltet)
 * @returns {'strecke'|'bau'|'zug'|'wetter'|'sonstiges'}
 */
export function categorize(text) {
  const t = foldText(typeof text === 'string' ? text : '');
  if (!t) return 'sonstiges';
  if (RE_CATEGORY.bau.test(t)) return 'bau';
  if (RE_CATEGORY.wetter.test(t)) return 'wetter';
  if (RE_CATEGORY.strecke.test(t)) return 'strecke';
  if (RE_CATEGORY.zug.test(t)) return 'zug';
  return 'sonstiges';
}

/**
 * Größte im Text genannte Verspätung in Minuten (0, wenn keine Angabe).
 * @param {string} folded
 */
function mentionedDelayMinutes(folded) {
  let max = 0;
  for (const m of folded.matchAll(RE_DELAY_MINUTES)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > max) max = v;
  }
  if (RE_DELAY_HOURS.test(folded)) max = Math.max(max, 60);
  return max;
}

/**
 * Schweregrad aus Text und Meldungstyp: Ausfälle/Sperrungen/Unwetter/Einsätze
 * oder ≥ 60 min → hoch; Bauarbeiten/Umleitungen/Infrastrukturstörungen oder
 * ≥ 16 min → mittel; sonst niedrig (Warnungen ohne Indiz: mittel).
 * @param {string} text
 * @param {{type?:string}} [options]
 * @returns {'hoch'|'mittel'|'niedrig'}
 */
export function assessSeverity(text, { type = 'status' } = {}) {
  const t = foldText(typeof text === 'string' ? text : '');
  const delayMin = mentionedDelayMinutes(t);
  if (RE_SEVERITY_HIGH.test(t) || delayMin >= 60) return 'hoch';
  if (RE_SEVERITY_MEDIUM.test(t) || delayMin >= 16) return 'mittel';
  return type === 'warning' ? 'mittel' : 'niedrig';
}

// ---------------------------------------------------------------------------
// Erkennung betroffener Halte
// ---------------------------------------------------------------------------

/** Zeichen, die in einem Bahnhofsnamen vorkommen dürfen (ohne Satzzeichen). */
const NAME_BODY = "[\\p{L}\\p{N}\\-/()'’ ]{0,119}";
// Hinweis: `\b` ist in JavaScript ASCII-basiert und versagt vor „über“; daher Lookbehind auf Buchstaben/Ziffern.
const NOT_AFTER_WORD = '(?<![\\p{L}\\p{N}])';
const RE_BETWEEN = new RegExp(`${NOT_AFTER_WORD}[Zz]wischen\\s+(?:\\p{Ll}\\p{L}*\\s+){0,2}(\\p{Lu}${NAME_BODY}?)\\s+und\\s+(\\p{Lu}${NAME_BODY})`, 'gu');
const RE_HALT_ENTFAELLT = new RegExp(
  `\\bHalte?\\s+entf(?:ä|ae)llt:?\\s+(\\p{Lu}${NAME_BODY})|\\bHalte\\s+entfallen:?\\s+(\\p{Lu}${NAME_BODY})`
  + `|\\bHalte?\\s+(\\p{Lu}${NAME_BODY}?)\\s+(?:entf(?:ä|ae)llt|entfallen)\\b`,
  'gu',
);
/** Wörter, nach denen eine Phrase keine betroffenen Halte mehr nennt (Richtungsangaben). */
const DIRECTION_WORDS = new Set(['richtung', 'fahrtrichtung', 'gegenrichtung']);
/** Generische Namensbestandteile, die beim Token-Abgleich mit Fahrt-Halten ignoriert werden. */
const GENERIC_NAME_TOKENS = new Set(['hbf', 'bf', 'bahnhof', 'hauptbahnhof', 'pbf', 'fernbf', 'fernbahnhof', 'main', 'tief', 'gl', 'gleis']);
const RE_LOCATIVE = new RegExp(
  `${NOT_AFTER_WORD}(?:[Ii]n|[Ii]m|[Aa]b|[Bb]is|[Nn]ach|[Vv]on|[Bb]ei|[Üü]ber|[Uu]eber)\\s+(?:dem\\s+|der\\s+|den\\s+)?(?:Bahnhof\\s+|Bf\\s+|Haltepunkt\\s+)?(\\p{Lu}${NAME_BODY})`,
  'gu',
);

/** Einzelwörter, die trotz Treffer im Stationsverzeichnis keine Halte bezeichnen. */
const STOP_WORDS = new Set([
  'richtung', 'hoehe', 'kuerze', 'folge', 'grund', 'minute', 'minuten', 'stunde', 'stunden', 'gleis', 'gleisen',
  'zug', 'zuege', 'zuegen', 'halt', 'halte', 'halten', 'bahnhof', 'bahnhoefe', 'bahnhoefen', 'hauptbahnhof', 'hbf',
  'ende', 'abschnitt', 'bereich', 'naehe', 'umgebung', 'fahrtrichtung', 'gegenrichtung', 'verbindung', 'anschluss',
  'anschluesse', 'ersatzverkehr', 'bus', 'busse', 'bussen', 'taxi', 'uhr', 'mitternacht', 'weiteres', 'betrieb',
  'betriebsschluss', 'fahrt', 'fahrten', 'linie', 'linien', 'ausnahme', 'ausnahmen', 'rahmen', 'einzelfall',
  'einzelfaellen', 'regel', 'zusammenhang', 'hinblick', 'absprache', 'teil', 'teilen', 'wagen', 'bahnsteig',
  'baustelle', 'baustellen', 'station', 'stationen', 'ort', 'orte', 'haltestelle', 'haltestellen', 'abend', 'morgen',
  'nacht', 'vormittag', 'nachmittag', 'mittag', 'wochenende', 'woche', 'tag', 'tagen', 'flughafen', 'sued', 'nord',
  'ost', 'west', 'mitte', 'zentrum', 'innenstadt', 'land', 'region', 'deutschland', 'europa', 'ausland', 'inland',
  'netz', 'strecke', 'strecken', 'gegenzug', 'bahn', 'zugbegleiter', 'kunden', 'reisende', 'reisenden', 'fahrgaeste',
  'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag', 'januar', 'februar', 'maerz',
  'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember', 'ankunft', 'abfahrt',
  'aufgrund', 'wegen', 'bitte', 'heute', 'derzeit', 'voraussichtlich', 'etwa', 'circa', 'ca', 'der', 'die', 'das',
  'den', 'dem', 'des', 'ein', 'eine', 'einem', 'einer', 'eines', 'wir', 'sie', 'es', 'ist', 'sind', 'wird', 'werden',
  'fragen', 'bedarf', 'interesse', 'nutzung', 'hinweis', 'hinweise', 'information', 'informationen', 'auskunft',
  'ersatz', 'ersatzbus', 'ersatzbusse', 'schienenersatzverkehr', 'sev', 'app', 'internet', 'reisezentrum',
]);

/**
 * Extrahiert Bahnhofs-Nennungen aus einem Meldungstext. Liefert Kandidaten-Phrasen
 * (noch nicht aufgelöst) in Textreihenfolge; Muster: „zwischen X und Y“,
 * „Halt entfällt: X“, „in/im/ab/bis/nach/von/bei/über X“.
 * @param {unknown} text
 * @returns {{phrase:string, pattern:'zwischen'|'halt'|'ort'}[]}
 */
export function extractStopMentions(text) {
  const s = cleanText(text, LIMITS.text);
  if (!s) return [];
  /** @type {{phrase:string, pattern:'zwischen'|'halt'|'ort'}[]} */
  const out = [];
  const push = (phrase, pattern) => {
    const p = typeof phrase === 'string' ? phrase.trim().slice(0, LIMITS.phrase) : '';
    if (p && out.length < LIMITS.mentions) out.push({ phrase: p, pattern });
  };
  // Bereits verarbeitete Spannen werden durch Leerzeichen ersetzt, damit sie
  // nicht erneut über die allgemeinen Muster erfasst werden.
  let rest = s.replace(RE_BETWEEN, (m, a, b) => {
    push(a, 'zwischen');
    push(b, 'zwischen');
    return ' '.repeat(m.length);
  });
  rest = rest.replace(RE_HALT_ENTFAELLT, (m, a, b, c) => {
    push(a || b || c, 'halt');
    return ' '.repeat(m.length);
  });
  for (const m of rest.matchAll(RE_LOCATIVE)) push(m[1], 'ort');
  return out;
}

/**
 * Wandelt ein Stationsobjekt (Verzeichnis oder Stop) in einen minimalen Stop um.
 * @param {unknown} s
 * @returns {Stop|null}
 */
function toStop(s) {
  if (!s || typeof s !== 'object') return null;
  const name = cleanText(s.name, LIMITS.stopName);
  const id = typeof s.id === 'string' && /^[\p{L}\p{N}:_\-]{1,32}$/u.test(s.id) ? s.id : null;
  if (!name && !id) return null;
  // Nur echte Zahlen gelten als Koordinaten (`null` darf nicht zu 0/0 werden).
  const lat = typeof s.lat === 'number' ? s.lat : NaN;
  const lon = typeof s.lon === 'number' ? s.lon : NaN;
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return { id, name: name || id, lat: hasCoords ? lat : null, lon: hasCoords ? lon : null };
}

/** Schlüssel für die Dedup betroffener Halte (ID, sonst normalisierter Name). */
function stopKey(stop) {
  return stop.id ? `id:${stop.id}` : `name:${normalizeStationName(stop.name)}`;
}

/**
 * Signifikante Namensbestandteile (gefaltet, ≥ 3 Zeichen, ohne „Hbf“/„Bahnhof“ …)
 * für den toleranten Abgleich von Meldungstext und HAFAS-Schreibweise
 * („Frankfurt (Main) Flughafen Fernbahnhof“ ≙ „Frankfurt(M) Flughafen Fernbf“).
 * @param {string} name
 * @returns {string[]}
 */
function nameTokens(name) {
  return foldText(name)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 3 && !GENERIC_NAME_TOKENS.has(t));
}

/**
 * Sucht einen Kandidaten in den Halten der Fahrt: exakt gleicher normalisierter
 * Name, sonst Token-Abgleich (alle Kandidaten-Tokens im Haltnamen enthalten oder
 * umgekehrt, erstes Token gleich; bei mehreren Treffern der mit den wenigsten
 * zusätzlichen Tokens).
 * @param {string} candidate
 * @param {Stop[]} tripStops
 * @returns {Stop|null}
 */
function matchTripStop(candidate, tripStops) {
  const key = normalizeStationName(candidate);
  if (key.length < 3) return null;
  const candTokens = nameTokens(candidate);
  let best = null;
  let bestExtra = Infinity;
  for (const stop of tripStops) {
    const k = normalizeStationName(stop.name);
    if (!k) continue;
    if (k === key) return stop;
    if (candTokens.length === 0) continue;
    const stopTokens = nameTokens(stop.name);
    if (stopTokens.length === 0 || stopTokens[0] !== candTokens[0]) continue;
    const candSet = new Set(candTokens);
    const stopSet = new Set(stopTokens);
    const candInStop = candTokens.every((t) => stopSet.has(t));
    const stopInCand = stopTokens.every((t) => candSet.has(t));
    if (!candInStop && !stopInCand) continue;
    const extra = Math.abs(stopTokens.length - candTokens.length);
    if (extra < bestExtra) { best = stop; bestExtra = extra; }
  }
  return best;
}

/**
 * Entfernt hängende Bindestriche/Schrägstriche/öffnende Klammern am Fensterende;
 * eine schließende Klammer bleibt erhalten, wenn sie im Fenster geöffnet wurde.
 * @param {string} window
 */
function trimWindow(window) {
  let w = window.trim().replace(/[-/'’(]+$/u, '').trim();
  while (w.endsWith(')') && !w.includes('(')) w = w.slice(0, -1).trim();
  return w;
}

/**
 * Löst eine Kandidaten-Phrase auf: zuerst gegen die Halte der Fahrt, dann über
 * `resolveStation` (Stationsverzeichnis). Geprüft werden Wortfenster (längste
 * zuerst), die mit einem Großbuchstaben beginnen; Einzelwörter aus der
 * Stoppliste werden verworfen. Ein verkürztes Fenster wird aus dem Verzeichnis
 * nur akzeptiert, wenn der Name exakt passt oder das folgende Wort kein
 * Namensbestandteil (Großbuchstabe/Klammer) ist – so wird „Frankfurt (Main)
 * Flughafen …“ nicht zu „Frankfurt (Main) Hbf“. Nach Richtungsangaben
 * („in Richtung Hamburg“) endet die Suche. Mehrere Halte in einer Phrase
 * („Fulda und Kassel“) werden nacheinander erkannt.
 * @param {string} phrase
 * @param {{resolveStation:(name:string)=>unknown, tripStops:Stop[]}} ctx
 * @returns {Stop[]}
 */
function resolvePhrase(phrase, { resolveStation, tripStops }) {
  const words = phrase.split(' ').filter(Boolean);
  const out = [];
  let i = 0;
  while (i < words.length && out.length < 4) {
    if (DIRECTION_WORDS.has(foldText(words[i]).replace(/[^a-z]/g, ''))) break;
    if (!/^\p{Lu}/u.test(words[i])) { i++; continue; }
    let hit = null;
    let used = 0;
    for (let len = Math.min(LIMITS.windowWords, words.length - i); len >= 1; len--) {
      const window = trimWindow(words.slice(i, i + len).join(' '));
      if (window.length < 3) continue;
      if (len === 1 && STOP_WORDS.has(foldText(window).replace(/[^a-z0-9]/g, ''))) continue;
      const fromTrip = matchTripStop(window, tripStops);
      if (fromTrip) { hit = fromTrip; used = len; break; }
      let station = null;
      try { station = resolveStation(window); } catch { station = null; }
      const stop = toStop(station);
      if (!stop) continue;
      const next = words[i + len];
      const truncated = next !== undefined && /^[\p{Lu}(]/u.test(next);
      if (truncated && normalizeStationName(stop.name) !== normalizeStationName(window)) continue;
      // Bevorzugt das Halt-Objekt der Fahrt mit derselben ID (konsistente Koordinaten/Namen).
      hit = tripStops.find((ts) => ts.id && ts.id === stop.id) || stop;
      used = len;
      break;
    }
    if (hit) { out.push(hit); i += used; } else { i++; }
  }
  return out;
}

/**
 * Erkennt betroffene Halte in einem Meldungstext und löst sie auf.
 * @param {unknown} text
 * @param {{resolveStation?:(name:string)=>unknown, tripStops?:unknown[]}} [options]
 * @returns {Stop[]} dedupliziert, in Textreihenfolge (max. 6)
 */
export function resolveAffectedStops(text, { resolveStation = findStation, tripStops = [] } = {}) {
  const resolver = typeof resolveStation === 'function' ? resolveStation : () => null;
  const stops = Array.isArray(tripStops) ? tripStops.map(toStop).filter(Boolean) : [];
  const seen = new Set();
  const out = [];
  for (const mention of extractStopMentions(text)) {
    for (const stop of resolvePhrase(mention.phrase, { resolveStation: resolver, tripStops: stops })) {
      const key = stopKey(stop);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(stop);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * Parst `modified` einer Meldung defensiv (ISO-String oder Zahl → ISO-String).
 * @param {unknown} value
 * @returns {string|null}
 */
function toModified(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = cleanText(value, LIMITS.modified);
  if (!s || Number.isNaN(Date.parse(s))) return null;
  return s;
}

/** @param {unknown} value */
function toPriority(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * Erzeugt aus einer Meldung die normalisierte Aufnahme (ohne Zuordnung).
 * @param {Remark} remark
 * @returns {{id:string, type:'warning'|'status', summary:string|null, text:string|null, analysis:string, category:string, severity:string, priority:number|null, modified:string|null}|null}
 */
function parseRemark(remark) {
  if (!isRelevantRemark(remark)) return null;
  const summary = cleanText(remark.summary, LIMITS.summary);
  const text = cleanText(remark.text, LIMITS.text);
  const id = disruptionId(summary, text);
  if (!id) return null;
  const type = remark.type.trim().toLowerCase() === 'warning' ? 'warning' : 'status';
  const analysis = combineText(summary, text);
  return {
    id,
    type,
    summary,
    text,
    analysis,
    category: categorize(analysis),
    severity: assessSeverity(analysis, { type }),
    priority: toPriority(remark.priority),
    modified: toModified(remark.modified),
  };
}

/** @param {unknown} trip */
function tripRef(trip) {
  if (!trip || typeof trip !== 'object') return null;
  const tripId = typeof trip.id === 'string' ? trip.id.trim() : (typeof trip.tripId === 'string' ? trip.tripId.trim() : '');
  if (!tripId || tripId.length > LIMITS.tripId) return null;
  return { tripId, lineName: cleanText(trip.lineName, LIMITS.lineName) };
}

/**
 * Erzeugt den Störungs-Aggregator.
 * @param {{
 *   now?:() => number, ttlMs?:number, maxItems?:number,
 *   resolveStation?:(nameOrId:string) => unknown,
 *   logger?:{debug:Function, info:Function, warn:Function, error:Function}
 * }} [options]
 */
export function createDisruptionAggregator({
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  maxItems = DEFAULT_MAX_ITEMS,
  resolveStation = findStation,
  logger = silentLogger,
} = {}) {
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS;
  const limit = Number.isInteger(maxItems) && maxItems > 0 ? maxItems : DEFAULT_MAX_ITEMS;
  const resolver = typeof resolveStation === 'function' ? resolveStation : findStation;
  const log = logger && typeof logger.debug === 'function' ? logger : silentLogger;

  /** @type {Map<string, Disruption & {tripKeys:Set<string>, stopKeys:Set<string>}>} */
  const items = new Map();

  function nowMs() {
    let t;
    try { t = Number(now()); } catch { t = NaN; }
    return Number.isFinite(t) ? t : Date.now();
  }

  function isActive(item, t) {
    return item.lastSeen + ttl > t;
  }

  /** Entfernt die ältesten Einträge (nach `lastSeen`), bis die Obergrenze eingehalten ist. */
  function enforceLimit() {
    let removed = 0;
    if (items.size <= limit) return removed;
    const sorted = [...items.values()].sort((a, b) => a.lastSeen - b.lastSeen || (a.id < b.id ? -1 : 1));
    for (const item of sorted) {
      if (items.size <= limit) break;
      items.delete(item.id);
      removed++;
    }
    return removed;
  }

  /**
   * Nimmt eine Meldung auf oder aktualisiert den vorhandenen Eintrag.
   * @param {Remark} remark
   * @param {{trip:{tripId:string, lineName:string|null}|null, tripStops:Stop[], contextStop:Stop|null}} ctx
   * @returns {boolean} ob eine Störung berührt wurde
   */
  function ingestRemark(remark, { trip, tripStops, contextStop }) {
    const parsed = parseRemark(remark);
    if (!parsed) return false;
    const t = nowMs();
    const recognized = resolveAffectedStops(parsed.analysis, { resolveStation: resolver, tripStops });
    const stops = recognized.length > 0 ? recognized : (contextStop ? [contextStop] : []);
    const withCoords = recognized.filter((s) => s.lat !== null && s.lon !== null);
    const segment = recognized.length === 2 && withCoords.length === 2
      ? [[withCoords[0].lon, withCoords[0].lat], [withCoords[1].lon, withCoords[1].lat]]
      : null;

    let item = items.get(parsed.id);
    if (!item) {
      item = {
        id: parsed.id,
        category: parsed.category,
        type: parsed.type,
        severity: parsed.severity,
        summary: parsed.summary,
        text: parsed.text,
        priority: parsed.priority,
        modified: parsed.modified,
        firstSeen: t,
        lastSeen: t,
        affectedTrips: [],
        affectedStops: [],
        segment: null,
        tripKeys: new Set(),
        stopKeys: new Set(),
      };
      items.set(item.id, item);
      log.debug('Neue Störung erfasst', { id: item.id, category: item.category, severity: item.severity });
    } else {
      item.lastSeen = Math.max(item.lastSeen, t);
      if (parsed.type === 'warning') item.type = 'warning';
      if (parsed.priority !== null) item.priority = parsed.priority;
      if (parsed.modified && (!item.modified || Date.parse(parsed.modified) > Date.parse(item.modified))) item.modified = parsed.modified;
      if (SEVERITY_RANK[parsed.severity] < SEVERITY_RANK[item.severity]) item.severity = parsed.severity;
      if (!item.summary && parsed.summary) item.summary = parsed.summary;
      if (!item.text && parsed.text) item.text = parsed.text;
    }
    if (trip && !item.tripKeys.has(trip.tripId) && item.affectedTrips.length < MAX_AFFECTED_TRIPS) {
      item.tripKeys.add(trip.tripId);
      item.affectedTrips.push({ tripId: trip.tripId, lineName: trip.lineName });
    }
    for (const stop of stops) {
      const key = stopKey(stop);
      if (item.stopKeys.has(key) || item.affectedStops.length >= MAX_AFFECTED_STOPS) continue;
      item.stopKeys.add(key);
      item.affectedStops.push({ id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon });
    }
    if (!item.segment && segment) item.segment = segment;
    enforceLimit();
    return true;
  }

  /** @param {unknown} list */
  function remarksOf(list) {
    return Array.isArray(list) ? list : [];
  }

  /**
   * Nimmt alle Remarks einer Fahrt (Fahrt- und Halt-Ebene) auf.
   * @param {unknown} trip normalisierter Trip (Abschnitt 3 des Briefs)
   * @returns {number} Anzahl berührter Störungen
   */
  function ingestTrip(trip) {
    const ref = tripRef(trip);
    if (!ref) return 0;
    const stopovers = Array.isArray(trip.stopovers) ? trip.stopovers.filter((s) => s && typeof s === 'object') : [];
    const tripStops = [];
    for (const s of [trip.origin, ...stopovers.map((so) => so.stop), trip.destination]) {
      const stop = toStop(s);
      if (stop) tripStops.push(stop);
    }
    let count = 0;
    for (const remark of remarksOf(trip.remarks)) {
      if (ingestRemark(remark, { trip: ref, tripStops, contextStop: null })) count++;
    }
    for (const so of stopovers) {
      const contextStop = toStop(so.stop);
      for (const remark of remarksOf(so.remarks)) {
        if (ingestRemark(remark, { trip: ref, tripStops, contextStop })) count++;
      }
    }
    return count;
  }

  /**
   * Nimmt die Remarks einer Abfahrts-/Ankunftstafel auf. Ohne erkannten Halt im
   * Text gilt der Bahnhof der Tafel als betroffener Halt.
   * @param {unknown} stop Bahnhof der Tafel (`{id, name, lat, lon}`)
   * @param {unknown} departures normalisierte Departures
   * @returns {number} Anzahl berührter Störungen
   */
  function ingestDepartures(stop, departures) {
    if (!Array.isArray(departures)) return 0;
    const boardStop = toStop(stop);
    let count = 0;
    for (const dep of departures) {
      if (!dep || typeof dep !== 'object') continue;
      const ref = tripRef(dep);
      const depStop = toStop(dep.stop);
      const contextStop = (depStop && depStop.lat !== null ? depStop : null) || boardStop || depStop;
      const tripStops = [contextStop].filter(Boolean);
      for (const remark of remarksOf(dep.remarks)) {
        if (ingestRemark(remark, { trip: ref, tripStops, contextStop })) count++;
      }
    }
    return count;
  }

  /** Erzeugt eine unabhängige Kopie für Aufrufer (keine Rückwirkung auf den Speicher). */
  function toPublic(item, t) {
    return {
      id: item.id,
      category: item.category,
      type: item.type,
      severity: item.severity,
      summary: item.summary,
      text: item.text,
      priority: item.priority,
      modified: item.modified,
      firstSeen: item.firstSeen,
      lastSeen: item.lastSeen,
      affectedTrips: item.affectedTrips.map((x) => ({ ...x })),
      affectedStops: item.affectedStops.map((x) => ({ ...x })),
      segment: item.segment ? item.segment.map((p) => [p[0], p[1]]) : null,
      active: isActive(item, t),
    };
  }

  /**
   * Liefert Störungen, sortiert nach Schweregrad (hoch zuerst), dann jüngste zuerst.
   * @param {{activeOnly?:boolean}} [options]
   * @returns {Disruption[]}
   */
  function list({ activeOnly = true } = {}) {
    const t = nowMs();
    const out = [];
    for (const item of items.values()) {
      if (activeOnly && !isActive(item, t)) continue;
      out.push(toPublic(item, t));
    }
    out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.lastSeen - a.lastSeen || (a.id < b.id ? -1 : 1));
    return out;
  }

  /**
   * Entfernt abgelaufene Einträge und hält die Obergrenze ein.
   * @returns {number} Anzahl entfernter Einträge
   */
  function prune() {
    const t = nowMs();
    let removed = 0;
    for (const [id, item] of items) {
      if (!isActive(item, t)) {
        items.delete(id);
        removed++;
      }
    }
    removed += enforceLimit();
    if (removed > 0) log.debug('Störungen bereinigt', { removed, remaining: items.size });
    return removed;
  }

  function size() {
    return items.size;
  }

  /** Kennzahlen für Status-Endpunkte. */
  function stats() {
    const t = nowMs();
    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    let active = 0;
    for (const item of items.values()) {
      if (!isActive(item, t)) continue;
      active++;
      byCategory[item.category]++;
      bySeverity[item.severity]++;
    }
    return { size: items.size, active, byCategory, bySeverity, ttlMs: ttl, maxItems: limit };
  }

  return { ingestTrip, ingestDepartures, list, prune, size, stats };
}
