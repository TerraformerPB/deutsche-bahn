/**
 * Seitenleiste, Listen, Detailansicht, Status-Chip, Ebenen-Menü und Design-Umschalter.
 * Alle Inhalte werden über DOM-APIs erzeugt (kein innerHTML mit variablen Inhalten).
 */
import {
  fmtTime, fmtDateTime, fmtDelay, fmtAge, fmtKmh, fmtTemp, statusLabel, stateLabel, productLabel, loadFactorLabel,
  categoryLabel, matchesQuery, compareTrains, plural, STATUS_LABELS, STATUS_COLORS,
} from './format.js';
import { createWeatherIcon } from './weather-icons.js';

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') throw new Error('innerHTML ist nicht erlaubt');
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

const $ = (id) => document.getElementById(id);

export function createUi({ store, api, map, config, prefs }) {
  const dom = {
    statusChip: $('status-chip'), banner: $('banner'), sidebar: $('seitenleiste'),
    tabs: [...document.querySelectorAll('.tab')], panels: [...document.querySelectorAll('.panel')],
    listTrains: $('liste-zuege'), summaryTrains: $('zusammenfassung-zuege'), counterTrains: $('zaehler-zuege'),
    listDisruptions: $('liste-stoerungen'), counterDisruptions: $('zaehler-stoerungen'),
    listCapitals: $('liste-hauptstaedte'), listStationSearch: $('liste-bahnhof-suche'), stationSearch: $('bahnhof-suche'),
    weatherSource: $('wetter-quelle'), weatherAlerts: $('wetter-warnungen'), weatherTable: $('tabelle-wetter').querySelector('tbody'),
    btnWeatherTrain: $('btn-wetter-zug'), weatherTrain: $('wetter-zug'),
    legend: $('legende'), statusDetails: $('status-details'), sources: $('liste-quellen'), disclaimer: $('disclaimer'),
    detail: $('detail'), detailTitle: $('detail-titel'), detailContent: $('detail-inhalt'), btnBack: $('btn-detail-zurueck'),
    filterSearch: $('filter-suche'), filterProduct: $('filter-produkt'), filterStatus: $('filter-status'), filterEnRoute: $('filter-nur-unterwegs'),
    btnLayers: $('btn-ebenen'), layersMenu: $('ebenen-menue'), btnTheme: $('btn-theme'), btnSidebar: $('btn-seitenleiste'), linkSources: $('link-quellen'),
  };

  // ---------------------------------------------------------------- Tabs
  function activateTab(id) {
    for (const t of dom.tabs) {
      const active = t.id === `tab-${id}`;
      t.classList.toggle('aktiv', active);
      t.setAttribute('aria-selected', String(active));
    }
    for (const p of dom.panels) {
      const active = p.id === `panel-${id}`;
      p.classList.toggle('aktiv', active);
      p.hidden = !active;
    }
    store.set({ activeTab: id });
    hideDetail();
  }
  for (const t of dom.tabs) t.addEventListener('click', () => activateTab(t.id.replace('tab-', '')));
  dom.linkSources.addEventListener('click', (e) => { e.preventDefault(); activateTab('info'); showSidebar(true); });

  // ---------------------------------------------------------------- Seitenleiste (mobil) / Ebenen / Design
  function showSidebar(visible) {
    dom.sidebar.hidden = !visible;
    dom.btnSidebar.setAttribute('aria-expanded', String(visible));
    setTimeout(() => map.resize(), 50);
  }
  dom.btnSidebar.addEventListener('click', () => showSidebar(dom.sidebar.hidden));

  dom.btnLayers.addEventListener('click', () => {
    const open = dom.layersMenu.hidden;
    dom.layersMenu.hidden = !open;
    dom.btnLayers.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!dom.layersMenu.hidden && !dom.layersMenu.contains(e.target) && e.target !== dom.btnLayers) {
      dom.layersMenu.hidden = true;
      dom.btnLayers.setAttribute('aria-expanded', 'false');
    }
  });
  const savedLayers = prefs.read('ebenen', {});
  for (const cb of dom.layersMenu.querySelectorAll('input[data-ebene]')) {
    const name = cb.dataset.ebene;
    if (typeof savedLayers[name] === 'boolean') cb.checked = savedLayers[name];
    map.setLayerVisible(name, cb.checked);
    cb.addEventListener('change', () => {
      map.setLayerVisible(name, cb.checked);
      const all = {};
      for (const c of dom.layersMenu.querySelectorAll('input[data-ebene]')) all[c.dataset.ebene] = c.checked;
      prefs.write('ebenen', all);
      store.set({ layers: all });
    });
  }
  store.set({ layers: map.getVisibility() });

  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    dom.btnTheme.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  applyTheme(prefs.read('theme', null));
  dom.btnTheme.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = (current || (systemDark ? 'dark' : 'light')) === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    prefs.write('theme', next);
  });

  // ---------------------------------------------------------------- Status-Chip und Banner
  function setStatusChip(zustand, text) {
    dom.statusChip.dataset.zustand = zustand;
    dom.statusChip.querySelector('.status-text').textContent = text;
  }
  function showBanner(text) {
    dom.banner.textContent = text;
    dom.banner.hidden = false;
  }
  function hideBanner() {
    dom.banner.hidden = true;
  }

  // ---------------------------------------------------------------- Detailansicht
  function showDetail(title, contentNode) {
    dom.detailTitle.textContent = title;
    dom.detailContent.replaceChildren(contentNode);
    dom.detail.hidden = false;
    dom.detailContent.scrollTop = 0;
  }
  function hideDetail() {
    dom.detail.hidden = true;
    if (store.get().selectedTripId) store.set({ selectedTripId: null, selectedTrip: null });
    map.setSelected(null, null);
    dom.btnWeatherTrain.disabled = true;
  }
  dom.btnBack.addEventListener('click', hideDetail);

  // ---------------------------------------------------------------- Züge
  function statusDot(status) {
    return el('span', { class: `status-punkt punkt-${status}`, 'aria-hidden': 'true' });
  }

  function trainItem(p) {
    const li = el('li', { tabindex: '0', role: 'button', dataset: { tripId: p.tripId }, class: p.tripId === store.get().selectedTripId ? 'ausgewaehlt' : '' }, [
      el('div', { class: 'zeile' }, [
        statusDot(p.status),
        el('span', { class: `linie produkt-${p.product}`, text: p.line }),
        el('span', { class: 'ziel', text: `→ ${p.direction || p.destination || '?'}` }),
        el('span', { class: `rechts status status-${p.status}`, text: p.cancelled ? 'ausgefallen' : fmtDelay(p.delayMin) }),
      ]),
      el('div', { class: 'zeile klein' }, [
        el('span', { text: p.state === 'en_route' && p.nextStop ? `nächster Halt ${p.nextStop} ${fmtTime(p.nextStopArrival || p.nextStopPlannedArrival)}` : stateLabel(p.state) }),
        el('span', { class: 'rechts', text: p.speedKmh ? fmtKmh(p.speedKmh) : '' }),
      ]),
    ]);
    const open = () => selectTrain(p.tripId, { fly: true });
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return li;
  }

  function filteredTrains() {
    const s = store.get();
    const fc = s.trains;
    if (!fc) return [];
    const f = s.filters || {};
    return fc.features.map((x) => x.properties).filter((p) => {
      if (f.product && p.product !== f.product) return false;
      if (f.status && p.status !== f.status) return false;
      if (f.enRouteOnly && !['en_route', 'at_stop'].includes(p.state)) return false;
      return matchesQuery(p, f.query);
    }).sort(compareTrains);
  }

  function renderTrains() {
    const s = store.get();
    const all = s.trains ? s.trains.features.map((x) => x.properties) : [];
    const list = filteredTrains();
    dom.counterTrains.textContent = String(all.filter((p) => ['en_route', 'at_stop'].includes(p.state)).length);
    const counts = { on_time: 0, slight: 0, delayed: 0, heavy: 0, cancelled: 0, unknown: 0 };
    for (const p of all) counts[p.status] = (counts[p.status] || 0) + 1;
    dom.summaryTrains.textContent = `${plural(list.length, 'Zug', 'Züge')} angezeigt · ${counts.on_time} pünktlich · ${counts.slight + counts.delayed + counts.heavy} verspätet · ${counts.cancelled} ausgefallen`;
    const frag = document.createDocumentFragment();
    if (list.length === 0) frag.appendChild(el('li', { class: 'leer', text: s.trains ? 'Keine Züge für diese Auswahl.' : 'Lade Züge …' }));
    for (const p of list.slice(0, 400)) frag.appendChild(trainItem(p));
    dom.listTrains.replaceChildren(frag);
  }

  const readFilters = () => store.set({ filters: { query: dom.filterSearch.value, product: dom.filterProduct.value, status: dom.filterStatus.value, enRouteOnly: dom.filterEnRoute.checked } });
  for (const input of [dom.filterSearch, dom.filterProduct, dom.filterStatus, dom.filterEnRoute]) input.addEventListener('input', readFilters);
  readFilters();

  async function selectTrain(tripId, { fly = false } = {}) {
    store.set({ selectedTripId: tripId });
    map.setSelected(tripId, null);
    const f = map.findTrainFeature(tripId);
    if (fly && f) map.flyTo(f.geometry.coordinates, 8);
    showDetail(f ? `${f.properties.line} → ${f.properties.direction || ''}` : 'Zug', el('p', { class: 'klein', text: 'Lade Fahrtdetails …' }));
    try {
      const d = await api.train(tripId);
      if (store.get().selectedTripId !== tripId) return;
      store.set({ selectedTrip: d });
      const coords = d.polyline && d.polyline.coordinates;
      map.setSelected(tripId, coords || null);
      if (fly && coords && coords.length > 1) map.fitCoords(coords);
      renderTrainDetail(d);
      dom.btnWeatherTrain.disabled = !d.position;
    } catch (err) {
      showDetail('Zug', el('p', { class: 'leer', text: `Fahrtdetails nicht verfügbar (${err.message}).` }));
    }
  }

  function renderTrainDetail(d) {
    const t = d.trip;
    const pos = d.position || {};
    const status = pos.status || 'unknown';
    const kpis = el('div', { class: 'kennzahlen' }, [
      el('div', { class: 'kennzahl' }, [el('div', { class: `wert status-${status}`, text: t.cancelled ? 'ausgefallen' : fmtDelay(pos.delayMin) }), el('div', { class: 'label', text: statusLabel(status) })]),
      el('div', { class: 'kennzahl' }, [el('div', { class: 'wert', text: stateLabel(pos.state) }), el('div', { class: 'label', text: pos.nextStop ? `nächster Halt: ${pos.nextStop.name || pos.nextStop}` : (t.destination && t.destination.name) || '' })]),
      el('div', { class: 'kennzahl' }, [el('div', { class: 'wert', text: pos.speedKmh ? fmtKmh(pos.speedKmh) : '–' }), el('div', { class: 'label', text: `Position: ${{ polyline: 'Streckenverlauf', corridor: 'Korridor', linear: 'Luftlinie', stop: 'Halt' }[pos.source] || 'berechnet'}` })]),
    ]);
    const meta = el('p', { class: 'klein' }, [
      `${productLabel(t.product, t.productName)} ${t.fahrtNr || ''} · ${t.operator || 'Betreiber unbekannt'} · ${t.origin ? t.origin.name : '?'} → ${t.destination ? t.destination.name : '?'}`,
      t.loadFactor ? ` · ${loadFactorLabel(t.loadFactor)}` : '',
      t.realtimeDataUpdatedAt ? ` · Echtzeitstand ${fmtTime(new Date(t.realtimeDataUpdatedAt * 1000).toISOString())}` : '',
    ]);
    const rows = (t.stopovers || []).map((s) => {
      const arrDelay = s.arrivalDelaySec != null ? Math.round(s.arrivalDelaySec / 60) : null;
      const depDelay = s.departureDelaySec != null ? Math.round(s.departureDelaySec / 60) : null;
      const platformChanged = s.departurePlatform && s.plannedDeparturePlatform && s.departurePlatform !== s.plannedDeparturePlatform;
      const isNext = pos.nextStop && (pos.nextStop.id ? pos.nextStop.id === (s.stop && s.stop.id) : pos.nextStop === (s.stop && s.stop.name));
      return el('tr', { class: [s.cancelled ? 'entfaellt' : '', isNext ? 'naechster' : ''].join(' ') }, [
        el('td', { text: (s.stop && s.stop.name) || '?' }),
        el('td', { class: 'num' }, [fmtTime(s.plannedArrival), arrDelay != null && arrDelay !== 0 ? el('span', { class: arrDelay > 5 ? 'ist-spaet' : 'ist-ok', text: ` (${fmtDelay(arrDelay)})` }) : null]),
        el('td', { class: 'num' }, [fmtTime(s.plannedDeparture), depDelay != null && depDelay !== 0 ? el('span', { class: depDelay > 5 ? 'ist-spaet' : 'ist-ok', text: ` (${fmtDelay(depDelay)})` }) : null]),
        el('td', { class: platformChanged ? 'gleiswechsel' : '', text: s.cancelled ? 'entfällt' : (s.departurePlatform || s.arrivalPlatform || s.plannedDeparturePlatform || s.plannedArrivalPlatform || '–') }),
      ]);
    });
    const table = el('table', { class: 'tabelle' }, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Halt' }), el('th', { text: 'An' }), el('th', { text: 'Ab' }), el('th', { text: 'Gleis' })])),
      el('tbody', {}, rows),
    ]);
    const remarks = (t.remarks || []).filter((r) => r && (r.text || r.summary));
    const remarkList = el('ul', { class: 'hinweise' }, remarks.map((r) => el('li', {}, [
      el('span', { class: r.type === 'warning' ? 'warnung-text' : '', text: r.type === 'warning' ? 'Warnung: ' : (r.type === 'status' ? 'Hinweis: ' : '') }),
      r.text || r.summary,
      r.modified ? el('span', { class: 'klein', text: ` (Stand ${fmtDateTime(r.modified)})` }) : null,
    ])));
    const box = el('div', {}, [
      kpis, meta,
      el('h3', { text: 'Fahrtverlauf (Plan, Abweichung in Klammern)' }), table,
      el('h3', { text: `Hinweise (${remarks.length})` }),
      remarks.length ? remarkList : el('p', { class: 'klein', text: 'Keine Hinweise.' }),
      el('p', { class: 'klein', text: `Fahrt-ID ${t.id} · Daten geladen ${fmtTime(new Date(t.fetchedAt || Date.now()).toISOString())}${d.stale ? ' · veraltet' : ''}` }),
    ]);
    showDetail(`${t.lineName} → ${t.direction || (t.destination && t.destination.name) || ''}`, box);
  }

  // ---------------------------------------------------------------- Störungen
  function disruptionItem(d) {
    const li = el('li', { class: `stoerung schwere-${d.severity || 'hoch'}`, tabindex: '0', role: 'button', dataset: { id: d.id } }, [
      el('div', { class: 'kategorie', text: `${categoryLabel(d.category)} · Schwere ${d.severity || 'hoch'}${d.modified ? ` · Stand ${fmtDateTime(d.modified)}` : ''}` }),
      el('div', { class: 'text', text: d.text || d.summary || '' }),
      el('div', { class: 'chips' }, [
        ...(d.affectedStops || []).slice(0, 4).map((s) => el('span', { class: 'chip', text: s.name })),
        ...(d.affectedTrips || []).slice(0, 6).map((t) => el('span', { class: 'chip', text: t.lineName })),
        (d.affectedTrips || []).length > 6 ? el('span', { class: 'chip', text: `+${d.affectedTrips.length - 6} weitere` }) : null,
      ]),
    ]);
    const open = () => focusDisruption(d);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return li;
  }

  function focusDisruption(d) {
    if (d.segment && d.segment.length === 2) map.fitCoords(d.segment, 120);
    else if (d.affectedStops && d.affectedStops.length && Number.isFinite(d.affectedStops[0].lon)) map.flyTo([d.affectedStops[0].lon, d.affectedStops[0].lat], 8);
    for (const li of dom.listDisruptions.children) li.classList.toggle('ausgewaehlt', li.dataset.id === d.id);
  }

  function renderDisruptions() {
    const items = (store.get().disruptions || []);
    dom.counterDisruptions.textContent = String(items.length);
    const frag = document.createDocumentFragment();
    if (items.length === 0) frag.appendChild(el('li', { class: 'leer', text: 'Derzeit keine Störungsmeldungen in den verfolgten Fahrten.' }));
    const order = { hoch: 0, mittel: 1, niedrig: 2 };
    for (const d of [...items].sort((a, b) => (order[a.severity] ?? 1) - (order[b.severity] ?? 1) || (b.lastSeen || 0) - (a.lastSeen || 0))) frag.appendChild(disruptionItem(d));
    dom.listDisruptions.replaceChildren(frag);
  }

  // ---------------------------------------------------------------- Bahnhöfe
  function boardSummaryText(b) {
    if (!b) return 'keine Abfahrtsdaten';
    return `${plural(b.departures, 'Abfahrt', 'Abfahrten')}/h · ${b.delayed} verspätet · ${b.cancelled} ausgefallen · max. ${fmtDelay(b.maxDelayMin)}`;
  }

  function capitalItem(c) {
    const li = el('li', { tabindex: '0', role: 'button' }, [
      el('div', { class: 'zeile' }, [
        el('span', { class: 'stern-probe', 'aria-hidden': 'true', text: '★' }),
        el('strong', { text: c.city }),
        el('span', { class: 'klein', text: c.state }),
        el('span', { class: 'rechts klein', text: c.weather ? fmtTemp(c.weather.temperature) : '' }),
      ]),
      el('div', { class: 'klein', text: `${c.stationName}: ${boardSummaryText(c.board)}` }),
    ]);
    const open = () => openStation({ id: c.stationId, name: c.stationName, lat: c.lat, lon: c.lon }, { fly: true });
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return li;
  }

  function renderStations() {
    const s = store.get().stations;
    const frag = document.createDocumentFragment();
    if (!s) frag.appendChild(el('li', { class: 'leer', text: 'Lade Bahnhöfe …' }));
    else for (const c of s.capitals) frag.appendChild(capitalItem(c));
    dom.listCapitals.replaceChildren(frag);
  }

  let searchTimer = null;
  dom.stationSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = dom.stationSearch.value.trim();
    if (q.length < 2) { dom.listStationSearch.replaceChildren(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const results = await api.stationSearch(q);
        const frag = document.createDocumentFragment();
        for (const r of results) {
          const li = el('li', { tabindex: '0', role: 'button', text: r.name });
          const open = () => openStation(r, { fly: true });
          li.addEventListener('click', open);
          li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
          frag.appendChild(li);
        }
        if (!results.length) frag.appendChild(el('li', { class: 'leer', text: 'Kein Bahnhof gefunden.' }));
        dom.listStationSearch.replaceChildren(frag);
      } catch (err) {
        dom.listStationSearch.replaceChildren(el('li', { class: 'leer', text: `Suche fehlgeschlagen (${err.message}).` }));
      }
    }, 250);
  });

  async function openStation(st, { fly = false } = {}) {
    if (fly && Number.isFinite(st.lon)) map.flyTo([st.lon, st.lat], 9);
    showDetail(st.name, el('p', { class: 'klein', text: 'Lade Abfahrten …' }));
    try {
      const b = await api.departures(st.id);
      const rows = (b.departures || []).map((d) => {
        const min = d.delaySec != null ? Math.round(d.delaySec / 60) : null;
        const platformChanged = d.platform && d.plannedPlatform && d.platform !== d.plannedPlatform;
        return el('tr', { class: d.cancelled ? 'entfaellt' : '' }, [
          el('td', { class: 'num', text: fmtTime(d.plannedWhen) }),
          el('td', {}, [el('span', { class: 'linie', text: d.lineName }), ' ', el('span', { class: 'klein', text: `→ ${d.direction || ''}` })]),
          el('td', { class: `num status-${d.cancelled ? 'cancelled' : (min == null ? 'unknown' : (min <= 5 ? 'on_time' : (min <= 15 ? 'slight' : (min <= 60 ? 'delayed' : 'heavy'))))}`, text: d.cancelled ? 'Ausfall' : fmtDelay(min) }),
          el('td', { class: platformChanged ? 'gleiswechsel' : '', text: d.platform || d.plannedPlatform || '–' }),
        ]);
      });
      const table = el('table', { class: 'tabelle' }, [
        el('thead', {}, el('tr', {}, [el('th', { text: 'Ab' }), el('th', { text: 'Zug' }), el('th', { text: 'Abw.' }), el('th', { text: 'Gleis' })])),
        el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: '4', class: 'leer', text: 'Keine Fernverkehrsabfahrten in der nächsten Stunde.' }))),
      ]);
      const capital = store.get().stations && store.get().stations.capitals.find((c) => c.stationId === st.id);
      const weatherBox = capital && capital.weather ? el('p', { class: 'klein' }, [createWeatherIcon(capital.weather.icon, { size: 18 }), ` ${capital.weather.iconLabel || ''}, ${fmtTemp(capital.weather.temperature)}, Wind ${fmtKmh(capital.weather.windSpeedKmh)}`]) : null;
      const alerts = capital && capital.alerts && capital.alerts.length ? el('div', {}, capital.alerts.map((a) => el('div', { class: 'warnung-box' }, [el('strong', { text: a.headline || a.event }), el('div', { class: 'klein', text: a.description || '' })]))) : null;
      showDetail(st.name, el('div', {}, [
        el('p', { class: 'klein', text: `Abfahrten Fernverkehr, Stand ${fmtTime(new Date(b.fetchedAt).toISOString())}` }),
        weatherBox, alerts, table,
      ]));
      for (const tr of table.querySelectorAll('tbody tr')) {
        const idx = [...tr.parentNode.children].indexOf(tr);
        const dep = b.departures[idx];
        if (!dep) continue;
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => selectTrain(dep.tripId, { fly: true }));
      }
    } catch (err) {
      showDetail(st.name, el('p', { class: 'leer', text: `Abfahrten nicht verfügbar (${err.message}).` }));
    }
  }

  // ---------------------------------------------------------------- Wetter
  function renderWeather() {
    const w = store.get().weather;
    if (!w) { dom.weatherSource.textContent = 'Lade Wetterdaten …'; return; }
    dom.weatherSource.textContent = `${w.attribution || ''}${w.updatedAt ? ` · Stand ${fmtTime(new Date(w.updatedAt).toISOString())}` : ''}`;
    const rows = (w.items || []).map((it) => el('tr', {}, [
      el('td', { text: it.city }),
      el('td', {}, it.weather ? [createWeatherIcon(it.weather.icon, { size: 20 }), ` ${it.weather.iconLabel || ''}`] : ['–']),
      el('td', { class: 'num', text: it.weather ? fmtTemp(it.weather.temperature) : '–' }),
      el('td', { class: 'num', text: it.weather && it.weather.windSpeedKmh != null ? `${Math.round(it.weather.windSpeedKmh)}${it.weather.windGustKmh ? `/${Math.round(it.weather.windGustKmh)}` : ''} km/h` : '–' }),
    ]));
    dom.weatherTable.replaceChildren(...rows);
    const alerts = [];
    for (const it of w.items || []) for (const a of it.alerts || []) alerts.push({ ...a, city: it.city });
    const seen = new Set();
    dom.weatherAlerts.replaceChildren(...alerts.filter((a) => { const k = `${a.id}:${a.city}`; if (seen.has(k)) return false; seen.add(k); return true; }).map((a) => el('div', { class: 'warnung-box' }, [
      el('strong', { text: `${a.city}: ${a.headline || a.event || 'Warnung'}` }),
      el('div', { class: 'klein', text: `${a.severity ? `Stufe ${a.severity}` : ''}${a.expires ? ` · bis ${fmtDateTime(a.expires)}` : ''}` }),
      el('div', { class: 'klein', text: a.description || '' }),
    ])));
  }

  dom.btnWeatherTrain.addEventListener('click', async () => {
    const d = store.get().selectedTrip;
    if (!d || !d.position) return;
    dom.weatherTrain.textContent = 'Lade Wetter am Zug …';
    try {
      const r = await api.weatherPoint(d.position.lat, d.position.lon);
      const w = r.weather;
      dom.weatherTrain.replaceChildren(w ? el('span', {}, [createWeatherIcon(w.icon, { size: 18 }), ` ${d.trip.lineName}: ${w.iconLabel || ''}, ${fmtTemp(w.temperature)}, Wind ${fmtKmh(w.windSpeedKmh)}${w.precipitationMm ? `, Niederschlag ${w.precipitationMm} mm` : ''}`]) : 'Keine Wetterdaten für diese Position.');
    } catch (err) {
      dom.weatherTrain.textContent = `Wetter am Zug nicht verfügbar (${err.message}).`;
    }
  });

  // ---------------------------------------------------------------- Info
  function renderInfo() {
    const c = store.get().config;
    const items = [
      ...Object.entries(STATUS_LABELS).map(([k, label]) => el('li', {}, [el('span', { class: `status-punkt punkt-${k}` }), label])),
      el('li', {}, [el('span', { class: 'linie-probe', style: undefined, 'data-kind': 'SFS' }), 'Schnellfahrstrecke (≥ 250 km/h)']),
      el('li', {}, [el('span', { class: 'linie-probe', 'data-kind': 'ABS' }), 'Ausbaustrecke (200–230 km/h)']),
      el('li', {}, [el('span', { class: 'linie-probe', 'data-kind': 'H' }), 'weitere Hauptstrecke']),
      el('li', {}, [el('span', { class: 'stern-probe', text: '★' }), 'Landeshauptstadt (Hauptbahnhof) mit Wetter']),
      el('li', {}, [el('span', { class: 'status-punkt', 'data-kind': 'S' }), 'Störung (Halt / Abschnitt)']),
    ];
    dom.legend.replaceChildren(...items);
    // Farben der Linienproben ohne Inline-Styles: über Klassen
    for (const li of dom.legend.querySelectorAll('.linie-probe')) {
      li.classList.add(`probe-${li.dataset.kind}`);
    }
    dom.sources.replaceChildren(...((c && c.attributions) || []).map((a) => el('li', {}, [a.url ? el('a', { href: a.url, rel: 'noopener', target: '_blank', text: a.name }) : a.name, `: ${a.text}`])));
    dom.disclaimer.textContent = (c && c.disclaimer) || 'Inoffizielles Angebot. Alle Angaben ohne Gewähr.';
  }

  function renderStatus() {
    const s = store.get();
    const st = s.status;
    const dl = [];
    const add = (k, v) => dl.push(el('dt', { text: k }), el('dd', { text: v }));
    if (st && st.poller) {
      const p = st.poller;
      add('Verfolgte Fahrten', `${p.trackedTrips ?? '–'} (${p.activeTrips ?? '–'} unterwegs)`);
      add('Letzte Aktualisierung', p.lastRefreshAt ? fmtAge(Date.now() - p.lastRefreshAt) : '–');
      add('Letzte Abfahrtstafeln', p.lastDiscoveryAt ? fmtAge(Date.now() - p.lastDiscoveryAt) : '–');
      add('Datenquelle', p.upstream ? `${{ closed: 'erreichbar', open: 'gestört', 'half-open': 'wird geprüft' }[p.upstream.state] || p.upstream.state}${p.upstream.lastErrorCode ? ` (${p.upstream.lastErrorCode})` : ''}` : '–');
      add('Anfragen/Minute', p.requestsLastMinute != null ? `${p.requestsLastMinute} von ${p.budget ? p.budget.rpm : '–'}` : '–');
    }
    if (st && st.weather) add('Wetter', st.weather.provider ? `${st.weather.provider}, ${st.weather.updatedAt ? fmtAge(Date.now() - st.weather.updatedAt) : '–'}` : 'deaktiviert');
    if (s.config && s.config.demo) add('Betriebsart', 'Demo (synthetische Daten)');
    dom.statusDetails.replaceChildren(...dl);

    const meta = s.trains && s.trains.meta;
    const ageSec = meta && Number.isFinite(meta.dataAgeSec) ? meta.dataAgeSec : null;
    const up = st && st.poller && st.poller.upstream ? st.poller.upstream.state : null;
    if (s.apiError) setStatusChip('gestoert', `Server nicht erreichbar${s.lastGoodAt ? ` · Stand ${fmtAge(Date.now() - s.lastGoodAt)}` : ''}`);
    else if (up === 'open') setStatusChip('gestoert', `Datenquelle gestört${ageSec != null ? ` · Daten ${fmtAge(ageSec * 1000)}` : ''}`);
    else if (up === 'half-open' || (ageSec != null && ageSec > 600)) setStatusChip('verzoegert', `Verzögert · Daten ${fmtAge(ageSec != null ? ageSec * 1000 : 0)}`);
    else if (s.trains) setStatusChip('live', `Live · Daten ${ageSec != null ? fmtAge(ageSec * 1000) : 'aktuell'}`);
  }

  // ---------------------------------------------------------------- Abonnements
  store.subscribe(renderTrains, ['trains', 'filters', 'selectedTripId']);
  store.subscribe(renderDisruptions, ['disruptions']);
  store.subscribe(renderStations, ['stations']);
  store.subscribe(renderWeather, ['weather']);
  store.subscribe(renderInfo, ['config']);
  store.subscribe(renderStatus, ['status', 'trains', 'apiError', 'config']);
  renderTrains(); renderDisruptions(); renderStations(); renderWeather(); renderInfo(); renderStatus();

  return { activateTab, showSidebar, setStatusChip, showBanner, hideBanner, selectTrain, openStation, hideDetail, renderTrainDetail, focusDisruption };
}
