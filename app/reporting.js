// Reporting: definizioni per archetipo -> query GA4 -> schema comune -> DB.
//
// Le definizioni stanno in reporting/definitions/<archetipo>.json, come le
// checklist: modificabili con un editor, versionabili, ricaricate sull'mtime.
// I risultati vengono normalizzati in report_rows con dimensioni e metriche come
// JSON, così Google Ads e Meta si innestano senza cambiare lo schema.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, db } from './db.js';
import { HttpError } from './http-error.js';
import { archetypeByValue } from './archetypes.js';
import * as vault from './vault.js';
import { DEFAULT_ENDPOINTS, fetchMetadata, parseServiceAccount, runReport } from './ga4.js';
import {
  DEFAULT_ENDPOINTS as KLAVIYO_ENDPOINTS,
  findConversionMetric,
  flowValues,
  listLiveFlows,
} from './klaviyo.js';
import {
  DEFAULT_ENDPOINTS as META_ENDPOINTS,
  accountInsights,
  normalizeAdAccount,
} from './meta.js';

const DEFINITIONS_DIR = path.join(ROOT, 'reporting', 'definitions');

/** Convenzione GA4 per l'evento di lead, se il cliente non ne ha uno diverso. */
export const DEFAULT_LEAD_EVENT = 'generate_lead';
const KEEP_RUNS_PER_CLIENT = 30;

const cache = new Map();

/* ---------- definizioni ---------- */

function validateDefinition(file, def) {
  const totals = def.ga4?.totals;
  if (!Array.isArray(totals?.metrics) || totals.metrics.length === 0) {
    throw new Error(`${file}: ga4.totals.metrics deve elencare almeno una metrica`);
  }

  for (const funnel of def.ga4.funnels ?? []) {
    if (!funnel.id) throw new Error(`${file}: funnel senza id`);
    if (!Array.isArray(funnel.dimensions) || funnel.dimensions.length === 0) {
      throw new Error(`${file}: funnel "${funnel.id}" senza dimensioni`);
    }
  }
  for (const param of def.ga4.eventParameters ?? []) {
    if (!param.id || !param.dimension) {
      throw new Error(`${file}: parametro evento senza id o dimension`);
    }
  }

  const seen = new Set();
  for (const breakdown of def.ga4.breakdowns ?? []) {
    if (!breakdown.id) throw new Error(`${file}: breakdown senza id`);
    if (seen.has(breakdown.id)) throw new Error(`${file}: id breakdown duplicato "${breakdown.id}"`);
    seen.add(breakdown.id);

    if (!Array.isArray(breakdown.dimensions) || breakdown.dimensions.length === 0) {
      throw new Error(`${file}: breakdown "${breakdown.id}" senza dimensioni`);
    }
    if (!Array.isArray(breakdown.metrics) || breakdown.metrics.length === 0) {
      throw new Error(`${file}: breakdown "${breakdown.id}" senza metriche`);
    }
    if (breakdown.orderBy && !breakdown.metrics.includes(breakdown.orderBy)) {
      // GA4 rifiuta un orderBy su una metrica non richiesta: meglio dirlo qui.
      throw new Error(
        `${file}: breakdown "${breakdown.id}" ordina per "${breakdown.orderBy}", che non è tra le sue metriche`,
      );
    }
  }
  return def;
}

export function definitionFor(archetype) {
  const meta = archetypeByValue(archetype);
  if (!meta) return null;

  const file = path.join(DEFINITIONS_DIR, `${meta.value}.json`);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HttpError(500, `Definizione report mancante per ${archetype}: ${file}`);
  }

  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.def;

  let def;
  try {
    def = validateDefinition(file, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    throw new HttpError(500, `Definizione report non valida: ${err.message}`);
  }

  cache.set(file, { mtimeMs: stat.mtimeMs, def });
  return def;
}

export function listDefinitions() {
  return ['ecommerce', 'leadgen-b2b', 'hospitality'].map((archetype) => {
    const def = definitionFor(archetype);
    return {
      archetype,
      title: def.title,
      version: def.version ?? 1,
      note: def.note ?? '',
      totalsMetrics: def.ga4.totals.metrics.length,
      breakdowns: (def.ga4.breakdowns ?? []).map((b) => ({
        id: b.id,
        title: b.title ?? b.id,
        dimensions: b.dimensions,
        metrics: b.metrics,
      })),
    };
  });
}

