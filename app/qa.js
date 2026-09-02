// QA giornaliero: tre controlli per cliente, salvati a DB e mostrati in dashboard.
//
// Riusa i moduli già scritti invece di reimplementarli: il fetch della pagina e
// il riconoscimento dei tag vengono da site-check.js (modulo 3), la connessione
// a GA4 da ga4.js/reporting.js (modulo 4). Una sola richiesta HTTP per cliente
// serve sia al controllo GTM sia a quello del Pixel.

import { db } from './db.js';
import { HttpError } from './http-error.js';
import { detectTags, fetchSite, normalizeUrl } from './site-check.js';
import { metaContextFor, readAgencyCredential } from './reporting.js';
import { DEFAULT_ENDPOINTS, parseServiceAccount, runReport } from './ga4.js';
import { accountPixels } from './meta.js';
import * as vault from './vault.js';

/** I tre controlli, nell'ordine in cui si mostrano. */
export const QA_CHECKS = [
  { key: 'gtm', label: 'GTM sul sito' },
  { key: 'ga4', label: 'Dati GA4 recenti' },
  { key: 'meta_pixel', label: 'Meta Pixel sul sito' },
];

// Quattro esiti, e le differenze contano:
//  'na'            manca il dato per controllare (nessun Pixel ID, nessun URL)
//  'indeterminato' il controllo è stato fatto ma non conclude: il sito carica
//                  GTM, che inietta i tag a runtime, quindi l'assenza dall'HTML
//                  non dimostra niente. Giallo, non rosso: non è un guasto.
//  'problema'      assenza reale, o errore
//  'ok'            verificato
export const QA_STATUSES = {
  ok: { label: 'Ok', dot: '🟢' },
  indeterminato: { label: 'Non deducibile', dot: '🟡' },
  problema: { label: 'Problema', dot: '🔴' },
  na: { label: 'Non verificabile', dot: '⚪' },
};

/** Finestra per il controllo GA4: ieri e l'altroieri, più oggi (incompleto). */
const GA4_WINDOW = { startDate: '2daysAgo', endDate: 'today' };

/* ---------- i tre controlli ---------- */

function checkGtm(client, site) {
  if (!client.website_url) {
    return { status: 'na', detail: 'URL del sito non inserito' };
  }
  if (!client.gtm_container_id) {
    return { status: 'na', detail: 'Nessun container GTM configurato in scheda' };
  }
  if (!site.ok) {
    return { status: 'problema', detail: site.error };
  }

  const wanted = client.gtm_container_id.toUpperCase();
  if (site.tags.gtmIds.includes(wanted)) {
    return { status: 'ok', detail: `${wanted} presente sul sito` };
  }
  return {
    status: 'problema',
    detail: site.tags.gtmIds.length
      ? `GTM non trovato: sul sito c'è ${site.tags.gtmIds.join(', ')}, non ${wanted}`
      : `GTM non trovato sul sito (atteso ${wanted})`,
  };
}

/**
 * Fonte di verità quando il connettore Meta è configurato: guarda se il pixel
 * ha ricevuto eventi di recente, non se il codice compare nell'HTML. Stesso
 * principio già applicato a GA4 con "Dati GA4 recenti".
 */
async function checkMetaPixelViaApi(client, endpoints) {
  const preparato = metaContextFor(client.id, endpoints);
  if (preparato.error) return null; // connettore non configurato: si usa l'HTML

  const pixels = await accountPixels(preparato.adAccountId, preparato.context);
  if (pixels.length === 0) {
    return { status: 'problema', detail: "Nessun pixel collegato a questo ad account Meta" };
  }

  const limite = Date.now() - 48 * 3600 * 1000;
  const attivi = pixels.filter((p) => p.lastFiredTime && Date.parse(p.lastFiredTime) >= limite);

  if (attivi.length) {
    const p = attivi[0];
    return {
      status: 'ok',
      detail: `Pixel "${p.name}" ha ricevuto eventi il ${new Date(p.lastFiredTime).toLocaleString('it-IT')}`,
    };
  }

  const ultimo = pixels
    .filter((p) => p.lastFiredTime)
    .sort((a, b) => Date.parse(b.lastFiredTime) - Date.parse(a.lastFiredTime))[0];

  return {
    status: 'problema',
    detail: ultimo
      ? `Nessun evento pixel nelle ultime 48h · ultimo: ${new Date(ultimo.lastFiredTime).toLocaleString('it-IT')}`
      : 'Il pixel non ha mai ricevuto eventi',
  };
}

