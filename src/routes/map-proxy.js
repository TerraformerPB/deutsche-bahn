/**
 * Raster-Kachel-Proxy (nur MAP_MODE=raster): holt Kacheln vom serverinternen Raster-Endpunkt
 * des Kartenservers und liefert sie mit Cache an den Browser aus. Validiert z/x/y strikt.
 */
import { Router } from 'express';
import { createTtlCache } from '../lib/ttl-cache.js';
import { UpstreamError } from '../lib/errors.js';
import { parseTileCoord } from './validate.js';

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Minimaler MapLibre-Style, der die proxied Rasterkacheln nutzt. */
export function buildRasterStyle(config) {
  return {
    version: 8,
    name: 'Rasterkarte (Proxy)',
    sources: {
      basemap: {
        type: 'raster',
        tiles: ['/map/raster/{z}/{x}/{y}.png'],
        tileSize: 256,
        minzoom: 0,
        maxzoom: config.map.rasterMaxZoom,
        attribution: config.map.attribution,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#e8ecef' } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
    ],
  };
}

/**
 * @param {{config:object, httpClient:object, logger?:object, now?:() => number}} deps
 */
export function createMapProxyRouter({ config, httpClient, now = () => Date.now() }) {
  const router = Router();
  const enabled = config.map.mode === 'raster';
  const cache = createTtlCache({ maxEntries: Math.max(1, config.map.rasterCacheEntries), defaultTtlMs: Math.max(1000, config.map.rasterCacheTtlSec * 1000), now });

  router.get('/style.json', (req, res) => {
    if (!enabled) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Raster-Modus ist nicht aktiv.' } });
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(buildRasterStyle(config));
  });

  router.get('/raster/:z/:x/:file', async (req, res) => {
    if (!enabled) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Raster-Modus ist nicht aktiv.' } });
    const { z, x, y } = parseTileCoord(req.params.z, req.params.x, req.params.file, config.map.rasterMaxZoom);
    const key = `${z}/${x}/${y}`;
    let tile = cache.get(key);
    if (!tile) {
      const url = config.map.rasterUrlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      const r = await httpClient.getBuffer(url, { accept: 'image/png,image/*;q=0.8', maxResponseBytes: 2 * 1024 * 1024 });
      const type = (r.contentType || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_TYPES.includes(type)) {
        throw new UpstreamError('Kartenserver lieferte keinen Bildinhalt.', { upstreamStatus: r.status, retryable: false, code: 'UPSTREAM_FORMAT', details: { contentType: type } });
      }
      tile = { body: r.body, type };
      cache.set(key, tile);
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Content-Type', tile.type);
    return res.send(tile.body);
  });

  router.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unbekannter Kartenendpunkt.' } }));
  return { router, cache, enabled, stats: () => ({ enabled, cache: cache.stats() }) };
}
