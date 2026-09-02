/**
 * Eigene HTTP-API (nur GET, JSON). Alle Live-Antworten stammen aus dem Cache der Dienste;
 * pro Client-Anfrage wird keine Upstream-Abfrage ausgelöst (Ausnahmen: Abfahrtstafel und
 * Detail-Aktualisierung – budgetiert und gebündelt im Poller).
 */
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { publicConfig } from '../config.js';
import { NotFoundError, isAppError } from '../lib/errors.js';
import { computePosition, tripToFeature } from '../transport/position.js';
import { capitals, capitalsGeoJson } from '../data/capitals.js';
import { hubs, hubsById } from '../data/hubs.js';
import { findStation, searchStations } from '../data/stations.js';
import { corridorsGeoJson } from '../data/corridors.js';
import { parseStationId, parseTripId, parseProducts, parseBbox, parseLatLon, parseBool, parseQuery } from './validate.js';
import { createTokenBucket } from '../lib/token-bucket.js';
import { AppError } from '../lib/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ATTRIBUTIONS = Object.freeze([
  { name: 'Fahrplan- und Echtzeitdaten', text: 'Fahrplan- und Echtzeitdaten: Deutsche Bahn AG, abgerufen über v6.db.transport.rest (inoffizielle Community-API). Alle Angaben ohne Gewähr.', url: 'https://v6.db.transport.rest/' },
  { name: 'Wetter (DWD)', text: 'Datenbasis: Deutscher Wetterdienst (DWD), bereitgestellt über Bright Sky.', url: 'https://brightsky.dev/' },
  { name: 'Wetter (Fallback)', text: 'Wetterdaten: Open-Meteo.com (CC BY 4.0).', url: 'https://open-meteo.com/' },
  { name: 'Kartendaten', text: '© OpenStreetMap-Mitwirkende (ODbL 1.0). Darstellung mit MapLibre GL JS und PMTiles (BSD-3-Clause).', url: 'https://www.openstreetmap.org/copyright' },
  { name: 'Stationsdaten', text: 'Stationsdaten: © Deutsche Bahn AG / DB InfraGO AG (Station Data, StaDa), CC BY 4.0, aufbereitet über db-stations; gekürzt und umformatiert.', url: 'https://data.deutschebahn.com/' },
  { name: 'Bundesländergrenzen', text: 'Bundesländergrenzen: deutschlandGeoJSON (isellsoap, Unlicense), Rohdaten GADM/DIVA-GIS (nur nicht-kommerzielle Nutzung); für kommerzielle Nutzung durch © GeoBasis-DE / BKG dl-de/by-2-0 ersetzen.', url: 'https://github.com/isellsoap/deutschlandGeoJSON' },
  { name: 'ICE-Korridore, Landeshauptstädte, Knoten', text: 'Eigene Datensätze dieses Projekts (CC BY 4.0), Stützpunkte aus dem Stationsverzeichnis; schematisch, nicht gleisgenau.', url: null },
]);

export const DISCLAIMER = 'Diese Karte ist ein privates, inoffizielles Angebot und keine Reiseauskunft. Positionen sind aus Fahrplan- und Echtzeitdaten berechnet und können von der tatsächlichen Lage abweichen. Verbindliche Fahrplan-, Gleis- und Störungsinformationen erhalten Sie ausschließlich von der Deutschen Bahn. Eine Gewähr für Richtigkeit, Vollständigkeit und Verfügbarkeit wird nicht übernommen. Nicht mit der Deutschen Bahn AG verbunden; ICE, IC und DB sind Marken der Deutschen Bahn AG und werden hier nur beschreibend verwendet.';

function staticJson(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 27)}"`;
  return { body, etag };
}

