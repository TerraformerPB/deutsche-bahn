#!/usr/bin/env node
/**
 * Mock-Upstream für Demo, Tests und Entwicklung ohne Internetzugang.
 *
 * Emuliert die genutzten Fremd-APIs mit exakt den erwarteten Antwortformaten:
 *  - transport.rest v6: /stops/:id/departures, /stops/:id/arrivals, /trips/:id, /locations
 *  - Bright Sky:        /current_weather, /alerts
 *  - Open-Meteo:        /v1/forecast
 *  - Kartenserver:      /style/style.json (minimaler MapLibre-Style ohne Glyphen)
 *
 * Die synthetischen Fahrten laufen entlang der ICE-Korridore (src/data/ice-corridors.geo.json),
 * sind deterministisch (Seed) und bewegen sich relativ zur aktuellen Uhrzeit.
 *
 * Aufruf: `node scripts/mock-upstream.js` (Port über MOCK_PORT, Standard 3999).
 */
import http from 'node:http';
import { corridorsGeoJson } from '../src/data/corridors.js';
import { findStation, searchStations } from '../src/data/stations.js';
import { hubs as defaultHubs } from '../src/data/hubs.js';
import { cumulativeLengths } from '../src/lib/geo.js';

// ------------------------------------------------------------------ Hilfsfunktionen