function checkMetaPixel(client, site) {
  if (!client.meta_pixel_id) {
    return { status: 'na', detail: 'Nessun Pixel ID salvato per questo cliente' };
  }
  if (!client.website_url) {
    return { status: 'na', detail: 'URL del sito non inserito' };
  }
  if (!site.ok) {
    return { status: 'problema', detail: site.error };
  }

  if (site.tags.metaIds.includes(client.meta_pixel_id)) {
    return { status: 'ok', detail: `Pixel ${client.meta_pixel_id} presente sul sito` };
  }

  // Un altro Pixel nel sorgente è un dato concreto: vuol dire che sulla pagina
  // ce n'è uno diverso da quello in scheda, e va segnalato anche con GTM attivo.
  if (site.tags.metaIds.length) {
    return {
      status: 'problema',
      detail: `Meta Pixel non trovato: sul sito c'è ${site.tags.metaIds.join(', ')}, non ${client.meta_pixel_id}`,
    };
  }

  // Nessun Pixel nell'HTML ma il sito carica GTM: l'assenza non dimostra nulla,
  // perché GTM inietta i tag a runtime. Stesso ragionamento già applicato a GA4.
  // Si guarda qualsiasi container, non solo quello configurato: anche un GTM
  // diverso da quello atteso è comunque in grado di caricare il Pixel.
  if (site.tags.gtmIds.length) {
    return {
      status: 'indeterminato',
      detail:
        "Non deducibile dall'HTML: il sito carica GTM, e un Pixel configurato lì dentro non compare " +
        'nel sorgente. La verifica certa arriverà con la Meta Marketing API.',
    };
  }

  return { status: 'problema', detail: 'Meta Pixel non trovato sul sito' };
}

async function checkGa4(client, context) {
  if (!client.ga4_property_id) {
    return { status: 'na', detail: 'Property ID GA4 non inserito' };
  }
  if (!context.account) {
    return { status: 'na', detail: context.accountError ?? 'Service account GA4 non configurato' };
  }

  try {
    const result = await runReport(
      {
        propertyId: client.ga4_property_id,
        startDate: GA4_WINDOW.startDate,
        endDate: GA4_WINDOW.endDate,
        metrics: ['sessions', 'eventCount'],
        limit: 1,
      },
      context,
    );

    const sessions = result.rows[0]?.metrics.sessions ?? 0;
    const events = result.rows[0]?.metrics.eventCount ?? 0;

    if (sessions > 0 || events > 0) {
      return {
        status: 'ok',
        detail: `${sessions.toLocaleString('it-IT')} sessioni e ${events.toLocaleString('it-IT')} eventi nelle ultime 48h`,
      };
    }
    return {
      status: 'problema',
      detail: `Nessun dato GA4 nelle ultime 48h (property ${client.ga4_property_id})`,
    };
  } catch (err) {
    // Il messaggio di Google è specifico (property inesistente, service account
    // senza accesso, metrica non valida): si riporta intero invece di
    // riassumerlo, altrimenti la diagnosi va fatta a tentativi.
    console.error(`[qa] GA4 property ${client.ga4_property_id}: ${err.message}`);
    return { status: 'problema', detail: `GA4 non interrogabile: ${err.message}` };
  }
}

/* ---------- esecuzione ---------- */

/**
 * Prepara il service account una volta sola per tutta la tornata: derivare la
 * chiave e leggere il vault a ogni cliente sarebbe solo lavoro sprecato.
 */
