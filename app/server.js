import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DB_PATH, db } from './db.js';
import { meta } from './archetypes.js';
import { installShutdownHooks } from './backup.js';
import { listTemplates } from './checklist.js';
import { autoUnlock as vaultAutoUnlock, status as vaultStatus } from './vault.js';
import { router as clientsRouter } from './routes/clients.js';
import { router as credentialsRouter } from './routes/credentials.js';
import { router as accountsRouter } from './routes/accounts.js';
import { router as qaRouter } from './routes/qa.js';
import { scheduleDailyQa } from './qa.js';
import { router as trackingRouter } from './routes/tracking.js';
import { router as reportingRouter } from './routes/reporting.js';
import { router as agencyRouter } from './routes/agency.js';
import { router as authRouter } from './routes/auth.js';
import { requireAuth, userCount } from './auth.js';
import { AUTH_ENABLED } from './config.js';
import { router as vaultRouter } from './routes/vault.js';
import { router as backupRouter } from './routes/backup.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';


const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: DB_PATH, version: '0.1.0' });
});

app.use('/api/auth', authRouter);

// Con l'autenticazione attiva, da qui in giù serve una sessione valida. Il
// frontend statico resta comunque libero (HTML, CSS e JS non contengono dati):
// senza sessione le API rispondono 401 e compare la schermata di accesso.
if (AUTH_ENABLED) app.use('/api', requireAuth);

// Vocabolario condiviso (archetipi, canali, stati): il frontend non lo duplica.
app.get('/api/meta', (req, res) => res.json(meta));

app.use('/api/vault', vaultRouter);
app.use('/api/backup', backupRouter);
// Prima le sotto-risorse: altrimenti /api/clients/:id le intercetterebbe.
app.use('/api/clients/:clientId/credentials', credentialsRouter);
app.use('/api/clients/:clientId/accounts', accountsRouter);
app.use('/api/clients/:clientId/tracking', trackingRouter);
app.use('/api/clients/:clientId/reports', reportingRouter);
app.use('/api/agency', agencyRouter);
app.use('/api/qa', qaRouter);
app.use('/api/clients', clientsRouter);

/**
 * Pagina di controllo generata dal server, senza una riga di JavaScript e senza
 * fogli di stile esterni. Serve a distinguere due casi che dall'esterno
 * sembrano identici ("non vedo niente"): se questa pagina si vede, il server e
 * i dati sono a posto e il problema è nel JavaScript del browser; se non si vede
 * nemmeno questa, il server non è raggiungibile.
 */