/** FNV-1a-Hash (32 Bit) für deterministische Ableitungen aus Strings. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32-PRNG. */
export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const berlinFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function berlinParts(ms) {
  const parts = {};
  for (const p of berlinFmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return parts;
}

/** ISO-8601 mit Europe/Berlin-Offset, z. B. 2026-09-02T18:04:00+02:00. */
export function toBerlinIso(ms) {
  const sec = Math.floor(ms / 1000) * 1000;
  const p = berlinParts(sec);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offMin = Math.round((asUtc - sec) / 60000);
  const sign = offMin >= 0 ? '+' : '-';
  const a = Math.abs(offMin);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

/** Lokale Mitternacht (Europe/Berlin) des Tages von `ms` als UTC-Millisekunden. */
export function berlinMidnight(ms) {
  const p = berlinParts(ms);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, 0, 0, 0);
  // Offset zur lokalen Mitternacht ermitteln (kann von dem um `ms` abweichen – DST)
  const guess = asUtc - (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000);
  return guess;
}

function ddmmyyyy(ms) {
  const p = berlinParts(ms);
  return `${String(+p.day)}${p.month}${p.year}`;
}

const MIN = 60_000;

const LOAD_FACTORS = ['low-to-medium', 'low-to-medium', 'high', 'very-high', 'exceptionally-high'];

const DISRUPTION_TEXTS = [
  (a, b) => ({ summary: 'Störung', text: `Störung an einem Stellwerk zwischen ${a} und ${b}. Es kommt zu Verspätungen und Teilausfällen. Bitte informieren Sie sich vor Fahrtantritt.` }),
  (a, b) => ({ summary: 'Streckensperrung', text: `Die Strecke zwischen ${a} und ${b} ist derzeit gesperrt. Grund ist eine Reparatur an der Oberleitung. Züge werden umgeleitet, es kommt zu Verspätungen von bis zu 40 Minuten.` }),
  (a, b) => ({ summary: 'Polizeieinsatz', text: `Polizeieinsatz auf der Strecke zwischen ${a} und ${b}. Der Zug hält derzeit außerplanmäßig. Bitte rechnen Sie mit Verspätungen.` }),
  (a, b) => ({ summary: 'Unwetter', text: `Unwetterbedingte Beeinträchtigungen zwischen ${a} und ${b}: Sturmschäden an der Strecke. Die Züge fahren mit verminderter Geschwindigkeit.` }),
  (a, b) => ({ summary: 'Weichenstörung', text: `Weichenstörung in ${a}. Der Zug kann den Bahnhof nur eingeschränkt anfahren, es kommt zu Verspätungen im Abschnitt bis ${b}.` }),
];

const CONSTRUCTION_TEXTS = [
  (a, b) => ({ summary: 'Bauarbeiten', text: `Vorankündigung: Bauarbeiten zwischen ${a} und ${b}. Es kommt zu geänderten Fahrzeiten und Teilausfällen. Bitte informieren Sie sich frühzeitig.` }),
];

const HINTS = [
  { type: 'hint', code: 'BR', summary: 'Bordrestaurant', text: 'Bordrestaurant' },
  { type: 'hint', code: 'FR', summary: 'Fahrradmitnahme reservierungspflichtig', text: 'Fahrradmitnahme reservierungspflichtig' },
  { type: 'hint', code: 'CK', summary: 'Komfort Check-in möglich', text: 'Komfort Check-in möglich (bahn.de/kci)' },
  { type: 'hint', code: 'KL', summary: 'Klimaanlage', text: 'Fahrzeuggebundene Einstiegshilfe vorhanden' },
];

/**
 * Baut die Fahrpläne aller synthetischen Fahrten, die den Zeitraum [fromMs, toMs] berühren.
 */
function buildSchedule({ corridors, seed, tripsPerCorridor, fromMs, toMs }) {
  const trips = new Map();
  const headwayMin = Math.max(20, Math.round(120 / Math.max(1, tripsPerCorridor)));
  const features = corridors.features.filter((f) => f.geometry && f.geometry.type === 'LineString' && Array.isArray(f.properties?.stops) && f.properties.stops.length >= 2);
  const dayStarts = [berlinMidnight(fromMs - 36 * 3600e3), berlinMidnight(fromMs), berlinMidnight(toMs + 36 * 3600e3)];
  const uniqueDays = [...new Set(dayStarts)];

  for (let ci = 0; ci < features.length; ci++) {
    const f = features[ci];
    const coords = f.geometry.coordinates;
    const cum = cumulativeLengths(coords);
    const vmax = f.properties.vmax || 160;
    const speedMps = (vmax * 0.6) / 3.6;
    // Halte: Kategorie ≤ 3 bevorzugen, erster/letzter immer
    let stops = f.properties.stops.filter((s, i, arr) => i === 0 || i === arr.length - 1 || (s.cat != null && s.cat <= 3));
    if (stops.length < 3) stops = f.properties.stops;
    const lines = (f.properties.lines && f.properties.lines.length) ? f.properties.lines : ['ICE 0'];
    const corridorHash = hashString(`${seed}:${f.properties.id}`);
    const offsetMin = corridorHash % headwayMin;

    for (const dir of [1, -1]) {
      const seq = dir === 1 ? stops : [...stops].reverse();
      for (const dayStart of uniqueDays) {
        for (let k = 0; k * headwayMin < 24 * 60; k++) {
          // Rund um die Uhr, damit Demo und Tests zu jeder Tageszeit Fahrten zeigen
          const depMin = offsetMin + k * headwayMin + (dir === -1 ? Math.floor(headwayMin / 2) : 0);
          if (depMin >= 24 * 60) break;
          const depMs = dayStart + depMin * MIN;
          // Fahrzeit-Schätzung für Fensterprüfung
          const total = Math.abs(cum[seq[seq.length - 1].index] - cum[seq[0].index]);
          const arrEstimate = depMs + (total / speedMps) * 1000 + seq.length * 2 * MIN;
          if (arrEstimate < fromMs || depMs > toMs) continue;

          const key = `${f.properties.id}:${dir}:${dayStart}:${k}`;
          const h = hashString(`${seed}:${key}`);
          const rng = createRng(h);
          const lineSpec = lines[k % lines.length];
          const productName = lineSpec.startsWith('ICE') ? 'ICE' : (lineSpec.startsWith('EC') ? 'EC' : (lineSpec.startsWith('RJ') ? 'RJ' : 'IC'));
          const product = productName === 'ICE' ? 'nationalExpress' : 'national';
          const fahrtNr = String(100 + (h % 900));
          const lineName = `${productName} ${fahrtNr}`;
          const tripId = `1|${100000 + (h % 900000)}|0|80|${ddmmyyyy(depMs)}`;

          // Verspätungsprofil
          const r = rng();
          let delayMin = 0;
          let cancelled = false;
          let partialCancelIdx = -1;
          if (r < 0.60) delayMin = 0;
          else if (r < 0.85) delayMin = 6 + Math.floor(rng() * 10);
          else if (r < 0.95) delayMin = 16 + Math.floor(rng() * 45);
          else if (r < 0.975) cancelled = true;
          else { delayMin = 10 + Math.floor(rng() * 20); partialCancelIdx = 1 + Math.floor(rng() * (seq.length - 2)); }
          const delayStartIdx = delayMin > 0 ? Math.floor(rng() * Math.max(1, seq.length - 1)) : seq.length;
          const platformChangeIdx = rng() < 0.3 ? Math.floor(rng() * seq.length) : -1;
          const loadFactor = LOAD_FACTORS[Math.floor(rng() * LOAD_FACTORS.length)];
          const withPolyline = rng() < 0.7;

          // Halte mit Zeiten
          const stopovers = [];
          let t = depMs;
          for (let i = 0; i < seq.length; i++) {
            const s = seq[i];
            const st = findStation(s.id) || { id: s.id, name: s.name, lat: coords[s.index][1], lon: coords[s.index][0] };
            const dist = i === 0 ? 0 : Math.abs(cum[s.index] - cum[seq[i - 1].index]);
            const travelMs = i === 0 ? 0 : Math.round((dist / speedMps) / 60) * MIN;
            const plannedArr = i === 0 ? null : t + travelMs;
            const plannedDep = i === seq.length - 1 ? null : (i === 0 ? depMs : plannedArr + 2 * MIN);
            const d = i >= delayStartIdx ? delayMin * 60 : 0;
            const stopCancelled = cancelled || i === partialCancelIdx;
            const platformPlanned = String(1 + ((h + i * 7) % 12));
            const platform = i === platformChangeIdx ? String(1 + ((h + i * 7 + 3) % 12)) : platformPlanned;
            stopovers.push({
              stop: { type: 'station', id: st.id, name: st.name, location: { type: 'location', latitude: st.lat, longitude: st.lon } },
              arrival: plannedArr == null || stopCancelled ? null : toBerlinIso(plannedArr + d * 1000),
              plannedArrival: plannedArr == null ? null : toBerlinIso(plannedArr),
              arrivalDelay: plannedArr == null || stopCancelled ? null : d,
              arrivalPlatform: plannedArr == null || stopCancelled ? null : platform,
              plannedArrivalPlatform: plannedArr == null ? null : platformPlanned,
              departure: plannedDep == null || stopCancelled ? null : toBerlinIso(plannedDep + d * 1000),
              plannedDeparture: plannedDep == null ? null : toBerlinIso(plannedDep),
              departureDelay: plannedDep == null || stopCancelled ? null : d,
              departurePlatform: plannedDep == null || stopCancelled ? null : platform,
              plannedDeparturePlatform: plannedDep == null ? null : platformPlanned,
              ...(stopCancelled ? { cancelled: true } : {}),
              ...(i > 0 && i < seq.length - 1 && rng() < 0.5 ? { loadFactor } : {}),
              _plannedArrMs: plannedArr, _plannedDepMs: plannedDep, _delaySec: d, _index: i,
            });
            t = plannedDep == null ? (plannedArr ?? t) : plannedDep;
          }

          // Remarks
          const remarks = [HINTS[h % HINTS.length]];
          if (cancelled) {
            remarks.push({ type: 'warning', code: 'text.realtime.journey.cancelled', summary: 'Fahrt fällt aus', text: 'Fahrt fällt aus', priority: 10 });
          } else if (delayMin >= 16) {
            const a = seq[Math.max(0, delayStartIdx - 1)].name;
            const b = seq[Math.min(seq.length - 1, delayStartIdx)].name;
            const tx = DISRUPTION_TEXTS[h % DISRUPTION_TEXTS.length](a, b);
            remarks.push({ type: 'warning', code: `HIM-${h % 9999}`, summary: tx.summary, text: tx.text, priority: 20, modified: toBerlinIso(depMs - 30 * MIN) });
          } else if (rng() < 0.25) {
            const a = seq[0].name;
            const b = seq[Math.min(seq.length - 1, 2)].name;
            const tx = CONSTRUCTION_TEXTS[0](a, b);
            remarks.push({ type: 'status', code: `HIM-BAU-${h % 999}`, summary: tx.summary, text: tx.text, priority: 200, modified: toBerlinIso(depMs - 24 * 3600e3) });
          }
          if (partialCancelIdx >= 0) {
            remarks.push({ type: 'warning', code: 'text.realtime.stop.cancelled', summary: 'Halt entfällt', text: `Der Halt ${seq[partialCancelIdx].name} entfällt.`, priority: 15 });
          }
          if (platformChangeIdx >= 0) {
            remarks.push({ type: 'status', code: 'text.realtime.connection.platform.change', summary: 'Gleiswechsel', text: `${lineName} fährt in ${seq[platformChangeIdx].name} abweichend von Gleis ${stopovers[platformChangeIdx].departurePlatform || stopovers[platformChangeIdx].arrivalPlatform}`, priority: 30 });
          }

          const polyline = withPolyline ? {
            type: 'FeatureCollection',
            features: coords.slice(Math.min(seq[0].index, seq[seq.length - 1].index), Math.max(seq[0].index, seq[seq.length - 1].index) + 1)
              .map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [c[0], c[1]] } })),
          } : null;
          if (polyline && dir === -1) polyline.features.reverse();

          const first = stopovers[0];
          const last = stopovers[stopovers.length - 1];
          trips.set(tripId, {
            id: tripId,
            origin: first.stop,
            destination: last.stop,
            departure: first.departure, plannedDeparture: first.plannedDeparture, departureDelay: first.departureDelay,
            arrival: last.arrival, plannedArrival: last.plannedArrival, arrivalDelay: last.arrivalDelay,
            line: { type: 'line', id: lineName.toLowerCase().replace(/\s+/g, '-'), fahrtNr, name: lineName, productName, mode: 'train', product, public: true, operator: { type: 'operator', id: 'db-fernverkehr-ag', name: 'DB Fernverkehr AG' } },
            direction: last.stop.name,
            ...(cancelled ? { cancelled: true } : {}),
            loadFactor,
            stopovers,
            remarks,
            polyline,
            _depMs: first._plannedDepMs, _arrMs: last._plannedArrMs, _corridor: f.properties.id, _dir: dir,
          });
        }
      }
    }
  }
  return trips;
}

