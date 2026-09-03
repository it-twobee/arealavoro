// QA giornaliero: tre controlli per cliente, salvati a DB e mostrati in dashboard.
//
// I controlli veri e propri (fetch della pagina, GTM, Pixel via HTML o via API
// Meta, dati GA4, promozioni, riepiloghi) stanno in lib/tracking/qa-checks.ts,
// condiviso col CRM. Qui resta ciò che tocca SQLite: leggere i clienti,
// salvare gli esiti, promuovere gli stati, e il pianificatore interno.

import { db } from './db.js';
import { HttpError } from './http-error.js';
import { metaContextFor, readAgencyCredential } from './reporting.js';
import { parseServiceAccount } from './ga4.js';
import * as vault from './vault.js';
import { TONE_EMOJI } from './archetypes.js';
import { QA_CHECKS, QA_STATUSES as QA_STATUS_LIST } from '../lib/tracking/vocab.ts';
import {
  checkGa4,
  checkGtm,
  checkMetaPixel,
  checkMetaPixelViaApi,
  countProblems,
  fetchQaSite,
  promotionsFor,
  summarize,
  viewsFor,
} from '../lib/tracking/qa-checks.ts';

/** I tre controlli, nell'ordine in cui si mostrano. */
export { QA_CHECKS };

/**
 * Esiti indicizzati per valore, con il pallino: la forma che la CLI e la UI
 * leggono. Il vocabolario condiviso parla di "toni", qui diventano emoji.
 */
export const QA_STATUSES = Object.fromEntries(
  QA_STATUS_LIST.map((s) => [s.value, { label: s.label, dot: TONE_EMOJI[s.tone] ?? '⚪' }]),
);

/** I dati del cliente nella forma che i controlli si aspettano. */
function targetOf(client) {
  return {
    website: client.website_url || null,
    gtm_container_id: client.gtm_container_id ?? '',
    meta_pixel_id: client.meta_pixel_id ?? '',
    ga4_property_id: client.ga4_property_id ?? '',
  };
}

/* ---------- esecuzione ---------- */

/**
 * Prepara il service account una volta sola per tutta la tornata: derivare la
 * chiave e leggere il vault a ogni cliente sarebbe solo lavoro sprecato.
 * `ga4` null = non disponibile, con `ga4Error` che dice perché.
 */
function ga4Context(endpoints) {
  const withEndpoints = (account) => (endpoints ? { account, endpoints } : { account });
  if (!vault.isUnlocked()) {
    return { ga4: null, ga4Error: 'Cifratura bloccata: il service account non è leggibile' };
  }
  try {
    const raw = readAgencyCredential('ga4');
    if (!raw) return { ga4: null, ga4Error: 'Service account GA4 non configurato in Impostazioni' };
    return { ga4: withEndpoints(parseServiceAccount(raw)) };
  } catch (err) {
    return { ga4: null, ga4Error: `Service account GA4 non utilizzabile: ${err.message}` };
  }
}

function saveResult(clientId, checkKey, { status, detail }) {
  db.prepare(
    `INSERT INTO qa_results (client_id, check_key, status, detail, checked_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(client_id, check_key) DO UPDATE
       SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
  ).run(clientId, checkKey, status, detail);
}

/** Esegue i tre controlli su un cliente e salva l'esito. */
export async function checkClient(client, context) {
  const target = targetOf(client);

  // Una sola richiesta al sito, usata sia per GTM sia per il Pixel.
  const site = await fetchQaSite(target.website);

  // Meta: se il connettore è configurato vince l'API, che dice se il pixel
  // riceve dati davvero; altrimenti si ricade sulla lettura dell'HTML.
  let metaResult = null;
  const prepared = metaContextFor(client.id, context.metaEndpoints);
  if (!prepared.error) {
    try {
      metaResult = await checkMetaPixelViaApi(prepared.adAccountId, prepared.context);
    } catch (err) {
      console.error(`[qa] ${client.name} · pixel via API Meta: ${err.message}`);
      metaResult = { status: 'problema', detail: `Meta non interrogabile: ${err.message}` };
    }
  }

  const results = {
    gtm: checkGtm(target, site),
    ga4: await checkGa4(target, context.ga4, context.ga4Error),
    meta_pixel: metaResult ?? checkMetaPixel(target, site),
  };

  for (const [key, value] of Object.entries(results)) {
    saveResult(client.id, key, value);
    // Il motivo esatto finisce anche nel log del server: senza, un controllo
    // rosso costringeva ad aprire la scheda per capire cosa fosse successo.
    if (value.status === 'problema') {
      console.warn(`[qa] ${client.name} · ${key}: ${value.detail}`);
    }
  }

  // Un canale che risponde davvero non deve restare "da fare" nella scheda:
  // solo promozione, mai declassamento.
  for (const [field, to] of Object.entries(promotionsFor(client, results))) {
    db.prepare(`UPDATE clients SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(to, client.id);
    console.log(`[qa] ${client.name} · ${field}: ${client[field]} → ${to} (verificato dal controllo)`);
  }

  return results;
}