/* ---------- periodo ---------- */

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Ultimi 30 giorni con confronto sui 30 precedenti. La finestra chiude *ieri*:
 * il giorno in corso in GA4 è incompleto e farebbe sembrare ogni report in calo.
 */
export function periodLast30(reference = new Date()) {
  const end = new Date(reference);
  end.setUTCDate(end.getUTCDate() - 1);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);

  const compareEnd = new Date(start);
  compareEnd.setUTCDate(compareEnd.getUTCDate() - 1);

  const compareStart = new Date(compareEnd);
  compareStart.setUTCDate(compareStart.getUTCDate() - 29);

  return {
    start: isoDate(start),
    end: isoDate(end),
    compareStart: isoDate(compareStart),
    compareEnd: isoDate(compareEnd),
  };
}

/* ---------- credenziali agenzia ---------- */

export function agencyCredentialStatus() {
  const rows = db.prepare('SELECT platform, updated_at FROM agency_credentials').all();
  return new Map(rows.map((r) => [r.platform, r.updated_at]));
}

export function saveAgencyCredential(platform, value) {
  if (value === '') {
    const { changes } = db.prepare('DELETE FROM agency_credentials WHERE platform = ?').run(platform);
    return { platform, hasValue: false, deleted: changes > 0 };
  }

  const row = db
    .prepare(
      `INSERT INTO agency_credentials (platform, blob) VALUES (?, ?)
       ON CONFLICT(platform) DO UPDATE SET blob = excluded.blob, updated_at = datetime('now')
       RETURNING updated_at`,
    )
    .get(platform, vault.seal(value));

  return { platform, hasValue: true, updatedAt: row.updated_at };
}

export function readAgencyCredential(platform) {
  const row = db.prepare('SELECT blob FROM agency_credentials WHERE platform = ?').get(platform);
  if (!row) return null;
  return vault.open(row.blob);
}

/** Service account GA4 pronto all'uso, con errori parlanti se manca qualcosa. */
function ga4Account() {
  const raw = readAgencyCredential('ga4');
  if (!raw) {
    throw new HttpError(
      409,
      'Service account GA4 non configurato: inseriscilo in Impostazioni prima di generare report',
    );
  }
  return parseServiceAccount(raw);
}

/* ---------- esecuzione ---------- */

/**
 * Genera il report GA4 di un cliente. `endpoints` è iniettabile per collaudare
 * il flusso completo contro un server finto, senza credenziali reali.
 */