function stripInternal(obj) {
  if (Array.isArray(obj)) return obj.map(stripInternal);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      out[k] = stripInternal(v);
    }
    return out;
  }
  return obj;
}

function parseProducts(query) {
  const all = ['nationalExpress', 'national', 'regionalExpress', 'regional', 'suburban', 'bus', 'ferry', 'subway', 'tram', 'taxi'];
  const res = {};
  let any = false;
  for (const p of all) {
    if (query.has(p)) { res[p] = query.get(p) === 'true'; any = true; }
  }
  if (!any) for (const p of all) res[p] = true;
  return res;
}

// ------------------------------------------------------------------ Wetter

const WX_ICONS = ['clear-day', 'partly-cloudy-day', 'cloudy', 'rain', 'fog', 'wind', 'thunderstorm', 'snow', 'sleet'];
const WX_COND = { 'clear-day': 'dry', 'partly-cloudy-day': 'dry', cloudy: 'dry', rain: 'rain', fog: 'fog', wind: 'dry', thunderstorm: 'thunderstorm', snow: 'snow', sleet: 'sleet' };
const WMO_BY_ICON = { 'clear-day': 0, 'partly-cloudy-day': 2, cloudy: 3, rain: 61, fog: 45, wind: 1, thunderstorm: 95, snow: 71, sleet: 67 };

