/**
 * Kanonisches Wettersymbol-Set (Bright-Sky-Namen) und Zuordnung der WMO-Wettercodes (Open-Meteo).
 * Muss mit `public/js/weather-icons.js` (Frontend) übereinstimmen.
 */
export const ICONS = Object.freeze([
  'clear-day', 'clear-night', 'partly-cloudy-day', 'partly-cloudy-night', 'cloudy', 'fog', 'wind',
  'rain', 'sleet', 'snow', 'hail', 'thunderstorm',
]);

const LABELS_DE = Object.freeze({
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

const CONDITIONS_DE = Object.freeze({
  dry: 'trocken',
  fog: 'Nebel',
  rain: 'Regen',
  sleet: 'Schneeregen',
  snow: 'Schnee',
  hail: 'Hagel',
  thunderstorm: 'Gewitter',
});

/** Prüft/normalisiert einen Symbolnamen; unbekannt → `cloudy`, leer → `null`. */
export function normalizeIcon(name) {
  if (name === null || name === undefined) return null;
  return ICONS.includes(name) ? name : 'cloudy';
}

export function iconLabelDe(icon) {
  return LABELS_DE[icon] || 'unbekannt';
}

export function conditionLabelDe(condition) {
  return condition ? (CONDITIONS_DE[condition] || condition) : null;
}

/**
 * WMO-Wettercode (Open-Meteo `weather_code`) → Symbol.
 * @param {number} code
 * @param {boolean} [isDay]
 */
export function wmoCodeToIcon(code, isDay = true) {
  const c = Number(code);
  if (!Number.isFinite(c)) return 'cloudy';
  if (c === 0) return isDay ? 'clear-day' : 'clear-night';
  if (c === 1 || c === 2) return isDay ? 'partly-cloudy-day' : 'partly-cloudy-night';
  if (c === 3) return 'cloudy';
  if (c === 45 || c === 48) return 'fog';
  if (c >= 51 && c <= 55) return 'rain';
  if (c === 56 || c === 57) return 'sleet';
  if (c >= 61 && c <= 65) return 'rain';
  if (c === 66 || c === 67) return 'sleet';
  if (c >= 71 && c <= 77) return 'snow';
  if (c >= 80 && c <= 82) return 'rain';
  if (c === 85 || c === 86) return 'snow';
  if (c === 95) return 'thunderstorm';
  if (c === 96 || c === 99) return 'hail';
  return 'cloudy';
}

/** WMO-Code → Bright-Sky-ähnliche `condition`. */
export function wmoCodeToCondition(code) {
  const icon = wmoCodeToIcon(code, true);
  if (icon === 'fog') return 'fog';
  if (icon === 'rain') return 'rain';
  if (icon === 'sleet') return 'sleet';
  if (icon === 'snow') return 'snow';
  if (icon === 'hail') return 'hail';
  if (icon === 'thunderstorm') return 'thunderstorm';
  return 'dry';
}