export async function runGa4Report(client, { endpoints = DEFAULT_ENDPOINTS, reference } = {}) {
  const def = definitionFor(client.archetype);
  if (!def) throw new HttpError(409, 'Assegna un archetipo al cliente: determina la definizione del report');
  if (!client.ga4_property_id) throw new HttpError(409, 'Property ID GA4 mancante per questo cliente');

  const period = periodLast30(reference);
  const account = ga4Account();
  const context = { account, endpoints };
  const startedAt = Date.now();

  const ranges = [
    { period: 'current', startDate: period.start, endDate: period.end },
    { period: 'previous', startDate: period.compareStart, endDate: period.compareEnd },
  ];

  const collected = [];
  const skipped = [];
  let sampled = false;

  // Evento che segna il lead nel funnel: personalizzabile per cliente, perché
  // non tutti l'hanno chiamato allo stesso modo in GTM.
  const leadEvent = client.lead_event?.trim() || DEFAULT_LEAD_EVENT;

  // Sequenziale di proposito: se una query fallisce si sa esattamente quale,
  // e non si bruciano quote con una raffica di richieste in parallelo.
  try {
    for (const range of ranges) {
      const totals = await runReport(
        {
          propertyId: client.ga4_property_id,
          startDate: range.startDate,
          endDate: range.endDate,
          metrics: def.ga4.totals.metrics,
          limit: 1,
        },
        context,
      );
      sampled = sampled || totals.sampled;
      collected.push({
        period: range.period,
        scope: 'total',
        breakdown: null,
        dimensions: {},
        metrics: totals.rows[0]?.metrics ?? Object.fromEntries(def.ga4.totals.metrics.map((m) => [m, 0])),
      });

      // --- Funnel: due query filtrate, le colonne derivate le calcoliamo qui
      // perché la Data API v1beta non espone un endpoint funnel.
      for (const funnel of def.ga4.funnels ?? []) {
        const comune = {
          propertyId: client.ga4_property_id,
          startDate: range.startDate,
          endDate: range.endDate,
          metrics: ['activeUsers'],
          dimensions: funnel.dimensions,
          orderBy: 'activeUsers',
          limit: funnel.limit ?? 20,
        };

        const [visite, lead] = await Promise.all([
          runReport(comune, context),
          runReport({ ...comune, eventName: leadEvent }, context),
        ]).catch((err) => {
          throw new HttpError(err.status ?? 502, `Funnel "${funnel.id}": ${err.message}`);
        });

        const chiave = (row) => Object.values(row.dimensions).join(' | ');
        const leadPerChiave = new Map(lead.rows.map((r) => [chiave(r), r.metrics.activeUsers ?? 0]));

        for (const row of visite.rows) {
          const step1 = row.metrics.activeUsers ?? 0;
          const step2 = leadPerChiave.get(chiave(row)) ?? 0;
          collected.push({
            period: range.period,
            scope: 'breakdown',
            breakdown: funnel.id,
            dimensions: row.dimensions,
            metrics: {
              utenti_visita: step1,
              utenti_lead: step2,
              percentuale_completamento: step1 ? step2 / step1 : 0,
              abbandoni: Math.max(step1 - step2, 0),
              tasso_abbandono: step1 ? Math.max(step1 - step2, 0) / step1 : 0,
            },
          });
        }
        sampled = sampled || visite.sampled || lead.sampled;
      }

      for (const breakdown of def.ga4.breakdowns ?? []) {
        const result = await runReport(
          {
            propertyId: client.ga4_property_id,
            startDate: range.startDate,
            endDate: range.endDate,
            metrics: breakdown.metrics,
            dimensions: breakdown.dimensions,
            orderBy: breakdown.orderBy ?? breakdown.metrics[0],
            limit: breakdown.limit ?? 20,
          },
          context,
        ).catch((err) => {
          // Attribuisce l'errore al blocco che l'ha causato: senza questo un
          // nome di metrica sbagliato dà un errore GA4 senza contesto.
          throw new HttpError(err.status ?? 502, `Blocco "${breakdown.id}": ${err.message}`);
        });

        sampled = sampled || result.sampled;
        for (const row of result.rows) {
          collected.push({
            period: range.period,
            scope: 'breakdown',
            breakdown: breakdown.id,
            dimensions: row.dimensions,
            metrics: row.metrics,
          });
        }
      }

      // --- Parametri custom degli eventi. Dipendono dalla configurazione GTM
      // del singolo cliente: se la dimensione personalizzata non è registrata
      // sulla property, GA4 risponde con un errore. Qui quell'errore NON deve
      // affondare l'intero report: si salta la sezione e si dice perché.
      for (const param of def.ga4.eventParameters ?? []) {
        try {
          const result = await runReport(
            {
              propertyId: client.ga4_property_id,
              startDate: range.startDate,
              endDate: range.endDate,
              metrics: param.metrics ?? ['eventCount', 'activeUsers'],
              dimensions: [param.dimension],
              eventName: param.eventName ?? null,
              orderBy: (param.metrics ?? ['eventCount'])[0],
              limit: param.limit ?? 20,
            },
            context,
          );

          for (const row of result.rows) {
            collected.push({
              period: range.period,
              scope: 'breakdown',
              breakdown: param.id,
              dimensions: row.dimensions,
              metrics: row.metrics,
            });
          }
          if (result.rows.length === 0 && range.period === 'current') {
            skipped.push({ id: param.id, title: param.title, reason: 'Nessun dato nel periodo' });
          }
        } catch (err) {
          if (range.period === 'current') {
            skipped.push({
              id: param.id,
              title: param.title,
              reason: `${param.dimension} non disponibile su questa property: ${err.message}`,
            });
          }
        }
      }
    }
  } catch (err) {
    recordRun(client, def, period, { ok: false, error: err.message, durationMs: Date.now() - startedAt });
    throw err;
  }

  // La definizione congelata deve descrivere ogni sezione prodotta — funnel e
  // parametri custom compresi — altrimenti alla rilettura mancherebbero titoli
  // e nomi di colonna.
  const snapshot = {
    title: def.title,
    version: def.version,
    breakdowns: sectionsOf(def, leadEvent),
  };

  const runId = recordRun(client, snapshot, period, {
    ok: true,
    error: null,
    durationMs: Date.now() - startedAt,
    rows: collected,
  });

  return { ...getReport(client.id, runId), sampled, skipped, leadEvent };
}

