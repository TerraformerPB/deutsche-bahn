/**
 * Normalisierung der transport.rest-Rohdaten (FPTF/hafas-client-kompatibel)
 * in die internen Datenmodelle (siehe Brief, Abschnitt 3).
 *
 * Alle Funktionen sind rein (keine Seiteneffekte, keine Netzwerkzugriffe) und
 * robust gegen fehlende oder falsch typisierte Felder: fehlende Werte werden
 * zu `null`, offensichtlich unbrauchbare Einträge (z. B. Abfahrt ohne
 * `tripId`) zu `null`, nur eine falsche Grundstruktur einer ganzen Fahrt löst
 * einen `UpstreamFormatError` aus.
 *
 * Konventionen:
 *  - Verspätung intern in Sekunden (`delaySec`), wie vom Upstream geliefert.
 *  - Zeiten bleiben ISO-8601-Strings mit Offset (so wie geliefert).
 *  - Koordinaten als `[lon, lat]` bzw. `lat`/`lon` in Stop-Objekten; fehlende
 *    Koordinaten werden über das Stationsverzeichnis (`findStation`) ergänzt.
 *  - Texte werden gekürzt und von HTML-Tags befreit (Upstream-Texte können
 *    Markup enthalten); sie werden im Frontend ausschließlich per DOM-API gesetzt.
 */
import { UpstreamFormatError } from '../lib/errors.js';
import { findStation } from '../data/stations.js';

/** Alle zehn Produktklassen von transport.rest (Reihenfolge wie in der API-Dokumentation). */
export const PRODUCTS = Object.freeze([
  'nationalExpress', 'national', 'regionalExpress', 'regional', 'suburban',
  'bus', 'ferry', 'subway', 'tram', 'taxi',
]);

/** Gültige Auslastungswerte. */
export const LOAD_FACTORS = Object.freeze(['low-to-medium', 'high', 'very-high', 'exceptionally-high']);

/** Gültige Remark-Typen. */
export const REMARK_TYPES = Object.freeze(['hint', 'status', 'warning']);

const LIMITS = Object.freeze({
  id: 64,
  tripId: 512,
  name: 200,
  code: 64,
  summary: 300,
  text: 4000,
  platform: 16,
  lineName: 64,
  operator: 120,
  direction: 200,
  polylinePoints: 20000,
  /** Verspätungen jenseits von ±30 Tagen sind Datenfehler. */
  delaySec: 30 * 86400,
});

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const HTML_TAG_RE = /<[^>]{0,200}>/g;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

/** Kürzt einen String auf `max` Zeichen (Unicode-Codepunkte, kein Zerschneiden von Surrogatpaaren). */
function truncate(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

/**
 * Einzeiliger Text: trimmen, Steuerzeichen und Zeilenumbrüche zu Leerzeichen, kürzen.
 * @returns {string|null}
 */
function toText(value, max = LIMITS.name) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return null;
  const s = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s === '' ? null : truncate(s, max);
}

/**
 * Freitext (Remarks): HTML-Tags entfernen, häufige Entities auflösen, Leerraum
 * normalisieren (Zeilenumbrüche bleiben als einfache Umbrüche erhalten), kürzen.
 * @returns {string|null}
 */
function toRichText(value, max = LIMITS.text) {
  if (typeof value !== 'string') return null;
  let s = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(HTML_TAG_RE, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s === '') return null;
  s = truncate(s, max);
  return s;
}

/** Bezeichner (IDs): String ohne Steuerzeichen, gekürzt; Zahlen werden zu Strings. */
function toId(value, max = LIMITS.id) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '' || s.length > max || CONTROL_CHARS_RE.test(s)) return null;
  return s;
}

/** ISO-8601-Zeitstempel (String) – wird unverändert, aber geprüft übernommen. */
export function toIsoString(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '' || s.length > 40) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return s;
}

