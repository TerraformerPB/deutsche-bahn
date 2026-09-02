#!/usr/bin/env node
/**
 * Kopiert die Browser-Bibliotheken (MapLibre GL JS, PMTiles) aus node_modules
 * nach public/vendor, damit die Anwendung keine externen CDNs benötigt
 * (Datenschutz: keine Drittanbieter-Requests; Sicherheit: strikte CSP).
 */
import { copyFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'vendor');

const files = [
  ['maplibre-gl/dist/maplibre-gl.mjs', 'maplibre-gl.mjs'],
  ['maplibre-gl/dist/maplibre-gl-shared.mjs', 'maplibre-gl-shared.mjs'],
  ['maplibre-gl/dist/maplibre-gl-worker.mjs', 'maplibre-gl-worker.mjs'],
  ['maplibre-gl/dist/maplibre-gl.css', 'maplibre-gl.css'],
  ['maplibre-gl/LICENSE.txt', 'LICENSE-maplibre-gl.txt'],
  ['pmtiles/dist/pmtiles.js', 'pmtiles.js'],
];

mkdirSync(out, { recursive: true });
let copied = 0;
for (const [src, dst] of files) {
  const from = join(nm, src);
  if (!existsSync(from)) {
    if (src.endsWith('maplibre-gl-shared.mjs')) continue; // optional chunk (versionsabhängig)
    console.error(`[vendor] fehlt: ${from} – bitte "npm install" ausführen`);
    process.exitCode = 1;
    continue;
  }
  copyFileSync(from, join(out, dst));
  copied++;
}
// PMTiles-Lizenz aus package.json ableiten (Paket enthält keine LICENSE-Datei)
try {
  const pkg = JSON.parse(readFileSync(join(nm, 'pmtiles/package.json'), 'utf8'));
  writeFileSync(join(out, 'LICENSE-pmtiles.txt'), `pmtiles ${pkg.version} – Lizenz: ${pkg.license} – ${pkg.homepage || 'https://github.com/protomaps/PMTiles'}\n`);
} catch { /* ignorieren */ }
const versions = {};
for (const p of ['maplibre-gl', 'pmtiles']) {
  try { versions[p] = JSON.parse(readFileSync(join(nm, p, 'package.json'), 'utf8')).version; } catch { /* ignorieren */ }
}
writeFileSync(join(out, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
console.log(`[vendor] ${copied} Dateien nach public/vendor kopiert`, versions);