/**
 * Elenco ordinato delle sezioni di un report, con i nomi di colonna che la UI
 * userà per le intestazioni. Funnel e parametri custom vengono descritti come
 * i breakdown normali, così la resa è la stessa.
 */
function sectionsOf(def, leadEvent) {
  const funnels = (def.ga4.funnels ?? []).map((f) => ({
    id: f.id,
    title: `${f.title} · ${f.step1Label ?? 'Passaggio 1'} → ${f.step2Label ?? 'Passaggio 2'} (${leadEvent})`,
    dimensions: f.dimensions,
    metrics: [
      'utenti_visita',
      'utenti_lead',
      'percentuale_completamento',
      'abbandoni',
      'tasso_abbandono',
    ],
  }));

  const breakdowns = (def.ga4.breakdowns ?? []).map((b) => ({
    id: b.id,
    title: b.title ?? b.id,
    dimensions: b.dimensions,
    metrics: b.metrics,
  }));

  const parameters = (def.ga4.eventParameters ?? []).map((p) => ({
    id: p.id,
    title: p.title ?? p.id,
    dimensions: [p.dimension],
    metrics: p.metrics ?? ['eventCount', 'activeUsers'],
  }));

  return [...funnels, ...breakdowns, ...parameters];
}

/* ---------- Klaviyo ---------- */

/** Definizione del report Klaviyo: fissa, non dipende dall'archetipo. */
const KLAVIYO_DEFINITION = {
  title: 'Klaviyo — flussi attivi, 30 giorni',
  version: 1,
  breakdowns: [
    {
      id: 'flussi',
      title: 'Per flusso attivo',
      dimensions: ['flusso'],
      metrics: ['destinatari', 'aperture', 'tasso_apertura', 'click', 'tasso_click', 'ricavi'],
    },
  ],
};

/** Chiave Klaviyo del cliente: sta fra le chiavi per cliente, non fra quelle d'agenzia. */
function klaviyoKey(clientId) {
  const row = db
    .prepare("SELECT blob FROM credentials WHERE client_id = ? AND platform = 'klaviyo'")
    .get(clientId);
  if (!row) {
    throw new HttpError(
      409,
      'Chiave API Klaviyo non inserita per questo cliente: aggiungila nella scheda Chiavi',
    );
  }
  return vault.open(row.blob);
}

/** Traduce le statistiche di Klaviyo nei nomi usati dallo schema comune. */
function klaviyoMetrics(stats = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    destinatari: num(stats.recipients),
    aperture: num(stats.opens),
    // Klaviyo restituisce i tassi come frazione 0..1, come GA4: si mantiene.
    tasso_apertura: num(stats.open_rate),
    click: num(stats.clicks),
    tasso_click: num(stats.click_rate),
    ricavi: num(stats.conversion_value),
  };
}

/** Somma i flussi per ottenere i totali del periodo. */
function sumFlows(rows) {
  const totale = { flussi_attivi: rows.length, destinatari: 0, aperture: 0, click: 0, ricavi: 0 };
  for (const row of rows) {
    totale.destinatari += row.metrics.destinatari;
    totale.aperture += row.metrics.aperture;
    totale.click += row.metrics.click;
    totale.ricavi += row.metrics.ricavi;
  }
  // I tassi complessivi si ricalcolano sui totali: fare la media dei tassi dei
  // singoli flussi darebbe lo stesso peso a un flusso da 10 invii e a uno da 10.000.
  totale.tasso_apertura = totale.destinatari ? totale.aperture / totale.destinatari : 0;
  totale.tasso_click = totale.destinatari ? totale.click / totale.destinatari : 0;
  return totale;
}

/**
 * Estrae le performance dei flussi attivi e le scrive nello stesso schema di GA4,
 * distinte da `source = 'klaviyo'`.
 */
