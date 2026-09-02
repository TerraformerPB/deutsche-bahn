/**
 * Einstiegspunkt: Konfiguration laden, Dienste und App erzeugen, lauschen, sauber beenden.
 */
import { loadConfig, ConfigError } from './config.js';
import { createLogger } from './logger.js';
import { createServices } from './services.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`Konfigurationsfehler: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({ level: config.log.level, format: config.log.format, base: { app: config.app.name } });
const services = createServices({ config, logger });
const app = createApp({ config, logger, services });

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info('Server gestartet', {
    port: config.server.port,
    host: config.server.host,
    env: config.env,
    demo: config.demo,
    mapMode: config.map.mode,
    upstreamHost: new URL(config.transport.baseUrl).host,
    products: config.transport.products,
    maxRpm: config.transport.maxRpm,
    weather: config.weather.enabled ? config.weather.providers : 'aus',
    version: config.app.version,
  });
  services.start().catch((err) => logger.error('Dienste konnten nicht gestartet werden', { err }));
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Beende Server', { signal });
  const timer = setTimeout(() => {
    logger.warn('Zeitüberschreitung beim Beenden – erzwinge Ende');
    process.exit(1);
  }, config.server.shutdownTimeoutMs);
  timer.unref();
  try {
    await services.stop();
  } catch (err) {
    logger.error('Fehler beim Stoppen der Dienste', { err });
  }
  server.close(() => {
    logger.info('Server beendet');
    process.exit(0);
  });
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unbehandelte Promise-Ablehnung', { err: reason instanceof Error ? reason : new Error(String(reason)) });
});
process.on('uncaughtException', (err) => {
  logger.error('Unbehandelte Ausnahme – Prozess wird beendet', { err });
  process.exit(1);
});

export { server, app, services, config };