function weatherFor(lat, lon, nowMs, seed) {
  const cell = `${seed}:${Math.round(lat * 10)}:${Math.round(lon * 10)}:${Math.floor(nowMs / (30 * MIN))}`;
  const rng = createRng(hashString(cell));
  const icon = WX_ICONS[Math.floor(rng() * WX_ICONS.length)];
  const hour = +berlinParts(nowMs).hour;
  const night = hour < 6 || hour >= 21;
  const iconOut = night && icon === 'clear-day' ? 'clear-night' : (night && icon === 'partly-cloudy-day' ? 'partly-cloudy-night' : icon);
  const temperature = Math.round((8 + (54 - lat) * 1.2 + rng() * 10 - (night ? 4 : 0)) * 10) / 10;
  return {
    timestamp: toBerlinIso(Math.floor(nowMs / (10 * MIN)) * 10 * MIN),
    source_id: 1000 + (hashString(cell) % 500),
    cloud_cover: icon === 'clear-day' ? 5 : (icon === 'cloudy' ? 95 : 50),
    condition: WX_COND[icon],
    dew_point: temperature - 5,
    solar_10: null,
    precipitation_10: icon === 'rain' ? Math.round(rng() * 20) / 10 : 0,
    precipitation_30: null,
    precipitation_60: icon === 'rain' ? Math.round(rng() * 60) / 10 : 0,
    pressure_msl: 1005 + Math.round(rng() * 25),
    relative_humidity: 40 + Math.round(rng() * 55),
    visibility: icon === 'fog' ? 400 + Math.round(rng() * 800) : 20000 + Math.round(rng() * 30000),
    wind_direction_10: Math.round(rng() * 360),
    wind_speed_10: Math.round((icon === 'wind' ? 45 : 8) + rng() * 20),
    wind_gust_direction_10: Math.round(rng() * 360),
    wind_gust_speed_10: Math.round((icon === 'wind' ? 85 : 20) + rng() * 20),
    sunshine_30: null,
    sunshine_60: null,
    temperature,
    icon: iconOut,
    _wmo: WMO_BY_ICON[icon],
    _isDay: night ? 0 : 1,
  };
}