app.get('/controllo', (req, res) => {
  const clients = db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE').all();
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  res.type('html').send(`<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>TwoBee OS — controllo</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px">
  <h1 style="margin:0">TwoBee OS — pagina di controllo</h1>
  <p style="color:#555">
    Generata dal server, senza JavaScript. Se leggi questo, il server funziona e i dati ci sono.
  </p>
  <ul style="background:#f4f4f6;padding:14px 30px;border-radius:8px">
    <li>Server in ascolto su <code>http://${HOST}:${PORT}</code></li>
    <li>Accesso: <strong>${AUTH_ENABLED ? 'con password' : 'LIBERO, nessuna password'}</strong></li>
    <li>Clienti nel database: <strong>${clients.length}</strong></li>
  </ul>
  <table border="1" cellpadding="7" cellspacing="0" style="border-collapse:collapse;width:100%">
    <tr style="background:#f4f4f6"><th align="left">Cliente</th><th align="left">Archetipo</th>
        <th align="left">CMS</th><th align="left">GTM</th><th align="left">Sito</th></tr>
    ${clients
      .map(
        (c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.archetype ?? '—')}</td>
      <td>${esc(c.cms || '—')}</td><td>${esc(c.gtm_container_id || '—')}</td>
      <td>${esc(c.website_url || '—')}</td></tr>`,
      )
      .join('')}
  </table>
  <p style="margin-top:26px">
    <a href="/">→ Torna alla dashboard</a>
  </p>
  <p style="color:#555">
    Se la dashboard resta bianca ma questa pagina si vede, nel tuo browser il JavaScript
    è bloccato o in errore: prova una finestra senza estensioni, oppure premi F12 e riporta
    quello che compare nella scheda Console.
  </p>
</body></html>`);
});

// Niente cache sul frontend: l'app gira in locale, il traffico è nullo e in
// cambio si elimina una classe intera di problemi ("vedo ancora la versione
// vecchia" dopo un aggiornamento, con l'HTML servito dalla memoria del browser).
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  next();
});

const PUBLIC_DIR = path.join(APP_DIR, 'public');

/**
 * L'HTML non viene servito come file statico ma adattato al volo. Due ragioni,
 * entrambe nate da problemi reali:
 *
 *  - ad accesso libero il blocco fra i marcatori LOGIN:START/END viene rimosso.
 *    Finché il markup arrivava al browser, una copia in cache poteva far
 *    ricomparire la schermata di accesso anche con l'autenticazione spenta, e
 *    nessuna correzione lato JavaScript riusciva a impedirlo.
 *  - a CSS e JS viene aggiunta la versione presa dalla data di modifica del
 *    file: l'indirizzo cambia a ogni modifica, quindi il browser non può
 *    riproporre una versione vecchia nemmeno se la conserva.
 */
function renderIndex() {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

  const version = (relative) => {
    try {
      return String(Math.floor(fs.statSync(path.join(PUBLIC_DIR, relative)).mtimeMs));
    } catch {
      return '0';
    }
  };
  html = html
    .replace('/css/style.css', `/css/style.css?v=${version('css/style.css')}`)
    .replace('/js/app.js', `/js/app.js?v=${version('js/app.js')}`);

  // Lo stato dell'accesso è noto al primo byte, prima di qualsiasi chiamata API.
  html = html.replace('<head>', `<head>\n    <script>window.__TWOBEE_AUTH = ${AUTH_ENABLED};</script>`);

  if (!AUTH_ENABLED) {
    html = html.replace(
      /<!-- LOGIN:START[\s\S]*?<!-- LOGIN:END -->/,
      '<!-- accesso libero: schermata di accesso non servita -->',
    );
  }
  return html;
}

app.get(['/', '/index.html'], (req, res) => {
  res.type('html').send(renderIndex());
});

app.use(express.static(PUBLIC_DIR, { etag: false, lastModified: false, index: false }));

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint non trovato' });
});

app.use((err, req, res, next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message ?? 'Errore interno' });
});

installShutdownHooks();

const server = app.listen(PORT, HOST, () => {
  const { initialized } = vaultStatus();
  const users = userCount();
  console.log(`TwoBee OS  →  http://${HOST}:${PORT}`);
  console.log(`DB         →  ${DB_PATH}`);
  console.log(
    AUTH_ENABLED
      ? `Accesso    →  con password · ${users === 0 ? 'nessun account: crealo con "npm run user:add"' : `${users} account`}`
      : 'Accesso    →  LIBERO, nessuna password (solo 127.0.0.1) · per riattivarlo: set TWOBEE_AUTH=on',
  );
  if (AUTH_ENABLED) {
    console.log(
      `Vault      →  ${initialized ? 'bloccato, serve la master password' : 'da inizializzare al primo accesso'}`,
    );
  } else {
    // Senza password di accesso la chiave viene da un file fuori da OneDrive:
    // le credenziali restano cifrate a riposo senza chiedere niente all'utente.
    const opened = vaultAutoUnlock();
    console.log(
      opened.state === 'locked'
        ? `Vault      →  BLOCCATO: ${opened.error} · reimpostalo dalla dashboard`
        : `Vault      →  aperto con la chiave in ${opened.file}`,
    );
  }

  // Carica i template all'avvio: un JSON malformato si scopre qui, non quando
  // si apre la scheda di un cliente.
  try {
    const summary = listTemplates()
      .map((t) => `${t.archetype} ${t.totalItems} voci`)
      .join(' · ');
    console.log(`Checklist  →  ${summary}`);
  } catch (err) {
    console.error(`Checklist  →  ERRORE nei template: ${err.message}`);
  }

  // Controllo QA una volta al giorno, senza cron di sistema da configurare.
  const qa = scheduleDailyQa();
  console.log(
    `QA         →  ogni giorno alle ${String(qa.hour).padStart(2, '0')}:00 ` +
      `(prossimo fra ${qa.nextInHours}h)${qa.catchUp ? ' · recupero di oggi in corso' : ''}`,
  );
});

// Porta occupata. Succede a ogni riavvio in modalità --watch: il processo nuovo
// parte mentre il vecchio sta ancora rilasciando la porta. Senza questi tentativi
// il figlio moriva, il wrapper restava "in attesa di modifiche" e la dashboard
// rimaneva senza backend — con l'aria di un problema di password.
const RETRY_DELAY_MS = 400;
const MAX_RETRIES = 12;
let retries = 0;

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(`Avvio non riuscito: ${err.message}`);
    process.exit(1);
  }

  if (retries < MAX_RETRIES) {
    retries += 1;
    if (retries === 1) console.log(`Porta ${PORT} ancora occupata, attendo che si liberi…`);
    setTimeout(() => server.listen(PORT, HOST), RETRY_DELAY_MS);
    return;
  }

  console.error(
    `\nLa porta ${PORT} è occupata da ${((MAX_RETRIES * RETRY_DELAY_MS) / 1000).toFixed(1)}s: ` +
      'non è un riavvio in corso, c\'è un altro server già attivo.\n' +
      'Su Windows, per trovarlo e chiuderlo:\n' +
      `  netstat -ano | findstr :${PORT}\n` +
      '  taskkill /PID <numero> /F\n' +
      `oppure usa un'altra porta:  set PORT=3001 && npm run dev\n`,
  );
  process.exit(1);
});
