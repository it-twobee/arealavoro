// Reporting: definizioni per archetipo -> query GA4 -> schema comune -> DB.
//
// La parte pura (definizioni JSON in lib/tracking/definitions, periodo,
// congelamento della definizione, lettura del run in forma pronta per la UI,
// traduzioni Klaviyo/Meta) sta in lib/tracking/reporting.ts, condivisa col
// CRM. Qui restano le credenziali d'agenzia nel vault, l'esecuzione delle
// chiamate e la scrittura in report_runs / report_rows su SQLite.

import { db } from './db.js';
import { HttpError } from './http-error.js';
import * as vault from './vault.js';
import { fetchMetadata, parseServiceAccount, runReport } from './ga4.js';
import { findConversionMetric, flowValues, listLiveFlows } from './klaviyo.js';
import { accountInsights, normalizeAdAccount } from './meta.js';
import {
  DEFAULT_LEAD_EVENT,
  KLAVIYO_DEFINITION,
  META_DEFINITION,
  breakdownQuery,
  definitionFor,
  deriveFunnel,
  eventParameterQuery,
  freezeDefinition,
  funnelQuery,
  ga4Snapshot,
  klaviyoMetrics,
  listDefinitions,
  periodLast30,
  shapeReport,
  skippedEmpty,
  skippedUnavailable,
  storedDefinition,
  sumFlows,
  totalsMetrics,
} from '../lib/tracking/reporting.ts';
import { reportToCsv } from '../lib/tracking/csv.ts';

export { DEFAULT_LEAD_EVENT, definitionFor, listDefinitions, periodLast30, reportToCsv };

const KEEP_RUNS_PER_CLIENT = 30;

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

/** Contesto per i client TS: `endpoints` solo se iniettato, altrimenti i default. */
const withEndpoints = (context, endpoints) => (endpoints ? { ...context, endpoints } : context);

/* ---------- esecuzione GA4 ---------- */

/**
 * Genera il report GA4 di un cliente. `endpoints` è iniettabile per collaudare
 * il flusso completo contro un server finto, senza credenziali reali.
 */