function alertsFor(lat, lon, nowMs) {
  const alerts = [];
  if (lat > 53.3) {
    alerts.push({
      id: 400000 + Math.round(lat * 100), alert_id: `2.49.0.0.276.0.DWD.MOCK.${Math.round(lat * 100)}`,
      effective: toBerlinIso(nowMs - 3 * 3600e3), onset: toBerlinIso(nowMs - 2 * 3600e3), expires: toBerlinIso(nowMs + 6 * 3600e3),
      category: 'met', response_type: 'prepare', urgency: 'immediate', severity: 'severe', certainty: 'likely',
      event_code: 51, event_en: 'wind gusts', event_de: 'STURMBÖEN',
      headline_en: 'Official WARNING of WIND GUSTS', headline_de: 'Amtliche WARNUNG vor STURMBÖEN',
      description_en: 'There is a risk of wind gusts (level 2 of 4). Max. gusts: ~ 85 km/h.',
      description_de: 'Es treten Sturmböen mit Geschwindigkeiten um 85 km/h (24 m/s, 9 Bft) aus westlicher Richtung auf. In exponierten Lagen muss mit schweren Sturmböen bis 100 km/h gerechnet werden.',
      instruction_en: 'Secure loose objects.', instruction_de: 'Achten Sie besonders auf herabfallende Gegenstände wie Äste und Dachziegel. Sichern Sie lose Gegenstände.',
    });
  }
  return { alerts, location: { warn_cell_id: 800000000 + Math.round(lat * 1000), name: 'Mock-Region', name_short: 'Mock', district: 'Mock-Kreis', state: lat > 51 ? 'Norddeutschland' : 'Süddeutschland', state_short: lat > 51 ? 'ND' : 'SD' } };
}

// ------------------------------------------------------------------ Server

/**
 * @param {object} [opts]
 * @param {number} [opts.seed]
 * @param {() => number} [opts.now]
 * @param {number} [opts.tripsPerCorridor]
 * @param {object} [opts.corridors] GeoJSON-FeatureCollection
 * @param {Array} [opts.hubs]
 * @param {(line: string) => void} [opts.log]
 */
