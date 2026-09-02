#!/usr/bin/env node
// Estrazione performance Meta Ads, da riga di comando.
//
//   npm run extract:meta                    tutti i clienti con un Ad Account ID
//   npm run extract:meta -- "Nome cliente"        un cliente solo
//
// Fa esattamente ciò che fa il pulsante "Estrai dati Meta" nella scheda cliente:
// stessa funzione, stessa normalizzazione, stessi record a DB.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');
const load = (file) => import(pathToFileURL(path.join(APP, file)).href);

const { db } = await load('db.js');
const vault = await load('vault.js');
const { AUTH_ENABLED } = await load('config.js');
const { runMetaReport } = await load('reporting.js');

// Token e Ad Account ID sono cifrati: senza aprire il vault non si leggono.
if (!AUTH_ENABLED && !vault.isUnlocked()) {
  const opened = vault.autoUnlock();
  if (opened.state === 'locked') {
    console.error(`Cifratura non apribile: ${opened.error}`);
    process.exit(1);
  }
}

const filtro = process.argv[2];
const clients = db
  .prepare(
    `SELECT c.* FROM clients c
      WHERE EXISTS (SELECT 1 FROM credentials k WHERE k.client_id = c.id AND k.platform = 'meta')
        ${filtro ? 'AND c.name LIKE ?' : ''}
      ORDER BY c.name COLLATE NOCASE`,
  )
  .all(...(filtro ? [`%${filtro}%`] : []));

console.log('\nTwoBee OS — estrazione Meta Ads\n' + '─'.repeat(58));

if (clients.length === 0) {
  console.log(
    filtro
      ? `Nessun cliente con Ad Account ID corrisponde a "${filtro}".`
      : "Nessun cliente ha un Ad Account ID Meta nella scheda Chiavi.",
  );
  process.exit(0);
}

const euro = (v) => v.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
let riusciti = 0;

for (const client of clients) {
  console.log(`\n${client.name}`);
  try {
    const report = await runMetaReport(client);
    const t = Object.fromEntries(report.totals.map((x) => [x.metric, x.current]));

    console.log(`   ad account     ${report.adAccountId}`);
    if (report.vuoto) {
      console.log('   nessuna erogazione nel periodo');
    } else {
      console.log(`   spesa          ${euro(t.spesa)}`);
      console.log(`   impression     ${t.impression.toLocaleString('it-IT')}`);
      console.log(`   click          ${t.click.toLocaleString('it-IT')} (CTR ${(t.tasso_click * 100).toFixed(2)}%)`);
      console.log(`   conversioni    ${t.conversioni.toLocaleString('it-IT')}`);
      console.log(`   costo/conv.    ${t.conversioni ? euro(t.costo_per_conversione) : '—'}`);
      console.log(
        `   contate come conversione: ${report.conversionActions.length ? report.conversionActions.join(', ') : 'nessuna'}`,
      );
    }
    riusciti += 1;
  } catch (err) {
    console.log(`   ✗ ${err.message}`);
  }
}

console.log(`\n${'─'.repeat(58)}\n${riusciti}/${clients.length} estrazioni riuscite\n`);

// Niente process.exit(): con un timeout di fetch ancora in chiusura, su Windows
// libuv scatta con un'asserzione. Si lascia terminare il processo da solo.
process.exitCode = riusciti === clients.length ? 0 : 1;
