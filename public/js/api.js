/**
 * Zugriff auf die eigene HTTP-API (nur GET, JSON), mit Timeout und einheitlicher Fehlerklasse.
 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK', url = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.url = url;
  }
}

/**
 * @param {{fetchImpl?: typeof fetch, base?: string, timeoutMs?: number}} [opts]
 */
export function createApi({ fetchImpl = (...a) => globalThis.fetch(...a), base = '', timeoutMs = 15000 } = {}) {
  async function getJson(path, { timeout = timeoutMs } = {}) {
    const url = base + path;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' }, credentials: 'same-origin' });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err && err.name === 'AbortError';
      throw new ApiError(aborted ? 'Zeitüberschreitung' : 'Netzwerkfehler', { code: aborted ? 'TIMEOUT' : 'NETWORK', url });
    }
    clearTimeout(timer);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const code = data && data.error && data.error.code ? data.error.code : `HTTP_${res.status}`;
      const message = data && data.error && data.error.message ? data.error.message : `Fehler ${res.status}`;
      const e = new ApiError(message, { status: res.status, code, url });
      e.data = data;
      throw e;
    }
    return data;
  }

  const q = (params) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  };

  return {
    getJson,
    config: () => getJson('/api/config'),
    status: () => getJson('/api/status'),
    trains: (params) => getJson(`/api/trains${q(params)}`),
    train: (tripId, params) => getJson(`/api/trains/${encodeURIComponent(tripId)}${q(params)}`),
    disruptions: () => getJson('/api/disruptions'),
    stations: () => getJson('/api/stations'),
    stationSearch: (query) => getJson(`/api/stations/search${q({ q: query })}`),
    departures: (id) => getJson(`/api/stations/${encodeURIComponent(id)}/departures`),
    weather: () => getJson('/api/weather'),
    weatherPoint: (lat, lon) => getJson(`/api/weather/point${q({ lat: lat.toFixed(4), lon: lon.toFixed(4) })}`),
    corridors: () => getJson('/api/corridors'),
    bundeslaender: () => getJson('/api/bundeslaender'),
    capitals: () => getJson('/api/capitals'),
  };
}