export async function runKlaviyoReport(client, { endpoints = KLAVIYO_ENDPOINTS, reference } = {}) {
  const period = periodLast30(reference);
  const options = { apiKey: klaviyoKey(client.id), endpoints };
  const startedAt = Date.now();

  try {
    const flows = await listLiveFlows(options);
    if (flows.length === 0) {
      throw new HttpError(409, 'Nessun flusso attivo su questo account Klaviyo');
    }

    const metric = await findConversionMetric(options);
    const flowIds = flows.map((f) => f.id);

    const ranges = [
      { period: 'current', start: period.start, end: period.end },
      { period: 'previous', start: period.compareStart, end: period.compareEnd },
    ];

    const collected = [];
    for (const range of ranges) {
      const values = await flowValues(
        { flowIds, conversionMetricId: metric.id, start: range.start, end: range.end },
        options,
      );

      const rows = flows.map((flow) => ({
        period: range.period,
        scope: 'breakdown',
        breakdown: 'flussi',
        dimensions: { flusso: flow.name },
        metrics: klaviyoMetrics(values.get(flow.id)),
      }));

      collected.push(...rows, {
        period: range.period,
        scope: 'total',
        breakdown: null,
        dimensions: {},
        metrics: sumFlows(rows),
      });
    }

    const runId = recordRun(client, KLAVIYO_DEFINITION, period, {
      ok: true,
      error: null,
      durationMs: Date.now() - startedAt,
      rows: collected,
      source: 'klaviyo',
    });

    return { ...getReport(client.id, runId), conversionMetric: metric.name, flows: flows.length };
  } catch (err) {
    recordRun(client, KLAVIYO_DEFINITION, period, {
      ok: false,
      error: err.message,
      durationMs: Date.now() - startedAt,
      source: 'klaviyo',
    });
    throw err;
  }
}

/* ---------- Meta ---------- */

const META_DEFINITION = {
  title: 'Meta Ads — 30 giorni',
  version: 1,
  breakdowns: [
    {
      id: 'azioni',
      title: 'Azioni registrate sull\'account',
      dimensions: ['azione'],
      metrics: ['conteggio', 'costo_per_azione'],
    },
  ],
};

/** Ad Account ID del cliente: sta fra le chiavi per cliente, non è un segreto. */
function metaAdAccount(clientId) {
  const row = db
    .prepare("SELECT blob FROM credentials WHERE client_id = ? AND platform = 'meta'")
    .get(clientId);
  if (!row) {
    throw new HttpError(
      409,
      "Ad Account ID Meta non inserito per questo cliente: aggiungilo nella scheda Chiavi",
    );
  }
  return vault.open(row.blob);
}

/** Token del System User, a livello agenzia. */
export function metaToken() {
  const raw = readAgencyCredential('meta');
  if (!raw) {
    throw new HttpError(409, 'Token System User Meta non configurato: inseriscilo in Impostazioni');
  }
  return raw.trim();
}

/** Contesto pronto per le chiamate, o l'errore che impedisce di farle. */
export function metaContextFor(clientId, endpoints = META_ENDPOINTS) {
  if (!vault.isUnlocked()) return { error: 'Cifratura bloccata: le credenziali Meta non sono leggibili' };
  try {
    return { context: { token: metaToken(), endpoints }, adAccountId: metaAdAccount(clientId) };
  } catch (err) {
    return { error: err.message };
  }
}

/** Estrae le performance Meta e le scrive nello schema comune. */
export async function runMetaReport(client, { endpoints = META_ENDPOINTS, reference } = {}) {
  const period = periodLast30(reference);
  const context = { token: metaToken(), endpoints };
  const adAccountId = metaAdAccount(client.id);
  const startedAt = Date.now();

  try {
    const ranges = [
      { period: 'current', since: period.start, until: period.end },
      { period: 'previous', since: period.compareStart, until: period.compareEnd },
    ];

    const collected = [];
    let conversionActions = [];
    let vuoto = true;

    for (const range of ranges) {
      const insight = await accountInsights(
        { adAccountId, since: range.since, until: range.until },
        context,
      );

      if (range.period === 'current') {
        conversionActions = insight.conversionActions;
        vuoto = insight.vuoto;
      }

      collected.push({
        period: range.period,
        scope: 'total',
        breakdown: null,
        dimensions: {},
        metrics: insight.metrics,
      });

      for (const azione of insight.actions) {
        collected.push({
          period: range.period,
          scope: 'breakdown',
          breakdown: 'azioni',
          dimensions: { azione: azione.action_type },
          metrics: { conteggio: azione.conteggio, costo_per_azione: azione.costo_per_azione },
        });
      }
    }

    const runId = recordRun(client, META_DEFINITION, period, {
      ok: true,
      error: null,
      durationMs: Date.now() - startedAt,
      rows: collected,
      source: 'meta',
    });

    return {
      ...getReport(client.id, runId),
      adAccountId: normalizeAdAccount(adAccountId),
      conversionActions,
      vuoto,
    };
  } catch (err) {
    recordRun(client, META_DEFINITION, period, {
      ok: false,
      error: err.message,
      durationMs: Date.now() - startedAt,
      source: 'meta',
    });
    throw err;
  }
}