function ga4Context(endpoints) {
  if (!vault.isUnlocked()) {
    return { endpoints, account: null, accountError: 'Cifratura bloccata: il service account non è leggibile' };
  }
  try {
    const raw = readAgencyCredential('ga4');
    if (!raw) return { endpoints, account: null, accountError: 'Service account GA4 non configurato in Impostazioni' };
    return { endpoints, account: parseServiceAccount(raw) };
  } catch (err) {
    return { endpoints, account: null, accountError: `Service account GA4 non utilizzabile: ${err.message}` };
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

/**
 * Un controllo riuscito è la prova più forte che il canale funziona: più
 * affidabile della ricerca del tag nell'HTML, perché guarda i dati reali.
 * Solo promozione, mai declassamento — stessa regola del modulo 3.
 */
function promoteChannel(client, field, ok) {
  if (!ok) return null;
  const current = client[field];
  if (current === 'active' || current === 'na') return null;

  db.prepare(`UPDATE clients SET ${field} = 'active', updated_at = datetime('now') WHERE id = ?`).run(
    client.id,
  );
  return { field, from: current, to: 'active' };
}

/** Esegue i tre controlli su un cliente e salva l'esito. */
export async function checkClient(client, context) {
  // Una sola richiesta al sito, usata sia per GTM sia per il Pixel.
  let site = { ok: false, error: 'Sito non interrogato', tags: { gtmIds: [], metaIds: [] } };
  if (client.website_url) {
    const fetched = await fetchSite(normalizeUrl(client.website_url));
    site = {
      ok: fetched.ok,
      error: fetched.error,
      tags: fetched.ok ? detectTags(fetched.html) : { gtmIds: [], metaIds: [] },
    };
  }

  // Meta: se il connettore è configurato vince l'API, che dice se il pixel
  // riceve dati davvero; altrimenti si ricade sulla lettura dell'HTML.
  let metaResult = null;
  try {
    metaResult = await checkMetaPixelViaApi(client, context.metaEndpoints);
  } catch (err) {
    console.error(`[qa] ${client.name} · pixel via API Meta: ${err.message}`);
    metaResult = { status: 'problema', detail: `Meta non interrogabile: ${err.message}` };
  }

  const results = {
    gtm: checkGtm(client, site),
    ga4: await checkGa4(client, context),
    meta_pixel: metaResult ?? checkMetaPixel(client, site),
  };

  for (const [key, value] of Object.entries(results)) {
    saveResult(client.id, key, value);
    // Il motivo esatto finisce anche nel log del server: senza, un controllo
    // rosso costringeva ad aprire la scheda per capire cosa fosse successo.
    if (value.status === 'problema') {
      console.warn(`[qa] ${client.name} · ${key}: ${value.detail}`);
    }
  }

  // Un canale che risponde davvero non deve restare "da fare" nella scheda.
  const promoted = [
    promoteChannel(client, 'status_gtm', results.gtm.status === 'ok'),
    promoteChannel(client, 'status_ga4', results.ga4.status === 'ok'),
    promoteChannel(client, 'status_meta_pixel', results.meta_pixel.status === 'ok'),
  ].filter(Boolean);

  for (const change of promoted) {
    console.log(`[qa] ${client.name} · ${change.field}: ${change.from} → ${change.to} (verificato dal controllo)`);
  }

  return results;
}

/**
 * Ricontrolla un solo cliente. Serve al pulsante nella sua scheda: senza,
 * l'unico modo di aggiornare l'esito era rilanciare l'intero portafoglio o
 * aspettare il giro notturno — ed è esattamente il motivo per cui un controllo
 * poteva restare fermo a un risultato vecchio dopo aver sistemato la configurazione.
 */
export async function runQaForClient(clientId, { endpoints = DEFAULT_ENDPOINTS } = {}) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new HttpError(404, 'Cliente non trovato');

  const startedAt = Date.now();
  const results = await checkClient(client, ga4Context(endpoints));
  const problems = Object.values(results).filter((r) => r.status === 'problema').length;

  console.log(`[qa] ricontrollo di ${client.name}: ${problems} problemi, ${Date.now() - startedAt} ms`);
  return { checks: resultsFor(client.id), problems };
}

/** Esegue il controllo su tutto il portafoglio. */
export async function runQa({ origin = 'manuale', endpoints = DEFAULT_ENDPOINTS } = {}) {
  const startedAt = Date.now();
  const run = db.prepare('INSERT INTO qa_runs (origin) VALUES (?) RETURNING id').get(origin);

  const clients = db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE').all();
  const context = ga4Context(endpoints);
  let problems = 0;

  for (const client of clients) {
    const results = await checkClient(client, context);
    problems += Object.values(results).filter((r) => r.status === 'problema').length;
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

/** Esiti per cliente, indicizzati per chiave del controllo. */
export function resultsFor(clientId) {
  const rows = db.prepare('SELECT * FROM qa_results WHERE client_id = ?').all(clientId);
  const byKey = new Map(rows.map((r) => [r.check_key, r]));

  return QA_CHECKS.map((check) => {
    const row = byKey.get(check.key);
    return {
      key: check.key,
      label: check.label,
      status: row?.status ?? 'mai',
      detail: row?.detail ?? 'Mai controllato',
      checkedAt: row?.checked_at ?? null,
    };
  });
}

/**
 * Riepilogo per la vista clienti: un solo stato per cliente.
 *
 * Un cliente in cui nessun controllo è stato possibile NON è verde: sarebbe un
 * "tutto a posto" mai verificato. Verde solo se almeno un controllo è passato
 * davvero e nessuno è fallito.
 */
export function summaryByClient() {
  const rows = db.prepare('SELECT client_id, check_key, status, detail, checked_at FROM qa_results').all();
  const map = new Map();

  for (const row of rows) {
    if (!map.has(row.client_id)) {
      map.set(row.client_id, { status: 'na', problems: [], verified: 0, checkedAt: row.checked_at });
    }
    const entry = map.get(row.client_id);

    if (row.status === 'problema') {
      entry.problems.push({ key: row.check_key, detail: row.detail });
    } else if (row.status === 'ok') {
      entry.verified += 1;
    }
    if (row.checked_at > entry.checkedAt) entry.checkedAt = row.checked_at;
  }

  for (const entry of map.values()) {
    entry.status = entry.problems.length ? 'problema' : entry.verified > 0 ? 'ok' : 'na';
  }
  return map;
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
      runQa({ origin: 'recupero all\'avvio' }).catch((err) => console.error(`[qa] fallito: ${err.message}`));
    }, 5000).unref?.();
    return { hour, nextInHours: hours, catchUp: true };
  }
  return { hour, nextInHours: hours, catchUp: false };
}
