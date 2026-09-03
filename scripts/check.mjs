#!/usr/bin/env node
// Esegue in sequenza tutti i lib/tracking/*.check.ts con tsx e termina con
// codice diverso da zero se anche uno solo fallisce.
//
//   npm run check
//
// Si passa da `node --import tsx` invece che dal binario `tsx`: funziona uguale
// su Windows e su Linux senza dover cercare `tsx.cmd`.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join('lib', 'tracking');

const scripts = readdirSync(path.join(ROOT, DIR))
  .filter((f) => f.endsWith('.check.ts'))
  .sort();

if (scripts.length === 0) {
  console.error(`Nessun *.check.ts in ${DIR}`);
  process.exit(1);
}

const failed = [];
for (const file of scripts) {
  const rel = path.join(DIR, file);
  console.log(`\n── ${rel}`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', rel], {
    cwd: ROOT,
    stdio: 'inherit',
    // I check di crypto.ts manipolano VAULT_KEY: ogni script parte con
    // l'ambiente pulito da quella variabile.
    env: { ...process.env, VAULT_KEY: undefined },
  });
  if (result.status !== 0) failed.push(rel);
}

console.log(`\n${'─'.repeat(58)}`);
if (failed.length) {
  console.error(`${failed.length}/${scripts.length} check falliti:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
console.log(`${scripts.length}/${scripts.length} check OK`);
