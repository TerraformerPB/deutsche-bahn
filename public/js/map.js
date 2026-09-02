/**
 * Kartensteuerung: MapLibre GL JS mit PMTiles-Protokoll, Overlays (Bundesländer, ICE-Korridore,
 * Züge, Störungen, Landeshauptstädte mit Wetter) und sanfter Positionsanimation.
 */
import * as maplibregl from '/vendor/maplibre-gl.mjs';
import { STATUS_COLORS, fmtDelay, statusLabel } from './format.js';
import { createWeatherIcon } from './weather-icons.js';

const EMPTY = { type: 'FeatureCollection', features: [] };
const FALLBACK_STYLE = {
  version: 8,
  name: 'Ersatz-Basiskarte',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dfe6ec' } }],
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const LABEL_OFFSETS = { 'DE-BE': [-10, -13], 'DE-BB': [-10, 13], 'DE-HE': [-10, -13], 'DE-RP': [-10, 13] };

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function starSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'stern');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M12 2.5l2.9 6.2 6.8.8-5 4.6 1.3 6.7L12 17.5l-6 3.3 1.3-6.7-5-4.6 6.8-.8z');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('stroke', '#5a4200');
  p.setAttribute('stroke-width', '1');
  svg.appendChild(p);
  return svg;
}

const statusMatch = ['match', ['get', 'status'],
  'on_time', STATUS_COLORS.on_time,
  'slight', STATUS_COLORS.slight,
  'delayed', STATUS_COLORS.delayed,
  'heavy', STATUS_COLORS.heavy,
  'cancelled', STATUS_COLORS.cancelled,
  STATUS_COLORS.unknown];

/**
 * @param {{container:string, config:object, handlers?:object, reducedMotion?:boolean}} opts
 */