/** Verspätung in Sekunden (Integer) oder `null`, wenn keine Echtzeitinformation vorliegt. */
export function toDelaySec(value) {
  let n = value;
  if (typeof n === 'string' && n.trim() !== '') n = Number(n);
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (Math.abs(r) > LIMITS.delaySec) return null;
  return r;
}

/**
 * Epoch-Millisekunden aus Unix-Sekunden, Millisekunden oder ISO-String.
 * transport.rest liefert `realtimeDataUpdatedAt` als Unix-Sekunden.
 * @returns {number|null}
 */
export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // < 1e11 → Sekunden (bis Jahr 5138), sonst bereits Millisekunden
    return Math.round(value < 1e11 ? value * 1000 : value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^\d{1,13}$/.test(s)) return toEpochMs(Number(s));
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  return null;
}

function toPlatform(value) {
  return toText(value, LIMITS.platform);
}

function toLoadFactor(value) {
  return typeof value === 'string' && LOAD_FACTORS.includes(value) ? value : null;
}

function toCoordinate(value, max) {
  let n = value;
  if (typeof n === 'string' && n.trim() !== '') n = Number(n);
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > max) return null;
  return n;
}

/** Liest ein Koordinatenpaar aus FPTF-Location (`latitude`/`longitude`) oder GeoJSON-Array. */
function readLatLon(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let lat = null;
  let lon = null;
  if (Array.isArray(obj)) {
    lon = toCoordinate(obj[0], 180);
    lat = toCoordinate(obj[1], 90);
  } else {
    lat = toCoordinate(obj.latitude ?? obj.lat, 90);
    lon = toCoordinate(obj.longitude ?? obj.lon ?? obj.lng, 180);
  }
  if (lat === null || lon === null) return null;
  // (0, 0) liegt im Golf von Guinea – bei Bahnhofsdaten ein sicheres Zeichen für "unbekannt".
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const EMPTY_STOP = Object.freeze({ id: null, name: '', lat: null, lon: null });

/**
 * Normalisiert ein Stop-/Station-Objekt. Fehlende Koordinaten werden über
 * das Stationsverzeichnis ergänzt (erst per ID, dann per Name); ein fehlender
 * Name wird ebenfalls aus dem Verzeichnis übernommen.
 * @param {unknown} raw FPTF-Stop, Station, Location oder ein Bahnhofsname
 * @param {{resolveStation?: (nameOrId: string) => ({id:string, name:string, lat:number, lon:number}|null)}} [options]
 * @returns {import('./types').Stop | {id:string|null, name:string, lat:number|null, lon:number|null}}
 */
export function normalizeStop(raw, { resolveStation = findStation } = {}) {
  let obj = raw;
  if (typeof raw === 'string') obj = { name: raw };
  if (!isPlainObject(obj)) return { ...EMPTY_STOP };

  let id = toId(obj.id);
  let name = toText(obj.name, LIMITS.name) ?? '';
  const coords = readLatLon(obj.location) ?? readLatLon(obj);
  let lat = coords ? coords.lat : null;
  let lon = coords ? coords.lon : null;

  const needsLookup = lat === null || lon === null || name === '' || id === null;
  if (needsLookup && typeof resolveStation === 'function') {
    let station = null;
    try {
      station = (id !== null ? resolveStation(id) : null) || (name !== '' ? resolveStation(name) : null) || null;
    } catch {
      station = null;
    }
    if (station && typeof station === 'object') {
      if (lat === null || lon === null) {
        const c = readLatLon(station);
        if (c) {
          lat = c.lat;
          lon = c.lon;
        }
      }
      if (name === '') name = toText(station.name, LIMITS.name) ?? '';
      if (id === null) id = toId(station.id);
    }
  }
  return { id, name, lat, lon };
}

/**
 * Normalisiert einen Hinweis (Remark). Unbekannte Typen werden zu `hint`;
 * Einträge ohne jeglichen Text ergeben `null`.
 * @param {unknown} raw
 * @returns {import('./types').Remark | null}
 */
export function normalizeRemark(raw) {
  if (!isPlainObject(raw)) return null;
  const typeRaw = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  const type = REMARK_TYPES.includes(typeRaw) ? typeRaw : 'hint';
  const summary = toRichText(raw.summary, LIMITS.summary);
  const text = toRichText(raw.text, LIMITS.text);
  if (summary === null && text === null) return null;
  const priority = typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? Math.round(raw.priority) : null;
  return {
    type,
    code: toText(raw.code, LIMITS.code),
    summary,
    text,
    modified: toIsoString(raw.modified),
    priority,
  };
}

function normalizeRemarks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    const n = normalizeRemark(r);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Normalisiert einen Zwischenhalt. Einträge ohne identifizierbaren Halt
 * (weder ID noch Name) ergeben `null`.
 * @param {unknown} raw
 * @param {{resolveStation?: Function}} [options]
 * @returns {import('./types').Stopover | null}
 */
export function normalizeStopover(raw, options = {}) {
  if (!isPlainObject(raw)) return null;
  const stop = normalizeStop(raw.stop, options);
  if (stop.id === null && stop.name === '') return null;
  return {
    stop,
    plannedArrival: toIsoString(raw.plannedArrival),
    arrival: toIsoString(raw.arrival),
    arrivalDelaySec: toDelaySec(raw.arrivalDelay),
    plannedDeparture: toIsoString(raw.plannedDeparture),
    departure: toIsoString(raw.departure),
    departureDelaySec: toDelaySec(raw.departureDelay),
    plannedArrivalPlatform: toPlatform(raw.plannedArrivalPlatform),
    arrivalPlatform: toPlatform(raw.arrivalPlatform ?? raw.arrivalPrognosedPlatform),
    plannedDeparturePlatform: toPlatform(raw.plannedDeparturePlatform),
    departurePlatform: toPlatform(raw.departurePlatform ?? raw.departurePrognosedPlatform),
    cancelled: raw.cancelled === true,
    loadFactor: toLoadFactor(raw.loadFactor),
    remarks: normalizeRemarks(raw.remarks),
  };
}

/** Kürzel im Liniennamen → Produktklasse (Fallback, wenn `line.product` fehlt). */
const PREFIX_PRODUCT = [
  [/^(ICE|ICE-SPRINTER)$/i, 'nationalExpress'],
  [/^(IC|EC|ECE|IC-BUS|RJ|RJX|NJ|EN|TGV|FLX|D|IR)$/i, 'national'],
  [/^(RE|IRE|FEX|MEX|REX|RRX)$/i, 'regionalExpress'],
  [/^(RB|R|BRB|MRB|NWB|ERB|ALX|WFB|ME|ENO|OE|VBG|HLB|ABR)$/i, 'regional'],
  [/^S\d*$/i, 'suburban'],
  [/^U\d*$/i, 'subway'],
  [/^(STR|TRAM|STB)$/i, 'tram'],
  [/^(BUS|SEV|BUSSEV)$/i, 'bus'],
  [/^(F|FÄHRE|FAEHRE|FERRY)$/i, 'ferry'],
  [/^(AST|TAXI|RUF)$/i, 'taxi'],
];
const MODE_PRODUCT = { bus: 'bus', watercraft: 'ferry', taxi: 'taxi', gondola: 'tram', aircraft: null, train: null, walking: null };

/**
 * Bestimmt die Produktklasse einer Linie: bevorzugt `line.product`, sonst
 * Ableitung aus `productName`, dem Präfix des Liniennamens oder `mode`.
 * @param {unknown} line FPTF-Line
 * @returns {string|null}
 */
export function productFromLine(line) {
  if (!isPlainObject(line)) return null;
  if (typeof line.product === 'string' && PRODUCTS.includes(line.product)) return line.product;
  const candidates = [];
  if (typeof line.productName === 'string') candidates.push(line.productName.trim());
  if (typeof line.name === 'string') {
    const first = line.name.trim().split(/[\s]+/)[0] ?? '';
    // "ICE597" ohne Leerzeichen → Buchstabenpräfix
    const m = /^([A-Za-zÄÖÜäöü-]+)/.exec(first);
    if (m) candidates.push(m[1]);
    candidates.push(first);
  }
  for (const c of candidates) {
    if (!c) continue;
    for (const [re, product] of PREFIX_PRODUCT) {
      if (re.test(c)) return product;
    }
  }
  if (typeof line.mode === 'string') {
    const p = MODE_PRODUCT[line.mode.toLowerCase()];
    if (p) return p;
  }
  return null;
}

/** Liniennamen-Felder gemeinsam für Abfahrten und Fahrten. */
function lineFields(line) {
  const l = isPlainObject(line) ? line : {};
  const productName = toText(l.productName, 16);
  const fahrtNr = toId(l.fahrtNr, 16);
  let lineName = toText(l.name, LIMITS.lineName);
  if (lineName === null) {
    lineName = [productName, fahrtNr].filter(Boolean).join(' ') || 'Unbekannt';
  }
  const operator = isPlainObject(l.operator) ? toText(l.operator.name, LIMITS.operator) : toText(l.operator, LIMITS.operator);
  return { lineName, product: productFromLine(l), productName, fahrtNr, operator };
}

/**
 * Normalisiert einen Abfahrts- oder Ankunftseintrag einer Abfahrtstafel.
 * Bei Ankünften wird `provenance` (Herkunft) als `direction` übernommen.
 * Einträge ohne `tripId` ergeben `null`.
 * @param {unknown} raw
 * @param {{resolveStation?: Function}} [options]
 * @returns {import('./types').Departure | null}
 */
export function normalizeDeparture(raw, options = {}) {
  if (!isPlainObject(raw)) return null;
  const tripId = toId(raw.tripId, LIMITS.tripId);
  if (tripId === null) return null;
  const { lineName, product, fahrtNr } = lineFields(raw.line);
  const direction = toText(raw.direction, LIMITS.direction) ?? toText(raw.provenance, LIMITS.direction);
  return {
    tripId,
    lineName,
    product,
    fahrtNr,
    direction,
    stop: normalizeStop(raw.stop, options),
    plannedWhen: toIsoString(raw.plannedWhen),
    when: toIsoString(raw.when),
    delaySec: toDelaySec(raw.delay),
    plannedPlatform: toPlatform(raw.plannedPlatform),
    platform: toPlatform(raw.platform ?? raw.prognosedPlatform),
    cancelled: raw.cancelled === true,
    remarks: normalizeRemarks(raw.remarks),
  };
}

/** Liest einen einzelnen Polyline-Punkt (Feature, Geometry oder [lon, lat]). */
function pointOf(item) {
  if (Array.isArray(item)) return readLatLon(item);
  if (!isPlainObject(item)) return null;
  if (item.type === 'Feature') return pointOf(item.geometry);
  if (item.type === 'Point' && Array.isArray(item.coordinates)) return readLatLon(item.coordinates);
  if (Array.isArray(item.coordinates)) return readLatLon(item.coordinates);
  return readLatLon(item);
}

/**
 * Normalisiert eine Polyline zu `[lon, lat][]`. Akzeptiert die
 * transport.rest-FeatureCollection aus Point-Features, GeoJSON-LineStrings
 * (auch als Feature) sowie rohe Koordinaten-Arrays. Ungültige Punkte werden
 * verworfen, direkt aufeinanderfolgende Duplikate entfernt; bei weniger als
 * zwei gültigen Punkten ist das Ergebnis `null`.
 * @param {unknown} raw
 * @returns {Array<[number, number]> | null}
 */
export function normalizePolyline(raw) {
  let items = null;
  if (Array.isArray(raw)) items = raw;
  else if (isPlainObject(raw)) {
    if (raw.type === 'FeatureCollection' && Array.isArray(raw.features)) items = raw.features;
    else if (raw.type === 'Feature' && isPlainObject(raw.geometry)) return normalizePolyline(raw.geometry);
    else if ((raw.type === 'LineString' || raw.type === undefined) && Array.isArray(raw.coordinates)) items = raw.coordinates;
    else if (raw.type === 'MultiLineString' && Array.isArray(raw.coordinates)) items = raw.coordinates.flat(1);
  }
  if (!items) return null;
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const item of items) {
    if (out.length >= LIMITS.polylinePoints) break;
    const p = pointOf(item);
    if (!p) continue;
    const last = out[out.length - 1];
    if (last && last[0] === p.lon && last[1] === p.lat) continue;
    out.push([p.lon, p.lat]);
  }
  return out.length >= 2 ? out : null;
}

