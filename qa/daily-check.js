#!/usr/bin/env node
// Controllo QA giornaliero, eseguibile a mano o da un'attività pianificata.
//
//   npm run qa
//
// Normalmente non serve: il server esegue il controllo da solo una volta al
// giorno (vedi scheduleDailyQa in app/qa.js). Questo comando è utile per
// forzarlo subito, o per pianificarlo con l'Utilità di pianificazione di Windows
// se si preferisce non tenere il server sempre acceso.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const load = (file) => import(pathToFileURL(path.join(APP, file)).href);

const { runQa, resultsFor, QA_STATUSES } = await load('qa.js');
const { db } = await load('db.js');
const vault = await load('vault.js');
const { AUTH_ENABLED } = await load('config.js');

// Ad accesso libero la chiave sta su file: senza aprirla il controllo GA4 non
// potrebbe leggere il service account e risulterebbe "non verificabile".
if (!AUTH_ENABLED && !vault.isUnlocked()) {
  const opened = vault.autoUnlock();
  if (opened.state === 'locked') console.warn(`[qa] cifratura non aperta: ${opened.error}`);
}

console.log('\nTwoBee OS — controllo QA\n' + '─'.repeat(58));

const summary = await runQa({ origin: 'riga di comando' });

for (const client of db.prepare('SELECT id, name FROM clients ORDER BY name COLLATE NOCASE').all()) {
  const checks = resultsFor(client.id);
  const problemi = checks.filter((c) => c.status === 'problema');
  const verificati = checks.filter((c) => c.status === 'ok').length;

  // Stessa regola della dashboard: verde solo se qualcosa è stato davvero
  // verificato, altrimenti sarebbe un "tutto a posto" mai controllato.
  const icona = problemi.length ? '🔴' : verificati ? '🟢' : '⚪';
  console.log(`\n${icona} ${client.name}${verificati || problemi.length ? '' : '  (niente da verificare)'}`);
  for (const check of checks) {
    const dot = QA_STATUSES[check.status]?.dot ?? '·';
    console.log(`   ${dot} ${check.label.padEnd(22)} ${check.detail}`);
  }
}

console.log(
  `\n${'─'.repeat(58)}\n${summary.clients} clienti controllati · ` +
    `${summary.problems} problemi · ${summary.durationMs} ms\n`,
);
process.exit(0);