function sendStatic(res, req, cached) {
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('ETag', cached.etag);
  res.type('application/json; charset=utf-8');
  if (req.headers['if-none-match'] === cached.etag) return res.status(304).end();
  return res.send(cached.body);
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

/** Zusammenfassung einer Abfahrtstafel für die Bahnhofsübersicht. */
export function boardSummary(board, nowMs) {
  if (!board || !Array.isArray(board.departures)) return null;
  const deps = board.departures;
  let delayed = 0;
  let cancelled = 0;
  let sum = 0;
  let count = 0;
  let max = 0;
  for (const d of deps) {
    if (d.cancelled) { cancelled += 1; continue; }
    if (typeof d.delaySec === 'number') {
      const min = Math.round(d.delaySec / 60);
      sum += Math.max(0, min);
      count += 1;
      if (min > 5) delayed += 1;
      if (min > max) max = min;
    }
  }
  return {
    fetchedAt: board.fetchedAt ?? nowMs,
    departures: deps.length,
    delayed,
    cancelled,
    avgDelayMin: count ? Math.round((sum / count) * 10) / 10 : 0,
    maxDelayMin: max,
    next: deps.slice(0, 5).map((d) => ({
      tripId: d.tripId,
      line: d.lineName,
      direction: d.direction,
      when: d.when || d.plannedWhen,
      plannedWhen: d.plannedWhen,
      delayMin: typeof d.delaySec === 'number' ? Math.round(d.delaySec / 60) : null,
      platform: d.platform || d.plannedPlatform || null,
      cancelled: Boolean(d.cancelled),
    })),
  };
}

function stripTrip(trip) {
  if (!trip) return null;
  const { polyline, ...rest } = trip;
  return rest;
}

/**
 * @param {{config:object, services:object, logger:object, now?:() => number, startedAt?:number}} deps
 */
export function createApiRouter({ config, services, logger, now = () => Date.now(), startedAt = Date.now() }) {
  const router = Router();
  const { poller, store, disruptions, corridors, weather, geometryCache } = services;
  const routeBetween = corridors && typeof corridors.routeBetween === 'function' ? corridors.routeBetween : undefined;
  const positionOpts = { routeBetween, geometryCache };
  // Kontingent für Upstream-Abrufe, die unmittelbar durch Client-Anfragen ausgelöst werden
  // (Schutz des Poller-Budgets vor absichtlicher Erschöpfung durch einzelne Clients).
  const clientBucket = services.clientBucket || createTokenBucket({ ratePerMin: config.security.clientUpstreamPerMin, burst: Math.max(1, Math.ceil(config.security.clientUpstreamPerMin / 3)), now });
  const takeClientBudget = () => {
    if (!clientBucket.tryTake(1)) {
      throw new AppError('Das Kontingent für nutzerausgelöste Datenabrufe ist vorübergehend erschöpft. Bitte in einer Minute erneut versuchen.', { statusCode: 429, code: 'RATE_LIMITED' });
    }
  };

  const statics = {
    corridors: staticJson(corridorsGeoJson()),
    bundeslaender: staticJson(JSON.parse(readFileSync(join(__dirname, '..', 'data', 'bundeslaender.geo.json'), 'utf8'))),
    capitals: staticJson(capitalsGeoJson()),
  };

  router.get('/health', (req, res) => {
    noStore(res);
    res.json({ status: 'ok', version: config.app.version, uptimeSec: Math.round((now() - startedAt) / 1000) });
  });

  router.get('/status', (req, res) => {
    noStore(res);
    let weatherStats = { enabled: false };
    try {
      weatherStats = weather && typeof weather.stats === 'function' ? weather.stats() : { enabled: false };
    } catch (err) {
      logger.warn('Wetter-Statistik fehlgeschlagen', { err });
    }
    res.json({
      now: new Date(now()).toISOString(),
      demo: config.demo,
      poller: poller.stats(),
      weather: weatherStats,
      disruptions: { count: disruptions ? disruptions.list().length : 0 },
    });
  });

  router.get('/config', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ...publicConfig(config), attributions: ATTRIBUTIONS, disclaimer: DISCLAIMER });
  });

  router.get('/trains', (req, res) => {
    noStore(res);
    const products = parseProducts(req.query.product, null);
    const bbox = parseBbox(req.query.bbox);
    const includeScheduled = parseBool(req.query.includeScheduled, false, 'includeScheduled');
    const includeFinished = parseBool(req.query.includeFinished, false, 'includeFinished');
    const t = now();
    const features = [];
    let tracked = 0;
    let newestFetch = null;
    for (const record of store.all()) {
      if (!record.trip) continue;
      tracked += 1;
      const trip = record.trip;
      if (products && !products.includes(trip.product)) continue;
      let position = null;
      try {
        position = computePosition(trip, t, positionOpts);
      } catch (err) {
        logger.warn('Positionsberechnung fehlgeschlagen', { tripId: trip.id, err });
        continue;
      }
      if (!position) continue;
      if (position.state === 'scheduled' && !includeScheduled) continue;
      if (position.state === 'finished' && !includeFinished) continue;
      const feature = tripToFeature(trip, position);
      if (!feature) continue;
      if (bbox) {
        const [lon, lat] = feature.geometry.coordinates;
        if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      }
      if (record.lastFetchedAt && (newestFetch === null || record.lastFetchedAt > newestFetch)) newestFetch = record.lastFetchedAt;
      features.push(feature);
    }
    const stats = poller.stats();
    const refAt = stats.lastRefreshAt ?? newestFetch;
    res.json({
      type: 'FeatureCollection',
      features,
      meta: {
        generatedAt: new Date(t).toISOString(),
        count: features.length,
        tracked,
        dataAgeSec: refAt ? Math.max(0, Math.round((t - refAt) / 1000)) : null,
      },
    });
  });

  router.get('/trains/:tripId', async (req, res) => {
    noStore(res);
    const tripId = parseTripId(req.params.tripId);
    const refresh = parseBool(req.query.refresh, false, 'refresh');
    let record = store.get(tripId) || null;
    let stale = false;
    let refreshError = null;
    // Nur bekannte (vom Poller entdeckte) Fahrten dürfen einen Upstream-Abruf auslösen
    if (!record) throw new NotFoundError('Fahrt nicht gefunden.');
    if (refresh || !record.trip) {
      const fresh = record.trip && record.lastFetchedAt !== null && now() - record.lastFetchedAt <= 60_000;
      if (!fresh) takeClientBudget();
      try {
        record = await poller.refreshTrip(tripId, { maxAgeMs: refresh ? 60_000 : config.transport.tripRefreshMinSec * 1000 });
      } catch (err) {
        refreshError = err;
        if (!(record && record.trip)) {
          if (isAppError(err) && (err.statusCode === 404 || err.upstreamStatus === 404)) throw new NotFoundError('Fahrt nicht gefunden.');
          throw err;
        }
        stale = true;
      }
    }
    if (!record || !record.trip) throw new NotFoundError('Fahrt nicht gefunden.');
    const trip = record.trip;
    const t = now();
    const position = computePosition(trip, t, positionOpts);
    const polyline = Array.isArray(trip.polyline) && trip.polyline.length >= 2 ? { type: 'LineString', coordinates: trip.polyline } : null;
    const body = {
      trip: stripTrip(trip),
      position,
      polyline,
      geometry: { source: position ? position.source : null },
      fetchedAt: record.lastFetchedAt,
      generatedAt: new Date(t).toISOString(),
    };
    if (stale) {
      body.stale = true;
      body.refreshError = refreshError && refreshError.code ? refreshError.code : 'UPSTREAM_ERROR';
    }
    res.json(body);
  });

  router.get('/disruptions', (req, res) => {
    noStore(res);
    res.json({ generatedAt: new Date(now()).toISOString(), items: disruptions ? disruptions.list() : [] });
  });

  router.get('/stations', (req, res) => {
    noStore(res);
    const t = now();
    let wx = null;
    try {
      wx = weather && typeof weather.current === 'function' ? weather.current() : null;
    } catch (err) {
      logger.warn('Wetterdaten nicht lesbar', { err });
    }
    const wxByStation = new Map();
    for (const item of (wx && wx.items) || []) if (item && item.stationId) wxByStation.set(item.stationId, item);
    res.json({
      generatedAt: new Date(t).toISOString(),
      capitals: capitals.map((c) => {
        const w = wxByStation.get(c.stationId);
        return { ...c, board: boardSummary(poller.getBoard(c.stationId), t), weather: w ? w.weather : null, alerts: w ? w.alerts || [] : [] };
      }),
      hubs: hubs.map((h) => ({ ...h, board: boardSummary(poller.getBoard(h.id), t) })),
    });
  });

  router.get('/stations/search', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    const q = parseQuery(req.query.q, 2, 64);
    res.json(searchStations(q, 10).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })));
  });

  router.get('/stations/:id/departures', async (req, res) => {
    noStore(res);
    const id = parseStationId(req.params.id);
    const st = hubsById.get(id) || findStation(id);
    if (!st) throw new NotFoundError('Bahnhof nicht im Verzeichnis.');
    const cached = poller.getBoard(id);
    if (!cached || now() - cached.fetchedAt > config.transport.boardCacheSec * 1000) takeClientBudget();
    const board = await poller.requestBoard(id, { maxAgeMs: config.transport.boardCacheSec * 1000 });
    res.json({
      station: { id: st.id, name: st.name, lat: st.lat, lon: st.lon },
      fetchedAt: board.fetchedAt,
      departures: board.departures || [],
    });
  });

  router.get('/weather', (req, res) => {
    noStore(res);
    if (!weather || typeof weather.current !== 'function') return res.json({ enabled: false, updatedAt: null, provider: null, attribution: null, items: [] });
    return res.json({ enabled: true, ...weather.current() });
  });

  router.get('/weather/point', async (req, res) => {
    noStore(res);
    const { lat, lon } = parseLatLon(req.query);
    if (!weather || typeof weather.pointWeather !== 'function') return res.json({ enabled: false, weather: null, lat, lon });
    const w = await weather.pointWeather(lat, lon);
    return res.json({ weather: w || null, lat, lon });
  });

  router.get('/corridors', (req, res) => sendStatic(res, req, statics.corridors));
  router.get('/bundeslaender', (req, res) => sendStatic(res, req, statics.bundeslaender));
  router.get('/capitals', (req, res) => sendStatic(res, req, statics.capitals));

  router.use((req, res) => {
    noStore(res);
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unbekannter API-Endpunkt.' } });
  });

  return router;
}
