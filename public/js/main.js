/**
 * Einstiegspunkt: lädt Konfiguration und Daten, verdrahtet Karte und Oberfläche,
 * steuert die Aktualisierungszyklen (pausiert bei verborgenem Tab).
 */
import { createStore, createPrefs } from './state.js';
import { createApi } from './api.js';
import { createMapController } from './map.js';
import { createUi } from './ui.js';

const INTERVALS = { trains: 15000, disruptions: 60000, stations: 60000, weather: 300000, status: 30000, selected: 30000 };

async function boot() {
  const store = createStore({ filters: {}, trains: null, disruptions: [], stations: null, weather: null, status: null, config: null, selectedTripId: null, selectedTrip: null, apiError: false, lastGoodAt: null });
  const prefs = createPrefs((() => { try { return window.localStorage; } catch { return null; } })());
  const api = createApi();
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let config;
  try {
    config = await api.config();
  } catch (err) {
    document.getElementById('banner').textContent = `Konfiguration konnte nicht geladen werden (${err.message}). Bitte Seite neu laden.`;
    document.getElementById('banner').hidden = false;
    return;
  }
  store.set({ config });

  let ui = null;
  const map = createMapController({
    container: 'karte', config, reducedMotion,
    handlers: {
      onTrainClick: (p) => ui && ui.selectTrain(p.tripId),
      onCapitalClick: (p) => ui && ui.openStation({ id: p.stationId, name: p.stationName, lat: null, lon: null }),
      onDisruptionClick: (id) => {
        const d = (store.get().disruptions || []).find((x) => x.id === id);
        if (d && ui) { ui.activateTab('stoerungen'); ui.focusDisruption(d); }
      },
      onStyleError: (msg) => ui && ui.showBanner(`Kartenstil nicht erreichbar (${msg}) – Ersatz-Basiskarte ohne Kartendetails aktiv. Prüfen Sie MAP_STYLE_URL und CORS am Kartenserver.`, 'karte'),
    },
  });
  ui = createUi({ store, api, map, config, prefs });

  await map.ready;
  const results = await Promise.allSettled([api.bundeslaender(), api.corridors(), api.capitals()]);
  if (results[0].status === 'fulfilled') map.setBundeslaender(results[0].value);
  if (results[1].status === 'fulfilled') map.setCorridors(results[1].value);
  if (results[2].status === 'fulfilled') map.setCapitals(results[2].value);

  const routeCache = new Map();
  let routesInFlight = false;
  async function updateRoutes() {
    if (!map.getVisibility().routen || routesInFlight) return;
    routesInFlight = true;
    try {
      const trains = store.get().trains ? store.get().trains.features : [];
      const missing = trains.filter((f) => f.properties.hasPolyline && !routeCache.has(f.properties.tripId)).slice(0, 25);
      for (const f of missing) {
        try {
          const d = await api.train(f.properties.tripId);
          routeCache.set(f.properties.tripId, d.polyline ? d.polyline.coordinates : null);
        } catch { routeCache.set(f.properties.tripId, null); }
        await new Promise((r) => setTimeout(r, 400));
      }
      const active = new Set(trains.map((f) => f.properties.tripId));
      map.setRoutes(new Map([...routeCache].filter(([id]) => active.has(id))));
    } finally {
      routesInFlight = false;
    }
  }

  const loaders = {
    trains: async () => {
      const fc = await api.trains({ includeScheduled: 'true' });
      store.set({ trains: fc, apiError: false, lastGoodAt: Date.now() });
      map.setTrains(fc, { tweenMs: INTERVALS.trains });
      map.setWeather((store.get().weather || {}).items || []);
      updateRoutes();
    },
    disruptions: async () => { const d = await api.disruptions(); store.set({ disruptions: d.items || [] }); map.setDisruptions(d.items || []); },
    stations: async () => { const s = await api.stations(); store.set({ stations: s }); },
    weather: async () => { const w = await api.weather(); store.set({ weather: w }); map.setWeather(w.items || []); },
    status: async () => { const s = await api.status(); store.set({ status: s }); },
    selected: async () => {
      const id = store.get().selectedTripId;
      if (!id) return;
      const d = await api.train(id);
      if (store.get().selectedTripId === id) { store.set({ selectedTrip: d }); ui.renderTrainDetail(d); }
    },
  };

  const timers = {};
  let consecutiveErrors = 0;
  function schedule(name) {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(() => run(name), INTERVALS[name]);
  }
  async function run(name) {
    if (document.hidden) { schedule(name); return; }
    try {
      await loaders[name]();
      if (name === 'trains') { consecutiveErrors = 0; ui.hideBanner('daten'); }
    } catch (err) {
      if (name === 'trains') {
        consecutiveErrors++;
        store.set({ apiError: consecutiveErrors >= 2 });
        if (consecutiveErrors >= 2) ui.showBanner(`Datenquelle nicht erreichbar (${err.message}) – es werden die letzten bekannten Daten angezeigt.`, 'daten');
      }
    } finally {
      schedule(name);
    }
  }
  for (const name of Object.keys(loaders)) run(name);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const name of Object.keys(loaders)) run(name); });
  document.querySelector('input[data-ebene="routen"]').addEventListener('change', () => updateRoutes());
  window.addEventListener('resize', () => map.resize());
}

boot().catch((err) => {
  const banner = document.getElementById('banner');
  banner.textContent = `Die Anwendung konnte nicht gestartet werden: ${err && err.message ? err.message : err}`;
  banner.hidden = false;
});
