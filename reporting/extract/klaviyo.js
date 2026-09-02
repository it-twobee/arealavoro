#!/usr/bin/env node
// Estrazione performance flussi Klaviyo, da riga di comando.
//
//   npm run extract:klaviyo                    tutti i clienti con una chiave
//   npm run extract:klaviyo -- "Nome cliente"  un cliente solo
//
// Fa esattamente ciò che fa il pulsante "Estrai dati Klaviyo" nella scheda
// cliente: stessa funzione, stessa normalizzazione, stessi record a DB. Serve
// per estrazioni in blocco o pianificate, senza aprire la dashboard.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');
const load = (file) => import(pathToFileURL(path.join(APP, file)).href);

const { db } = await load('db.js');
const vault = await load('vault.js');
const { AUTH_ENABLED } = await load('config.js');
const { runKlaviyoReport } = await load('reporting.js');

// Le chiavi Klaviyo sono cifrate: senza aprire il vault non si leggono.
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
      WHERE EXISTS (SELECT 1 FROM credentials k WHERE k.client_id = c.id AND k.platform = 'klaviyo')
        ${filtro ? 'AND c.name LIKE ?' : ''}
      ORDER BY c.name COLLATE NOCASE`,
  )
  .all(...(filtro ? [`%${filtro}%`] : []));

console.log('\nTwoBee OS — estrazione Klaviyo\n' + '─'.repeat(58));

if (clients.length === 0) {
  console.log(
    filtro
      ? `Nessun cliente con chiave Klaviyo corrisponde a "${filtro}".`
      : 'Nessun cliente ha una chiave API Klaviyo nella scheda Chiavi.',
  );
  process.exit(0);
}

let riusciti = 0;
for (const client of clients) {
  process.stdout.write(`\n${client.name}\n`);
  try {
    const report = await runKlaviyoReport(client);
    const totali = Object.fromEntries(report.totals.map((t) => [t.metric, t.current]));
    const pct = (v) => `${(v * 100).toFixed(1)}%`;

    console.log(`   flussi attivi   ${totali.flussi_attivi}`);
    console.log(`   destinatari     ${totali.destinatari.toLocaleString('it-IT')}`);
    console.log(`   aperture        ${totali.aperture.toLocaleString('it-IT')} (${pct(totali.tasso_apertura)})`);
    console.log(`   click           ${totali.click.toLocaleString('it-IT')} (${pct(totali.tasso_click)})`);
    console.log(`   ricavi          ${totali.ricavi.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })}`);
    console.log(`   metrica usata   ${report.conversionMetric}`);
    riusciti += 1;
  } catch (err) {
    console.log(`   ✗ ${err.message}`);
  }
}

console.log(`\n${'─'.repeat(58)}\n${riusciti}/${clients.length} estrazioni riuscite\n`);
process.exit(0);
