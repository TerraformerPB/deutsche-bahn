/**
 * Wettersymbole als einfache SVG-Pfade (24×24). Die Definitionen sind DOM-frei;
 * `createWeatherIcon` erzeugt ein SVG-Element über DOM-APIs (kein innerHTML).
 */
export const ICON_NAMES = Object.freeze([
  'clear-day', 'clear-night', 'partly-cloudy-day', 'partly-cloudy-night', 'cloudy', 'fog', 'wind',
  'rain', 'sleet', 'snow', 'hail', 'thunderstorm',
]);

export const ICON_LABELS = Object.freeze({
  'clear-day': 'sonnig',
  'clear-night': 'klar',
  'partly-cloudy-day': 'teils bewölkt',
  'partly-cloudy-night': 'teils bewölkt',
  cloudy: 'bewölkt',
  fog: 'Nebel',
  wind: 'windig',
  rain: 'Regen',
  sleet: 'Schneeregen',
  snow: 'Schnee',
  hail: 'Hagel',
  thunderstorm: 'Gewitter',
});

const SUN = { tag: 'circle', attrs: { cx: 12, cy: 12, r: 4.5, fill: '#f4b400' } };
const SUN_RAYS = { tag: 'path', attrs: { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1', stroke: '#f4b400', 'stroke-width': 1.8, 'stroke-linecap': 'round', fill: 'none' } };
const MOON = { tag: 'path', attrs: { d: 'M15.5 3.5a8.5 8.5 0 1 0 5 15.4A7 7 0 0 1 15.5 3.5z', fill: '#c9d3e0' } };
const CLOUD = { tag: 'path', attrs: { d: 'M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18z', fill: '#9fb0c2' } };
const CLOUD_SMALL = { tag: 'path', attrs: { d: 'M9 19h9a3.3 3.3 0 0 0 .4-6.6 4.5 4.5 0 0 0-8.7 1.2A2.7 2.7 0 0 0 9 19z', fill: '#9fb0c2' } };
const RAIN = { tag: 'path', attrs: { d: 'M9 20l-1 2.5M13 20l-1 2.5M17 20l-1 2.5', stroke: '#3b82c4', 'stroke-width': 1.8, 'stroke-linecap': 'round', fill: 'none' } };
const SNOW = { tag: 'path', attrs: { d: 'M9 21.5h.01M13 21.5h.01M17 21.5h.01', stroke: '#8fb8de', 'stroke-width': 2.6, 'stroke-linecap': 'round', fill: 'none' } };
const HAIL = { tag: 'path', attrs: { d: 'M9 21.5h.01M13 21.5h.01M17 21.5h.01', stroke: '#5b7f95', 'stroke-width': 3, 'stroke-linecap': 'round', fill: 'none' } };
const BOLT = { tag: 'path', attrs: { d: 'M12.5 13 9.5 19h3l-1 4 4-6.5h-3l1-3.5z', fill: '#f4b400' } };
const FOG = { tag: 'path', attrs: { d: 'M4 10h16M3 14h18M5 18h14', stroke: '#9fb0c2', 'stroke-width': 1.8, 'stroke-linecap': 'round', fill: 'none' } };
const WIND = { tag: 'path', attrs: { d: 'M3 9h11a2.5 2.5 0 1 0-2.5-2.5M3 14h15a2.5 2.5 0 1 1-2.5 2.5M3 19h8', stroke: '#6c8ebf', 'stroke-width': 1.8, 'stroke-linecap': 'round', fill: 'none' } };

export const ICON_PATHS = Object.freeze({
  'clear-day': [SUN_RAYS, SUN],
  'clear-night': [MOON],
  'partly-cloudy-day': [{ ...SUN_RAYS, attrs: { ...SUN_RAYS.attrs, transform: 'translate(-3 -3) scale(0.8)' } }, { ...SUN, attrs: { ...SUN.attrs, cx: 8, cy: 8, r: 3.5 } }, CLOUD_SMALL],
  'partly-cloudy-night': [{ ...MOON, attrs: { ...MOON.attrs, transform: 'translate(-2 -3) scale(0.7)' } }, CLOUD_SMALL],
  cloudy: [CLOUD],
  fog: [FOG],
  wind: [WIND],
  rain: [{ ...CLOUD, attrs: { ...CLOUD.attrs, transform: 'translate(0 -3)' } }, RAIN],
  sleet: [{ ...CLOUD, attrs: { ...CLOUD.attrs, transform: 'translate(0 -3)' } }, { ...RAIN, attrs: { ...RAIN.attrs, d: 'M9 20l-1 2.5M17 20l-1 2.5' } }, { ...SNOW, attrs: { ...SNOW.attrs, d: 'M13 21.5h.01' } }],
  snow: [{ ...CLOUD, attrs: { ...CLOUD.attrs, transform: 'translate(0 -3)' } }, SNOW],
  hail: [{ ...CLOUD, attrs: { ...CLOUD.attrs, transform: 'translate(0 -3)' } }, HAIL],
  thunderstorm: [{ ...CLOUD, attrs: { ...CLOUD.attrs, transform: 'translate(0 -4)', fill: '#6c7a8a' } }, BOLT],
});

export function iconLabel(name) {
  return ICON_LABELS[name] || 'unbekannt';
}

export function normalizeIconName(name) {
  return ICON_NAMES.includes(name) ? name : 'cloudy';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Erzeugt ein SVG-Element für das Symbol.
 * @param {string} name
 * @param {{document?: Document, size?: number, className?: string}} [opts]
 */
export function createWeatherIcon(name, { document: doc = globalThis.document, size = 22, className = 'wetter-icon' } = {}) {
  const icon = normalizeIconName(name);
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', iconLabel(icon));
  if (className) svg.setAttribute('class', className);
  const title = doc.createElementNS(SVG_NS, 'title');
  title.textContent = iconLabel(icon);
  svg.appendChild(title);
  for (const part of ICON_PATHS[icon]) {
    const el = doc.createElementNS(SVG_NS, part.tag);
    for (const [k, v] of Object.entries(part.attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}
