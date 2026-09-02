#!/usr/bin/env node
/**
 * Einfache Qualitätsprüfung ohne externe Abhängigkeiten:
 *  1. Syntaxprüfung aller JavaScript-Dateien (node --check)
 *  2. Verbot gefährlicher Konstrukte (eval, new Function, document.write, innerHTML mit Template-Strings)
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['src', 'scripts', 'test', 'test-e2e', 'public/js'];
const SKIP = new Set(['node_modules', 'vendor']);
const FORBIDDEN = [
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/document\.write\s*\(/, 'document.write()'],
  [/\.innerHTML\s*\+?=\s*`/, 'innerHTML mit Template-String'],
  [/\.outerHTML\s*=/, 'outerHTML-Zuweisung'],
];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (['.js', '.mjs'].includes(extname(p))) out.push(p);
  }
  return out;
}

let failed = 0;
const files = ROOTS.flatMap((r) => walk(r));
for (const f of files) {
  const selfCheck = f.endsWith('scripts/lint.js');
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`[lint] Syntaxfehler in ${f}\n${r.stderr}`);
  }
  const src = readFileSync(f, 'utf8');
  for (const [re, label] of selfCheck ? [] : FORBIDDEN) {
    if (re.test(src)) {
      failed++;
      console.error(`[lint] ${f}: verbotenes Konstrukt ${label}`);
    }
  }
}
console.log(`[lint] ${files.length} Dateien geprüft, ${failed} Befund(e)`);
process.exit(failed ? 1 : 0);