export async function runGa4Report(client, { endpoints, reference } = {}) {
  const def = definitionFor(client.archetype);
  if (!def) throw new HttpError(409, 'Assegna un archetipo al cliente: determina la definizione del report');
  if (!client.ga4_property_id) throw new HttpError(409, 'Property ID GA4 mancante per questo cliente');

  const period = periodLast30(reference);
  const context = withEndpoints({ account: ga4Account() }, endpoints);
  const propertyId = client.ga4_property_id;
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

  const push = (range, breakdown, rows) => {
    for (const row of rows) {
      collected.push({
        period: range.period,
        scope: 'breakdown',
        breakdown,
        dimensions: row.dimensions,
        metrics: row.metrics,
      });
    }
  };

  // Sequenziale di proposito: se una query fallisce si sa esattamente quale,
  // e non si bruciano quote con una raffica di richieste in parallelo.
  try {
    for (const range of ranges) {
      const dates = { propertyId, startDate: range.startDate, endDate: range.endDate };

      const totals = await runReport({ ...dates, metrics: def.ga4.totals.metrics, limit: 1 }, context);
      sampled = sampled || totals.sampled;
      collected.push({
        period: range.period,
        scope: 'total',
        breakdown: null,
        dimensions: {},
        metrics: totalsMetrics(totals.rows, def.ga4.totals.metrics),
      });

      // --- Funnel: due query filtrate, le colonne derivate le calcola il nucleo
      // perché la Data API v1beta non espone un endpoint funnel.
      for (const funnel of def.ga4.funnels ?? []) {
        const comune = { ...dates, ...funnelQuery(funnel) };
        const [visite, lead] = await Promise.all([
          runReport(comune, context),
          runReport({ ...comune, eventName: leadEvent }, context),
        ]).catch((err) => {
          throw new HttpError(err.status ?? 502, `Funnel "${funnel.id}": ${err.message}`);
        });

        push(range, funnel.id, deriveFunnel(visite.rows, lead.rows));
        sampled = sampled || visite.sampled || lead.sampled;
      }

      for (const breakdown of def.ga4.breakdowns ?? []) {
        const result = await runReport({ ...dates, ...breakdownQuery(breakdown) }, context).catch((err) => {
          // Attribuisce l'errore al blocco che l'ha causato: senza questo un
          // nome di metrica sbagliato dà un errore GA4 senza contesto.
          throw new HttpError(err.status ?? 502, `Blocco "${breakdown.id}": ${err.message}`);
        });

        sampled = sampled || result.sampled;
        push(range, breakdown.id, result.rows);
      }

      // --- Parametri custom degli eventi: se la dimensione personalizzata non
      // è registrata sulla property, GA4 risponde con un errore che NON deve
      // affondare l'intero report. Si salta la sezione e si dice perché.
      for (const param of def.ga4.eventParameters ?? []) {
        try {
          const result = await runReport({ ...dates, ...eventParameterQuery(param) }, context);
          push(range, param.id, result.rows);
          if (result.rows.length === 0 && range.period === 'current') skipped.push(skippedEmpty(param));
        } catch (err) {
          if (range.period === 'current') skipped.push(skippedUnavailable(param, err.message));
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
  const runId = recordRun(client, ga4Snapshot(def, leadEvent), period, {
    ok: true,
    error: null,
    durationMs: Date.now() - startedAt,
    rows: collected,
  });

  return { ...getReport(client.id, runId), sampled, skipped, leadEvent };
}

/* ---------- Klaviyo ---------- */

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

/**
 * Estrae le performance dei flussi attivi e le scrive nello stesso schema di GA4,
 * distinte da `source = 'klaviyo'`.
 */
export async function runKlaviyoReport(client, { endpoints, reference } = {}) {
  const period = periodLast30(reference);
  const context = withEndpoints({ apiKey: klaviyoKey(client.id) }, endpoints);
  const startedAt = Date.now();

  try {
    const flows = await listLiveFlows(context);
    if (flows.length === 0) {
      throw new HttpError(409, 'Nessun flusso attivo su questo account Klaviyo');
    }

    const metric = await findConversionMetric(context);
    const flowIds = flows.map((f) => f.id);

    const ranges = [
      { period: 'current', start: period.start, end: period.end },
      { period: 'previous', start: period.compareStart, end: period.compareEnd },
    ];

    const collected = [];
    for (const range of ranges) {
      const values = await flowValues(
        { flowIds, conversionMetricId: metric.id, start: range.start, end: range.end },
        context,
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
export function metaContextFor(clientId, endpoints) {
  if (!vault.isUnlocked()) return { error: 'Cifratura bloccata: le credenziali Meta non sono leggibili' };
  try {
    return {
      context: withEndpoints({ token: metaToken() }, endpoints),
      adAccountId: metaAdAccount(clientId),
    };
  } catch (err) {
    return { error: err.message };
  }
}

/** Estrae le performance Meta e le scrive nello schema comune. */
export async function runMetaReport(client, { endpoints, reference } = {}) {
  const period = periodLast30(reference);
  const context = withEndpoints({ token: metaToken() }, endpoints);
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

/* ---------- scrittura ---------- */

function recordRun(client, def, period, { ok, error, durationMs, rows = [], source = 'ga4' }) {
  // Si congela la definizione usata, non solo il titolo: i file sono
  // modificabili, e un report di due mesi fa deve restare leggibile con le
  // colonne e i titoli che aveva allora.
  const frozen = freezeDefinition(def);

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
      JSON.stringify(frozen),
      frozen.version ?? 1,
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

/** Report completo, con totali confrontati e breakdown pronti per la UI. */
export function getReport(clientId, runId) {
  const run = db
    .prepare('SELECT * FROM report_runs WHERE id = ? AND client_id = ?')
    .get(runId, clientId);
  if (!run) throw new HttpError(404, 'Report non trovato');

  const rows = db
    .prepare('SELECT id, period, scope, breakdown, dimensions, metrics FROM report_rows WHERE run_id = ? ORDER BY id')
    .all(runId)
    .map((r) => ({ ...r, dimensions: JSON.parse(r.dimensions), metrics: JSON.parse(r.metrics) }));

  // `definition` è la stringa JSON della colonna: `shapeReport` la sa leggere.
  return shapeReport(run, rows);
}

/* ---------- metadati property ---------- */

export async function ga4Metadata(client, { endpoints } = {}) {
  return fetchMetadata(client.ga4_property_id, withEndpoints({ account: ga4Account() }, endpoints));
}
