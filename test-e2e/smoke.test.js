/**
 * End-to-End-Rauchtest: Mock-Upstream + Server + Frontend im echten Chromium (playwright-core).
 * Prüft: Seite lädt ohne Konsolenfehler und CSP-Verstöße, Züge erscheinen, Klick öffnet Details,
 * API liefert Features. Screenshot nach test-results/smoke.png.
 *
 * Aufruf: npm run test:e2e   (Chromium-Pfad über PLAYWRIGHT_CHROMIUM_PATH überschreibbar)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const APP_PORT = Number.parseInt(process.env.E2E_PORT || '3777', 10);
const MOCK_PORT = Number.parseInt(process.env.E2E_MOCK_PORT || '3998', 10);

async function waitFor(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* noch nicht bereit */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server unter ${url} nicht bereit`);
}

test('Frontend lädt im Browser, zeigt Züge und Details ohne Konsolenfehler', { timeout: 180000 }, async (t) => {
  if (!existsSync(CHROMIUM)) return t.skip(`Chromium nicht gefunden unter ${CHROMIUM}`);
  if (!existsSync(join(ROOT, 'src/server.js')) || !existsSync(join(ROOT, 'public/index.html'))) return t.skip('Server oder Frontend fehlen noch');
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return t.skip('playwright-core nicht installiert');
  }

  const child = spawn(process.execPath, ['scripts/demo.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), MOCK_PORT: String(MOCK_PORT), HOST: '127.0.0.1', LOG_LEVEL: 'warn', LOG_FORMAT: 'pretty', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  child.stdout.on('data', (d) => serverLog.push(String(d)));
  child.stderr.on('data', (d) => serverLog.push(String(d)));
  const base = `http://127.0.0.1:${APP_PORT}`;
  let browser;
  try {
    await waitFor(`${base}/api/health`, 40000);

    // Warten, bis der Poller Fahrten geladen hat
    let trains = null;
    for (let i = 0; i < 60; i++) {
      const r = await (await fetch(`${base}/api/trains?includeScheduled=true`)).json();
      if (r.features && r.features.length > 0) { trains = r; break; }
      await new Promise((res) => setTimeout(res, 1000));
    }
    assert.ok(trains && trains.features.length > 0, `keine Züge über die API (Serverlog: ${serverLog.slice(-5).join('')})`);

    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'de-DE' });
    const consoleErrors = [];
    const cspViolations = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        // eslint-disable-next-line no-console
        console.error(`CSP-VERSTOSS ${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    page.on('console', (msg) => { if (msg.text().startsWith('CSP-VERSTOSS')) cspViolations.push(msg.text()); });

    const resp = await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    assert.equal(resp.status(), 200);
    const csp = resp.headers()['content-security-policy'] || '';
    assert.ok(csp.includes("script-src 'self'"), `CSP fehlt/unerwartet: ${csp}`);

    await page.waitForSelector('#liste-zuege li[data-trip-id]', { timeout: 90000 });
    const count = await page.locator('#liste-zuege li[data-trip-id]').count();
    assert.ok(count > 0, 'keine Züge in der Liste');
    await page.waitForFunction(() => document.querySelector('#status-chip')?.dataset.zustand === 'live', null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('.marker-hauptstadt').length >= 16, null, { timeout: 30000 });
    await page.waitForTimeout(2500);

    mkdirSync(join(ROOT, 'test-results'), { recursive: true });
    await page.screenshot({ path: join(ROOT, 'test-results', 'smoke.png'), fullPage: false });

    await page.locator('#liste-zuege li[data-trip-id]').first().click();
    await page.waitForSelector('#detail:not([hidden]) table.tabelle', { timeout: 20000 });
    const title = await page.locator('#detail-titel').textContent();
    assert.match(title, /^(ICE|IC|EC|RJ) \d+/);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(ROOT, 'test-results', 'smoke-detail.png'), fullPage: false });

    await page.click('#tab-stoerungen');
    await page.waitForSelector('#panel-stoerungen:not([hidden])');
    await page.click('#tab-wetter');
    await page.waitForFunction(() => document.querySelectorAll('#tabelle-wetter tbody tr').length >= 16, null, { timeout: 30000 });
    await page.click('#tab-bahnhoefe');
    await page.waitForFunction(() => document.querySelectorAll('#liste-hauptstaedte li').length === 16, null, { timeout: 30000 });
    await page.locator('#liste-hauptstaedte li').first().click();
    await page.waitForSelector('#detail:not([hidden]) table.tabelle', { timeout: 20000 });
    await page.screenshot({ path: join(ROOT, 'test-results', 'smoke-bahnhof.png'), fullPage: false });

    const relevantErrors = consoleErrors.filter((e) => !/CSP-VERSTOSS/.test(e));
    assert.deepEqual(cspViolations, [], `CSP-Verstöße: ${cspViolations.join('; ')}`);
    assert.deepEqual(relevantErrors, [], `Konsolenfehler: ${relevantErrors.join('; ')}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
  }
});