/**
 * Ricontrolla un solo cliente. Serve al pulsante nella sua scheda: senza,
 * l'unico modo di aggiornare l'esito era rilanciare l'intero portafoglio o
 * aspettare il giro notturno.
 */
export async function runQaForClient(clientId, { endpoints } = {}) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new HttpError(404, 'Cliente non trovato');

  const startedAt = Date.now();
  const results = await checkClient(client, ga4Context(endpoints));
  const problems = countProblems(results);

  console.log(`[qa] ricontrollo di ${client.name}: ${problems} problemi, ${Date.now() - startedAt} ms`);
  return { checks: resultsFor(client.id), problems };
}

/** Esegue il controllo su tutto il portafoglio. */
export async function runQa({ origin = 'manuale', endpoints } = {}) {
  const startedAt = Date.now();
  const run = db.prepare('INSERT INTO qa_runs (origin) VALUES (?) RETURNING id').get(origin);

  const clients = db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE').all();
  const context = ga4Context(endpoints);
  let problems = 0;

  for (const client of clients) {
    problems += countProblems(await checkClient(client, context));
  }

  const durationMs = Date.now() - startedAt;
  db.prepare(
    `UPDATE qa_runs SET finished_at = datetime('now'), clients = ?, problems = ?, duration_ms = ? WHERE id = ?`,
  ).run(clients.length, problems, durationMs, run.id);

  console.log(
    `[qa] controllo ${origin}: ${clients.length} clienti, ${problems} problemi, ${durationMs} ms`,
  );
  return { runId: run.id, clients: clients.length, problems, durationMs };
}

/* ---------- lettura ---------- */

/** Esiti per cliente, nell'ordine dei controlli. Mai controllato = 'mai'. */
export function resultsFor(clientId) {
  const rows = db.prepare('SELECT * FROM qa_results WHERE client_id = ?').all(clientId);
  // Il nucleo restituisce `status: null` per "mai controllato"; la UI e la CLI
  // conoscono il valore 'mai', quindi la traduzione sta qui.
  return viewsFor(rows).map((view) => ({ ...view, status: view.status ?? 'mai' }));
}

/**
 * Riepilogo per la vista clienti: un solo stato per cliente, indicizzato per
 * id (numerico, come in SQLite).
 */
export function summaryByClient() {
  const rows = db.prepare('SELECT client_id, check_key, status, detail, checked_at FROM qa_results').all();
  return summarize(rows);
}

export function lastRun() {
  return (
    db.prepare('SELECT * FROM qa_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() ?? null
  );
}

/* ---------- pianificazione ---------- */

const DEFAULT_HOUR = Number(process.env.TWOBEE_QA_HOUR ?? 7);
let timer = null;

function ranToday() {
  const row = db
    .prepare("SELECT 1 FROM qa_runs WHERE date(started_at) = date('now') AND finished_at IS NOT NULL")
    .get();
  return Boolean(row);
}

function msUntilNextRun(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Pianificatore interno: nessun cron di sistema da configurare.
 * Il server si riavvia spesso, quindi all'avvio si recupera l'esecuzione del
 * giorno se non è ancora stata fatta, invece di aspettare l'ora esatta.
 */
export function scheduleDailyQa({ hour = DEFAULT_HOUR } = {}) {
  const plan = () => {
    clearTimeout(timer);
    const delay = msUntilNextRun(hour);
    timer = setTimeout(async () => {
      await runQa({ origin: 'schedulato' }).catch((err) => console.error(`[qa] fallito: ${err.message}`));
      plan();
    }, delay);
    // unref: un controllo in attesa non deve tenere vivo il processo alla chiusura
    timer.unref?.();
    return delay;
  };

  const delay = plan();
  const hours = (delay / 3_600_000).toFixed(1);

  if (!ranToday()) {
    // Recupero, ma non subito: prima si lascia salire il server.
    setTimeout(() => {
      runQa({ origin: "recupero all'avvio" }).catch((err) => console.error(`[qa] fallito: ${err.message}`));
    }, 5000).unref?.();
    return { hour, nextInHours: hours, catchUp: true };
  }
  return { hour, nextInHours: hours, catchUp: false };
}