/**
 * Normalisiert eine vollständige Fahrt. Akzeptiert sowohl das Trip-Objekt
 * selbst als auch die Antworthülle `{trip, realtimeDataUpdatedAt}`.
 * Fehlt die ID oder ist die Grundstruktur kein Objekt, wird ein
 * `UpstreamFormatError` geworfen.
 * @param {unknown} raw
 * @param {{fetchedAt?: number, realtimeDataUpdatedAt?: unknown, resolveStation?: Function}} [options]
 * @returns {import('./types').Trip}
 */
export function normalizeTrip(raw, options = {}) {
  const { fetchedAt, realtimeDataUpdatedAt, resolveStation } = options;
  const wrapper = isPlainObject(raw) && isPlainObject(raw.trip) ? raw : null;
  const t = wrapper ? wrapper.trip : raw;
  if (!isPlainObject(t)) {
    throw new UpstreamFormatError('Die Datenquelle hat keine gültige Fahrt geliefert.', { details: { reason: 'Fahrt ist kein Objekt' } });
  }
  const id = toId(t.id, LIMITS.tripId);
  if (id === null) {
    throw new UpstreamFormatError('Die Datenquelle hat eine Fahrt ohne Kennung geliefert.', { details: { reason: 'trip.id fehlt' } });
  }
  const stopOptions = resolveStation ? { resolveStation } : {};
  const { lineName, product, productName, fahrtNr, operator } = lineFields(t.line);

  const stopovers = [];
  if (Array.isArray(t.stopovers)) {
    for (const s of t.stopovers) {
      const n = normalizeStopover(s, stopOptions);
      if (n) stopovers.push(n);
    }
  }

  let origin = normalizeStop(t.origin, stopOptions);
  if (origin.id === null && origin.name === '' && stopovers.length > 0) origin = { ...stopovers[0].stop };
  let destination = normalizeStop(t.destination, stopOptions);
  if (destination.id === null && destination.name === '' && stopovers.length > 0) destination = { ...stopovers[stopovers.length - 1].stop };

  const fetched = typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) ? Math.round(fetchedAt) : Date.now();
  const rtSource = realtimeDataUpdatedAt !== undefined
    ? realtimeDataUpdatedAt
    : (wrapper ? wrapper.realtimeDataUpdatedAt : t.realtimeDataUpdatedAt);

  return {
    id,
    lineName,
    product,
    productName,
    fahrtNr,
    operator,
    direction: toText(t.direction, LIMITS.direction),
    origin,
    destination,
    plannedDeparture: toIsoString(t.plannedDeparture),
    departure: toIsoString(t.departure),
    departureDelaySec: toDelaySec(t.departureDelay),
    plannedArrival: toIsoString(t.plannedArrival),
    arrival: toIsoString(t.arrival),
    arrivalDelaySec: toDelaySec(t.arrivalDelay),
    cancelled: t.cancelled === true,
    loadFactor: toLoadFactor(t.loadFactor),
    stopovers,
    remarks: normalizeRemarks(t.remarks),
    polyline: normalizePolyline(t.polyline),
    realtimeDataUpdatedAt: toEpochMs(rtSource),
    fetchedAt: fetched,
  };
}