function recordRun(client, def, period, { ok, error, durationMs, rows = [], source = 'ga4' }) {
  // Si congela la definizione usata, non solo il titolo: i file sono
  // modificabili, e un report di due mesi fa deve restare leggibile con le
  // colonne e i titoli che aveva allora.
  // `breakdowns` sta al primo livello: è comune a tutte le fonti, mentre `ga4`
  // resta per compatibilità con i run già salvati.
  const run = db
    .prepare(
      `INSERT INTO report_runs
         (client_id, source, definition, definition_ver, period_start, period_end,
          compare_start, compare_end, ok, error, row_count, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      client.id,
      source,
      JSON.stringify({
        title: def.title,
        version: def.version ?? 1,
        breakdowns: def.breakdowns ?? def.ga4?.breakdowns ?? [],
        ...(def.ga4 ? { ga4: def.ga4 } : {}),
      }),
      def.version ?? 1,
      period.start,
      period.end,
      period.compareStart,
      period.compareEnd,
      ok ? 1 : 0,
      error,
      rows.length,
      durationMs,
    );

  if (rows.length) {
    const insert = db.prepare(
      `INSERT INTO report_rows (run_id, period, scope, breakdown, dimensions, metrics)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        run.id,
        row.period,
        row.scope,
        row.breakdown,
        JSON.stringify(row.dimensions),
        JSON.stringify(row.metrics),
      );
    }
  }

  applyRunRetention(client.id);
  return run.id;
}

/** Tiene gli ultimi N run per cliente; le righe cadono in cascata. */
function applyRunRetention(clientId) {
  db.prepare(
    `DELETE FROM report_runs
      WHERE client_id = ?
        AND id NOT IN (
          SELECT id FROM report_runs WHERE client_id = ? ORDER BY id DESC LIMIT ?
        )`,
  ).run(clientId, clientId, KEEP_RUNS_PER_CLIENT);
}

/* ---------- lettura ---------- */

/**
 * La definizione congelata nel run. Tollera i run più vecchi, in cui la colonna
 * conteneva solo il titolo come testo semplice.
 * Il riconoscimento è su `title`, non su `ga4`: le fonti sono più di una.
 */
function storedDefinition(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.title === 'string') return parsed;
  } catch {
    // testo semplice: si usa così com'è
  }
  return { title: String(raw), version: null, breakdowns: [] };
}

