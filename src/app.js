/**
 * Express-5-Anwendung: Sicherheitsheader (Helmet/CSP), Rate-Limit, Zugriffsprotokoll,
 * statische Dateien, API- und Karten-Router, zentrale Fehlerbehandlung.
 */
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApiRouter } from './routes/api.js';
import { createMapProxyRouter } from './routes/map-proxy.js';
import { toPublicJson, httpStatusOf, isAppError } from './lib/errors.js';
import { anonymizeIp } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(__dirname, '..', 'public');

/** Content-Security-Policy-Direktiven abhängig vom Kartenmodus. */
export function buildCspDirectives(config) {
  const mapOrigins = config.map.mode === 'vector' ? config.map.origins : [];
  return {
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:', ...mapOrigins],
    'connect-src': ["'self'", ...mapOrigins],
    'worker-src': ["'self'", 'blob:'],
    'child-src': ['blob:'],
    'font-src': ["'self'"],
    'manifest-src': ["'self'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
  };
}

/**
 * @param {{config:object, logger:object, services:object, now?:() => number}} deps
 */
export function createApp({ config, logger, services, now = () => Date.now() }) {
  const app = express();
  const startedAt = now();
  const log = logger.child ? logger.child({ mod: 'http' }) : logger;

  app.disable('x-powered-by');
  app.set('trust proxy', config.server.trustProxy);
  app.set('etag', 'strong');
  app.set('query parser', 'simple');

  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: buildCspDirectives(config) },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: config.security.hstsEnabled ? { maxAge: 15552000, includeSubDomains: false } : false,
    xFrameOptions: { action: 'deny' },
  }));
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
    next();
  });

  // Zugriffsprotokoll ohne Query-Strings, mit anonymisierter IP
  app.use((req, res, next) => {
    const t0 = now();
    res.on('finish', () => {
      const fields = { method: req.method, path: req.path, status: res.statusCode, durationMs: now() - t0, ip: anonymizeIp(req.ip) };
      const quiet = req.path === '/api/health' || !req.path.startsWith('/api/');
      if (res.statusCode >= 500) log.error('Anfrage', fields);
      else if (quiet) log.debug('Anfrage', fields);
      else log.info('Anfrage', fields);
    });
    next();
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.security.rateLimitPerMin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
    handler: (req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Zu viele Anfragen. Bitte kurz warten.' } });
    },
  });

  // Statische Dateien (Vendor-Bibliotheken lange cachen, Rest kurz)
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  });
  app.use(express.static(PUBLIC_DIR, {
    index: false,
    etag: true,
    lastModified: true,
    maxAge: '5m',
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
      if (filePath.includes(`${join(PUBLIC_DIR, 'vendor')}`)) res.set('Cache-Control', 'public, max-age=86400, immutable');
      else if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
    },
  }));

  app.use('/api', limiter, createApiRouter({ config, services, logger: log, now, startedAt }));
  const mapProxy = createMapProxyRouter({ config, httpClient: services.httpClient, now });
  app.use('/map', limiter, mapProxy.router);

  app.use((req, res) => {
    res.status(404);
    if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
      res.json({ error: { code: 'NOT_FOUND', message: 'Nicht gefunden.' } });
    } else {
      res.type('text/plain; charset=utf-8').send('Nicht gefunden. Zur Karte: /');
    }
  });

  // Zentrale Fehlerbehandlung: keine internen Details an Clients
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = httpStatusOf(err);
    let body = toPublicJson(err);
    if (!isAppError(err)) {
      if (err instanceof URIError || err.type === 'encoding.unsupported' || err.status === 400) {
        status = 400;
        body = { error: { code: 'VALIDATION', message: 'Ungültige Anfrage.' } };
      } else if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
        status = err.status;
        body = { error: { code: 'BAD_REQUEST', message: 'Ungültige Anfrage.' } };
      }
    }
    if (status >= 500) log.error('Unbehandelter Fehler', { path: req.path, err });
    else log.warn('Anfrage abgewiesen', { path: req.path, status, code: body.error && body.error.code });
    if (res.headersSent) return;
    res.status(status);
    res.set('Cache-Control', 'no-store');
    res.json(body);
  });

  return app;
}