export function createMockUpstream({ seed = 42, now = () => Date.now(), tripsPerCorridor = 2, corridors = corridorsGeoJson(), hubs = defaultHubs, log = () => {} } = {}) {
  let cache = { builtAt: -Infinity, trips: new Map() };
  const stats = { requests: 0, byPath: {} };

  function trips() {
    const t = now();
    if (t - cache.builtAt > 60 * MIN) {
      cache = { builtAt: t, trips: buildSchedule({ corridors, seed, tripsPerCorridor, fromMs: t - 8 * 3600e3, toMs: t + 4 * 3600e3 }) };
    }
    return cache.trips;
  }

  function board(kind, stationId, query) {
    const st = findStation(stationId);
    if (!st) return { status: 404, body: { error: true, msg: `Station ${stationId} nicht gefunden`, statusCode: 404 } };
    const whenMs = query.get('when') ? Date.parse(query.get('when')) : now();
    const duration = Math.min(60, Math.max(1, Number.parseInt(query.get('duration') || '10', 10) || 10));
    const endMs = whenMs + duration * MIN;
    const products = parseProducts(query);
    const items = [];
    for (const trip of trips().values()) {
      if (!products[trip.line.product]) continue;
      for (const so of trip.stopovers) {
        if (so.stop.id !== st.id) continue;
        const plannedMs = kind === 'departures' ? so._plannedDepMs : so._plannedArrMs;
        if (plannedMs == null) continue;
        if (plannedMs < whenMs - 1 || plannedMs > endMs) continue;
        const isCancelled = Boolean(trip.cancelled || so.cancelled);
        const item = {
          tripId: trip.id,
          stop: so.stop,
          when: isCancelled ? null : (kind === 'departures' ? so.departure : so.arrival),
          plannedWhen: kind === 'departures' ? so.plannedDeparture : so.plannedArrival,
          delay: isCancelled ? null : so._delaySec,
          platform: isCancelled ? null : (kind === 'departures' ? so.departurePlatform : so.arrivalPlatform),
          plannedPlatform: kind === 'departures' ? so.plannedDeparturePlatform : so.plannedArrivalPlatform,
          ...(kind === 'departures' ? { direction: trip.direction } : { provenance: trip.origin.name }),
          line: trip.line,
          remarks: trip.remarks.filter((r) => r.type !== 'hint' || r.code === 'BR').slice(0, 3),
          ...(isCancelled ? { cancelled: true } : {}),
          _sort: plannedMs,
        };
        items.push(item);
      }
    }
    items.sort((a, b) => a._sort - b._sort);
    return { status: 200, body: { [kind]: stripInternal(items), realtimeDataUpdatedAt: Math.floor(now() / 1000) } };
  }

  function handle(req, res) {
    stats.requests++;
    const url = new URL(req.url, 'http://mock.local');
    const path = url.pathname;
    stats.byPath[path.split('/').slice(0, 2).join('/')] = (stats.byPath[path.split('/').slice(0, 2).join('/')] || 0) + 1;
    log(`${req.method} ${path}`);
    const send = (status, body, headers = {}) => {
      const buf = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, ...headers });
      res.end(buf);
    };
    if (req.method !== 'GET') return send(405, { error: true, msg: 'Nur GET' });
    if (url.searchParams.get('simulate') === '429' || req.headers['x-mock-429']) {
      return send(429, { error: true, msg: 'rate limited (simuliert)' }, { 'retry-after': '2' });
    }
    if (url.searchParams.get('simulate') === '500') return send(500, { error: true, msg: 'server error (simuliert)' });

    let m;
    if ((m = path.match(/^\/stops\/(\d+)\/(departures|arrivals)$/))) {
      const r = board(m[2], m[1], url.searchParams);
      return send(r.status, r.body);
    }
    if ((m = path.match(/^\/trips\/(.+)$/))) {
      const id = decodeURIComponent(m[1]);
      const trip = trips().get(id);
      if (!trip) return send(404, { error: true, msg: 'Fahrt nicht gefunden', statusCode: 404 });
      const withPolyline = url.searchParams.get('polyline') === 'true';
      const out = stripInternal(trip);
      if (!withPolyline) delete out.polyline;
      else if (!out.polyline) delete out.polyline;
      if (url.searchParams.get('stopovers') === 'false') delete out.stopovers;
      if (url.searchParams.get('remarks') === 'false') delete out.remarks;
      return send(200, { trip: out, realtimeDataUpdatedAt: Math.floor(now() / 1000) });
    }
    if (path === '/locations') {
      const q = url.searchParams.get('query') || '';
      const results = Math.min(20, Number.parseInt(url.searchParams.get('results') || '5', 10) || 5);
      return send(200, searchStations(q, results).map((s) => ({ type: 'station', id: s.id, name: s.name, location: { type: 'location', latitude: s.lat, longitude: s.lon } })));
    }
    if (path === '/current_weather' || path === '/alerts') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(400, { title: 'Bad Request', description: 'lat/lon fehlen' });
      if (path === '/alerts') return send(200, alertsFor(lat, lon, now()));
      const w = stripInternal(weatherFor(lat, lon, now(), seed));
      return send(200, { weather: w, sources: [{ id: w.source_id, dwd_station_id: String(w.source_id), observation_type: 'current', lat, lon, height: 50, station_name: 'Mock-Station', distance: 1200, first_record: null, last_record: null }] });
    }
    if (path === '/v1/forecast') {
      const lats = (url.searchParams.get('latitude') || '').split(',').map(Number);
      const lons = (url.searchParams.get('longitude') || '').split(',').map(Number);
      if (lats.length !== lons.length || lats.some((v) => !Number.isFinite(v)) || lons.some((v) => !Number.isFinite(v))) {
        return send(400, { error: true, reason: 'latitude/longitude ungültig' });
      }
      const items = lats.map((lat, i) => {
        const w = weatherFor(lat, lons[i], now(), seed);
        return {
          latitude: lat, longitude: lons[i], generationtime_ms: 0.1, utc_offset_seconds: 7200, timezone: 'Europe/Berlin', timezone_abbreviation: 'CEST', elevation: 50,
          current_units: { time: 'iso8601', interval: 'seconds', temperature_2m: '°C', relative_humidity_2m: '%', precipitation: 'mm', weather_code: 'wmo code', wind_speed_10m: 'km/h', wind_direction_10m: '°', wind_gusts_10m: 'km/h', is_day: '' },
          current: { time: w.timestamp.slice(0, 16), interval: 900, temperature_2m: w.temperature, relative_humidity_2m: w.relative_humidity, precipitation: w.precipitation_10, weather_code: w._wmo, wind_speed_10m: w.wind_speed_10, wind_direction_10m: w.wind_direction_10, wind_gusts_10m: w.wind_gust_speed_10, is_day: w._isDay },
        };
      });
      return send(200, items.length === 1 ? items[0] : items);
    }
    if (path === '/style/style.json') {
      return send(200, { version: 8, name: 'Mock-Basiskarte', sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8ecef' } }] });
    }
    if (path === '/health') return send(200, { ok: true, trips: trips().size, hubs: hubs.length });
    return send(404, { error: true, msg: 'Unbekannter Endpunkt', statusCode: 404 });
  }

  const server = http.createServer(handle);
  let url = null;
  return {
    server,
    stats,
    trips,
    listen(port = 3999, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const a = server.address();
          url = `http://${host}:${a.port}`;
          resolve(url);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    get url() { return url; },
  };
}

// Direktstart
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number.parseInt(process.env.MOCK_PORT || '3999', 10);
  const mock = createMockUpstream({ log: (l) => process.stderr.write(`[mock] ${l}\n`) });
  mock.listen(port, process.env.MOCK_HOST || '127.0.0.1').then((u) => {
    process.stderr.write(`[mock] Mock-Upstream läuft auf ${u} (${mock.trips().size} Fahrten im Zeitfenster)\n`);
  }).catch((err) => {
    process.stderr.write(`[mock] Start fehlgeschlagen: ${err.message}\n`);
    process.exit(1);
  });
}
