#!/usr/bin/env node
/**
 * Aktualisiert src/data/db-stations.json aus dem npm-Paket `db-stations`
 * (DB Station Data / StaDa Open Data, CC BY 4.0). Es werden nur die benötigten
 * Felder übernommen: id (EVA), name, ril100, lat, lon, cat, state, w.
 *
 * Aufruf: node scripts/update-stations.js [--version 5]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data', 'db-stations.json');
const versionArg = process.argv.indexOf('--version');
const spec = versionArg > -1 ? `db-stations@${process.argv[versionArg + 1]}` : 'db-stations@5';

const tmp = mkdtempSync(join(tmpdir(), 'db-stations-'));
try {
  execFileSync('npm', ['pack', spec, '--pack-destination', tmp], { stdio: ['ignore', 'ignore', 'inherit'] });
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack lieferte kein Archiv');
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp, 'package/full.ndjson', 'package/package.json'], { stdio: 'inherit' });
  const pkg = JSON.parse(readFileSync(join(tmp, 'package', 'package.json'), 'utf8'));
  const lines = readFileSync(join(tmp, 'package', 'full.ndjson'), 'utf8').split('\n').filter(Boolean);
  const stations = [];
  for (const line of lines) {
    const s = JSON.parse(line);
    const loc = s.location || {};
    if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) continue;
    stations.push({
      id: String(s.id), name: s.name, ril100: s.ril100 || null,
      lat: Math.round(loc.latitude * 1e6) / 1e6, lon: Math.round(loc.longitude * 1e6) / 1e6,
      cat: s.category ?? null, state: s.federalState ?? null, w: s.weight ?? null,
    });
  }
  stations.sort((a, b) => a.id.localeCompare(b.id));
  const out = {
    _meta: {
      source: `db-stations ${pkg.version} (npm) – abgeleitet aus DB Station Data (StaDa) Open Data, Lizenz CC BY 4.0, © Deutsche Bahn AG / DB InfraGO AG`,
      fields: 'id=EVA-Nummer (IBNR), ril100=DS100, cat=Bahnhofskategorie 1..7, state=Bundesland, w=Gewichtung (db-stations)',
    },
    stations,
  };
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`[update-stations] ${stations.length} Stationen aus db-stations ${pkg.version} nach ${OUT} geschrieben`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