export function createMapController({ container, config, handlers = {}, reducedMotion = false }) {
  if (globalThis.pmtiles && globalThis.pmtiles.Protocol) {
    const protocol = new globalThis.pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
  }
  const styleUrl = config.map.mode === 'vector' && config.map.styleUrl ? config.map.styleUrl : '/map/style.json';

  const map = new maplibregl.Map({
    container,
    style: styleUrl,
    center: config.map.center,
    zoom: config.map.zoom,
    minZoom: 3.5,
    maxZoom: 16,
    attributionControl: false,
    hash: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  // Lizenzbedingung ODbL: Attribution dauerhaft sichtbar, nicht eingeklappt
  map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: config.map.attribution }));
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');

  const data = {
    bundeslaender: EMPTY, corridors: EMPTY, trains: EMPTY, disruptionSegments: EMPTY, disruptionStops: EMPTY,
    selectedRoute: EMPTY, routes: EMPTY,
  };
  const visibility = { zuege: true, korridore: true, hauptstaedte: true, bundeslaender: true, stoerungen: true, wetter: true, routen: false, labels: true };
  const markers = new Map();
  let styleReady = false;
  let fallbackApplied = false;
  let fontStack = null;
  let selectedTripId = null;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  let hoverPopup = null;

  function detectFont() {
    fontStack = null;
    const style = map.getStyle();
    if (!style || !style.glyphs) return;
    for (const layer of style.layers || []) {
      const f = layer.layout && layer.layout['text-font'];
      if (Array.isArray(f) && f.length && typeof f[0] === 'string') { fontStack = f; return; }
      if (f && typeof f === 'object' && !Array.isArray(f) && Array.isArray(f.stops) && f.stops[0] && Array.isArray(f.stops[0][1])) { fontStack = f.stops[0][1]; return; }
    }
  }

  function ensureSource(id, fc) {
    if (map.getSource(id)) map.getSource(id).setData(fc);
    else map.addSource(id, { type: 'geojson', data: fc, promoteId: 'id' });
  }

  function addOverlays() {
    ensureSource('bundeslaender', data.bundeslaender);
    ensureSource('corridors', data.corridors);
    ensureSource('routes', data.routes);
    ensureSource('disruptionSegments', data.disruptionSegments);
    ensureSource('selectedRoute', data.selectedRoute);
    ensureSource('disruptionStops', data.disruptionStops);
    ensureSource('trains', data.trains);

    const add = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
    add({ id: 'bl-fill', type: 'fill', source: 'bundeslaender', paint: { 'fill-color': '#5b7f95', 'fill-opacity': 0.05 } });
    add({ id: 'bl-line', type: 'line', source: 'bundeslaender', paint: { 'line-color': '#5b6f84', 'line-width': 1.2, 'line-dasharray': [3, 2], 'line-opacity': 0.8 } });
    add({
      id: 'korridore', type: 'line', source: 'corridors',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'kind'], 'SFS', '#7b2d8e', 'ABS', '#1f78b4', '#5b7f95'],
        'line-width': ['interpolate', ['linear'], ['zoom'],
          4, ['match', ['get', 'kind'], 'SFS', 2.2, 'ABS', 1.6, 1.1],
          10, ['match', ['get', 'kind'], 'SFS', 6, 'ABS', 4.5, 3]],
        'line-opacity': 0.85,
      },
    });
    add({ id: 'routen', type: 'line', source: 'routes', paint: { 'line-color': '#4d5f70', 'line-width': 1.6, 'line-opacity': 0.55 } });
    add({ id: 'stoerung-segmente', type: 'line', source: 'disruptionSegments', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#d7263d', 'line-width': 5, 'line-dasharray': [1.5, 1.2], 'line-opacity': 0.85 } });
    add({ id: 'route-ausgewaehlt', type: 'line', source: 'selectedRoute', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1f5f8b', 'line-width': 4, 'line-opacity': 0.85 } });
    add({ id: 'stoerung-halte', type: 'circle', source: 'disruptionStops', paint: { 'circle-color': '#d7263d', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 5, 10, 9], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-opacity': 0.9 } });
    add({
      id: 'zuege-ausgewaehlt', type: 'circle', source: 'trains',
      filter: ['==', ['get', 'tripId'], selectedTripId || ''],
      paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 10, 12, 16], 'circle-stroke-color': '#1f5f8b', 'circle-stroke-width': 3 },
    });
    add({
      id: 'zuege', type: 'circle', source: 'trains',
      paint: {
        'circle-color': statusMatch,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4.5, 8, 7, 12, 10],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-opacity': ['case', ['boolean', ['get', 'cancelled'], false], 0.7, 1],
      },
    });
    if (fontStack) {
      add({
        id: 'zuege-label', type: 'symbol', source: 'trains', minzoom: 6.5,
        layout: { 'text-field': ['get', 'line'], 'text-font': fontStack, 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#1c2430', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      });
    }
  }

  function setVis(layerId, visible) {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }

  function applyVisibility() {
    if (!styleReady) return;
    setVis('bl-fill', visibility.bundeslaender);
    setVis('bl-line', visibility.bundeslaender);
    setVis('korridore', visibility.korridore);
    setVis('routen', visibility.routen);
    setVis('stoerung-segmente', visibility.stoerungen);
    setVis('stoerung-halte', visibility.stoerungen);
    setVis('zuege', visibility.zuege);
    setVis('zuege-ausgewaehlt', visibility.zuege);
    setVis('zuege-label', visibility.zuege && visibility.labels);
    for (const m of markers.values()) {
      m.element.hidden = !visibility.hauptstaedte;
      m.weatherEl.hidden = !visibility.wetter;
    }
  }

  function popupContent(lines) {
    const box = el('div');
    lines.forEach(([text, cls], i) => box.appendChild(el('div', cls || (i === 0 ? 'popup-titel' : 'popup-zeile'), text)));
    return box;
  }

  function showHover(lngLat, lines) {
    if (!hoverPopup) hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: '280px' });
    hoverPopup.setLngLat(lngLat).setDOMContent(popupContent(lines)).addTo(map);
  }
  function hideHover() {
    if (hoverPopup) hoverPopup.remove();
  }

  function wireInteractions() {
    map.on('mousemove', 'zuege', (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const f = e.features && e.features[0];
      if (!f) return;
      const p = f.properties;
      showHover(f.geometry.coordinates, [
        [`${p.line} → ${p.direction || p.destination || ''}`],
        [`${statusLabel(p.status)} (${fmtDelay(p.delayMin)})`, `popup-zeile status-${p.status}`],
        [p.nextStop ? `nächster Halt: ${p.nextStop}` : ''],
      ].filter((l) => l[0]));
    });
    map.on('mouseleave', 'zuege', () => { map.getCanvas().style.cursor = ''; hideHover(); });
    map.on('click', 'zuege', (e) => {
      const f = e.features && e.features[0];
      if (f && handlers.onTrainClick) handlers.onTrainClick(f.properties);
    });
    for (const id of ['stoerung-halte', 'stoerung-segmente']) {
      map.on('mousemove', id, (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const f = e.features && e.features[0];
        if (f) showHover(e.lngLat, [[f.properties.summary || 'Störung'], [f.properties.text ? String(f.properties.text).slice(0, 160) : '']].filter((l) => l[0]));
      });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; hideHover(); });
      map.on('click', id, (e) => {
        const f = e.features && e.features[0];
        if (f && handlers.onDisruptionClick) handlers.onDisruptionClick(f.properties.id);
      });
    }
    map.on('mousemove', 'korridore', (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      const p = f.properties;
      let lines = [];
      try { lines = JSON.parse(p.lines || '[]'); } catch { lines = []; }
      showHover(e.lngLat, [[p.name], [`${p.kind}${p.vmax ? ` · bis ${p.vmax} km/h` : ''}${p.lengthKm ? ` · ${p.lengthKm} km` : ''}`], [lines.length ? `Linien: ${lines.join(', ')}` : '']].filter((l) => l[0]));
    });
    map.on('mouseleave', 'korridore', hideHover);
  }

  map.on('style.load', () => {
    detectFont();
    addOverlays();
    styleReady = true;
    applyVisibility();
    readyResolve();
  });
  map.on('error', (e) => {
    const msg = e && e.error && e.error.message ? e.error.message : String(e && e.error || 'Kartenfehler');
    if (!styleReady && !fallbackApplied) {
      fallbackApplied = true;
      if (handlers.onStyleError) handlers.onStyleError(msg);
      map.setStyle(FALLBACK_STYLE);
    } else if (handlers.onMapError) {
      handlers.onMapError(msg);
    }
  });
  setTimeout(() => {
    if (!styleReady && !fallbackApplied) {
      fallbackApplied = true;
      if (handlers.onStyleError) handlers.onStyleError('Zeitüberschreitung beim Laden des Kartenstils');
      map.setStyle(FALLBACK_STYLE);
    }
  }, 15000);
  wireInteractions();

  // ---------------------------------------------------------------- Animation der Zugpositionen
  const tweens = new Map();
  let rafId = null;
  let lastFrame = 0;

  function frame(now) {
    rafId = null;
    if (now - lastFrame < 100) { rafId = requestAnimationFrame(frame); return; }
    lastFrame = now;
    let active = false;
    const features = data.trains.features.map((f) => {
      const tw = tweens.get(f.properties.tripId);
      if (!tw) return f;
      const t = Math.min(1, (now - tw.start) / tw.dur);
      if (t < 1) active = true;
      const lon = tw.from[0] + (tw.to[0] - tw.from[0]) * t;
      const lat = tw.from[1] + (tw.to[1] - tw.from[1]) * t;
      return { ...f, geometry: { type: 'Point', coordinates: [lon, lat] } };
    });
    const src = map.getSource('trains');
    if (src) src.setData({ type: 'FeatureCollection', features });
    if (active) rafId = requestAnimationFrame(frame);
    else tweens.clear();
  }

  function setTrains(fc, { tweenMs = 15000 } = {}) {
    const prev = new Map();
    for (const f of data.trains.features) prev.set(f.properties.tripId, f.geometry.coordinates);
    data.trains = fc || EMPTY;
    if (!styleReady) return;
    if (reducedMotion) {
      tweens.clear();
      map.getSource('trains').setData(data.trains);
      return;
    }
    const now = performance.now();
    tweens.clear();
    for (const f of data.trains.features) {
      const from = prev.get(f.properties.tripId);
      if (from && f.properties.state === 'en_route') tweens.set(f.properties.tripId, { from, to: f.geometry.coordinates, start: now, dur: tweenMs });
    }
    // Sofort mit alten Positionen zeichnen, dann animieren
    const src = map.getSource('trains');
    src.setData({ type: 'FeatureCollection', features: data.trains.features.map((f) => {
      const tw = tweens.get(f.properties.tripId);
      return tw ? { ...f, geometry: { type: 'Point', coordinates: tw.from } } : f;
    }) });
    if (tweens.size && !rafId) rafId = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- Landeshauptstädte
  function setCapitals(fc) {
    for (const m of markers.values()) m.marker.remove();
    markers.clear();
    for (const f of fc.features || []) {
      const p = f.properties;
      const root = el('div', 'marker-hauptstadt');
      root.setAttribute('role', 'button');
      root.setAttribute('tabindex', '0');
      root.setAttribute('aria-label', `${p.city}, Landeshauptstadt von ${p.state}`);
      root.appendChild(starSvg());
      root.appendChild(el('span', 'name', p.city));
      const weatherEl = el('span', 'wetter');
      weatherEl.hidden = true;
      root.appendChild(weatherEl);
      const open = () => { if (handlers.onCapitalClick) handlers.onCapitalClick(p); };
      root.addEventListener('click', (ev) => { ev.stopPropagation(); open(); });
      root.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
      // Nahe beieinander liegende Hauptstädte (Berlin/Potsdam, Wiesbaden/Mainz) versetzt beschriften
      const offset = LABEL_OFFSETS[p.stateId] || [-10, 0];
      const marker = new maplibregl.Marker({ element: root, anchor: 'left', offset }).setLngLat(f.geometry.coordinates).addTo(map);
      markers.set(p.stationId, { marker, element: root, weatherEl, props: p });
    }
    applyVisibility();
  }

  function setWeather(items) {
    for (const item of items || []) {
      const m = markers.get(item.stationId);
      if (!m) continue;
      const w = item.weather;
      m.weatherEl.replaceChildren();
      if (!w) { m.weatherEl.hidden = true; continue; }
      m.weatherEl.appendChild(createWeatherIcon(w.icon, { size: 16 }));
      m.weatherEl.appendChild(el('span', null, `${Math.round(w.temperature)}°`));
      m.weatherEl.hidden = !visibility.wetter;
      m.element.classList.toggle('hat-warnung', Array.isArray(item.alerts) && item.alerts.length > 0);
      m.weatherEl.title = `${w.iconLabel || ''}${w.windSpeedKmh != null ? `, Wind ${Math.round(w.windSpeedKmh)} km/h` : ''}`;
    }
  }

  // ---------------------------------------------------------------- Störungen
  function setDisruptions(items) {
    const segments = [];
    const stops = [];
    for (const d of items || []) {
      if (d.segment && d.segment.length === 2) {
        segments.push({ type: 'Feature', properties: { id: d.id, category: d.category, severity: d.severity, summary: d.summary, text: d.text }, geometry: { type: 'LineString', coordinates: d.segment } });
      }
      for (const s of d.affectedStops || []) {
        if (Number.isFinite(s.lon) && Number.isFinite(s.lat)) {
          stops.push({ type: 'Feature', properties: { id: d.id, stopId: s.id, name: s.name, category: d.category, severity: d.severity, summary: d.summary, text: d.text }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
        }
      }
    }
    data.disruptionSegments = { type: 'FeatureCollection', features: segments };
    data.disruptionStops = { type: 'FeatureCollection', features: stops };
    if (styleReady) {
      map.getSource('disruptionSegments').setData(data.disruptionSegments);
      map.getSource('disruptionStops').setData(data.disruptionStops);
    }
  }

  function setStatic(key, fc) {
    data[key] = fc || EMPTY;
    if (styleReady && map.getSource(key)) map.getSource(key).setData(data[key]);
  }

  function setSelected(tripId, routeCoords) {
    selectedTripId = tripId || null;
    data.selectedRoute = routeCoords && routeCoords.length >= 2
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: routeCoords } }] }
      : EMPTY;
    if (!styleReady) return;
    map.setFilter('zuege-ausgewaehlt', ['==', ['get', 'tripId'], selectedTripId || '']);
    map.getSource('selectedRoute').setData(data.selectedRoute);
  }

  const routeCache = new Map();
  function setRoutes(routesByTrip) {
    const features = [];
    for (const [tripId, coords] of routesByTrip) {
      routeCache.set(tripId, coords);
      if (coords && coords.length >= 2) features.push({ type: 'Feature', properties: { tripId }, geometry: { type: 'LineString', coordinates: coords } });
    }
    setStatic('routes', { type: 'FeatureCollection', features });
  }

  function setLayerVisible(name, visible) {
    if (!(name in visibility)) return;
    visibility[name] = Boolean(visible);
    applyVisibility();
  }

  function fitCoords(coords, padding = 60) {
    if (!coords || coords.length < 2) return;
    const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(b, { padding, maxZoom: 11, duration: reducedMotion ? 0 : 800 });
  }

  function flyTo(lonlat, zoom = 9) {
    map.flyTo({ center: lonlat, zoom: Math.max(map.getZoom(), zoom), duration: reducedMotion ? 0 : 900, essential: true });
  }

  function findTrainFeature(tripId) {
    return data.trains.features.find((f) => f.properties.tripId === tripId) || null;
  }

  return {
    map, ready,
    setTrains, setCapitals, setWeather, setDisruptions, setSelected, setRoutes, setLayerVisible, fitCoords, flyTo, findTrainFeature,
    setBundeslaender: (fc) => setStatic('bundeslaender', fc),
    setCorridors: (fc) => setStatic('corridors', fc),
    getVisibility: () => ({ ...visibility }),
    hasLabels: () => Boolean(fontStack),
    isFallback: () => fallbackApplied,
    resize: () => map.resize(),
  };
}