export function runHistory(clientId, limit = 20) {
  return db
    .prepare(
      `SELECT id, source, definition, definition_ver, period_start, period_end,
              compare_start, compare_end, ok, error, row_count, duration_ms, created_at
         FROM report_runs WHERE client_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(clientId, limit)
    .map((r) => ({
      id: r.id,
      source: r.source,
      definition: storedDefinition(r.definition).title,
      definitionVersion: r.definition_ver,
      period: { start: r.period_start, end: r.period_end, compareStart: r.compare_start, compareEnd: r.compare_end },
      ok: Boolean(r.ok),
      error: r.error,
      rowCount: r.row_count,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }));
}

function variation(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null; // null = da zero, la percentuale non ha senso
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Report completo, con totali confrontati e breakdown pronti per la UI. */
export function getReport(clientId, runId) {
  const run = db
    .prepare('SELECT * FROM report_runs WHERE id = ? AND client_id = ?')
    .get(runId, clientId);
  if (!run) throw new HttpError(404, 'Report non trovato');

  const rows = db
    .prepare('SELECT period, scope, breakdown, dimensions, metrics FROM report_rows WHERE run_id = ? ORDER BY id')
    .all(runId)
    .map((r) => ({ ...r, dimensions: JSON.parse(r.dimensions), metrics: JSON.parse(r.metrics) }));

  const totalsCurrent = rows.find((r) => r.scope === 'total' && r.period === 'current')?.metrics ?? {};
  const totalsPrevious = rows.find((r) => r.scope === 'total' && r.period === 'previous')?.metrics ?? {};

  const totals = Object.keys(totalsCurrent).map((metric) => ({
    metric,
    current: totalsCurrent[metric],
    previous: totalsPrevious[metric] ?? 0,
    variation: variation(totalsCurrent[metric], totalsPrevious[metric] ?? 0),
  }));

  const breakdownIds = [...new Set(rows.filter((r) => r.scope === 'breakdown').map((r) => r.breakdown))];
  const definition = storedDefinition(run.definition);

  const breakdowns = breakdownIds.map((id) => {
    const spec =
      definition.breakdowns?.find((b) => b.id === id) ??
      definition.ga4?.breakdowns?.find((b) => b.id === id);
    const current = rows.filter((r) => r.breakdown === id && r.period === 'current');
    const previous = rows.filter((r) => r.breakdown === id && r.period === 'previous');

    // Confronto riga per riga sulla chiave delle dimensioni: un canale presente
    // solo in un periodo compare comunque, con l'altro a zero.
    const keyOf = (row) => Object.values(row.dimensions).join(' | ');
    const previousByKey = new Map(previous.map((r) => [keyOf(r), r.metrics]));

    return {
      id,
      title: spec?.title ?? id,
      dimensions: spec?.dimensions ?? Object.keys(current[0]?.dimensions ?? {}),
      metrics: spec?.metrics ?? Object.keys(current[0]?.metrics ?? {}),
      rows: current.map((row) => ({
        key: keyOf(row),
        dimensions: row.dimensions,
        metrics: row.metrics,
        previous: previousByKey.get(keyOf(row)) ?? null,
      })),
    };
  });

  return {
    id: run.id,
    source: run.source,
    definition: definition.title,
    definitionVersion: run.definition_ver,
    period: {
      start: run.period_start,
      end: run.period_end,
      compareStart: run.compare_start,
      compareEnd: run.compare_end,
    },
    ok: Boolean(run.ok),
    error: run.error,
    createdAt: run.created_at,
    durationMs: run.duration_ms,
    totals,
    breakdowns,
  };
}

/* ---------- CSV ---------- */

function csvCell(value) {
  const text = String(value ?? '');
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV dei dati grezzi per uso interno. Un unico foglio con tutti i blocchi:
 * le metriche assenti in un blocco restano vuote, così resta apribile in Excel.
 */
export function reportToCsv(clientName, report) {
  const allMetrics = [
    ...new Set([
      ...report.totals.map((t) => t.metric),
      ...report.breakdowns.flatMap((b) => b.metrics),
    ]),
  ];

  const header = ['cliente', 'periodo', 'blocco', 'dimensione', 'valore', ...allMetrics];
  const lines = [header.map(csvCell).join(';')];

  const push = (periodo, blocco, dimensione, valore, metrics) => {
    const row = [clientName, periodo, blocco, dimensione, valore];
    for (const metric of allMetrics) row.push(metrics[metric] ?? '');
    lines.push(row.map(csvCell).join(';'));
  };

  const label = `${report.period.start}…${report.period.end}`;
  const labelPrev = `${report.period.compareStart}…${report.period.compareEnd}`;

  push(label, 'totali', '', '', Object.fromEntries(report.totals.map((t) => [t.metric, t.current])));
  push(labelPrev, 'totali', '', '', Object.fromEntries(report.totals.map((t) => [t.metric, t.previous])));

  for (const breakdown of report.breakdowns) {
    for (const row of breakdown.rows) {
      push(label, breakdown.title, breakdown.dimensions.join(' | '), row.key, row.metrics);
      if (row.previous) {
        push(labelPrev, breakdown.title, breakdown.dimensions.join(' | '), row.key, row.previous);
      }
    }
  }

  // BOM: senza, Excel su Windows sbaglia gli accenti.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/* ---------- metadati property ---------- */

export async function ga4Metadata(client, { endpoints = DEFAULT_ENDPOINTS } = {}) {
  return fetchMetadata(client.ga4_property_id, { account: ga4Account(), endpoints });
}
