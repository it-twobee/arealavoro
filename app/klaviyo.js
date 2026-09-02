// Client Klaviyo API, senza dipendenze esterne.
//
// A differenza di GA4 la chiave è **per cliente**: ogni cliente ha il proprio
// account Klaviyo, quindi la private key sta in `credentials` (scheda Chiavi)
// e non fra i segreti d'agenzia.
//
// Klaviyo versiona l'API con l'header `revision`: una data. Se un giorno una
// risposta cambia forma, si aggiorna quella costante invece di inseguire
// modifiche silenziose. Gli endpoint sono iniettabili per poter collaudare il
// flusso contro un server finto, senza una chiave reale.

import { HttpError } from './http-error.js';

export const DEFAULT_ENDPOINTS = {
  base: process.env.TWOBEE_KLAVIYO_BASE ?? 'https://a.klaviyo.com/api',
};

export const REVISION = process.env.TWOBEE_KLAVIYO_REVISION ?? '2024-10-15';
const REQUEST_TIMEOUT_MS = 30000;

/** Statistiche richieste al report: il minimo che serve alla vista. */
export const FLOW_STATISTICS = [
  'opens',
  'open_rate',
  'clicks',
  'click_rate',
  'conversion_value',
  'recipients',
];

async function request(path, { apiKey, method = 'GET', body = null, endpoints = DEFAULT_ENDPOINTS }) {
  if (!apiKey) throw new HttpError(409, 'Chiave API Klaviyo mancante per questo cliente');

  let response;
  try {
    response = await fetch(`${endpoints.base}${path}`, {
      method,
      headers: {
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        accept: 'application/vnd.api+json',
        revision: REVISION,
        ...(body ? { 'content-type': 'application/vnd.api+json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HttpError(502, `Klaviyo non raggiungibile: ${err.cause?.code ?? err.message}`);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Klaviyo restituisce errors[] con detail: è specifico e vale riportarlo.
    const detail = payload.errors?.map((e) => e.detail ?? e.title).filter(Boolean).join(' · ');
    const hint =
      response.status === 401 || response.status === 403
        ? " — controlla che la chiave sia una Private API Key con i permessi di lettura su flussi e metriche"
        : response.status === 400 && detail?.includes('revision')
          ? ` — la revisione API usata è ${REVISION}: aggiornala con TWOBEE_KLAVIYO_REVISION`
          : '';

    throw new HttpError(
      response.status === 401 || response.status === 403 ? 403 : 502,
      `Klaviyo: ${detail || `HTTP ${response.status}`}${hint}`,
    );
  }
  return payload;
}

/** Segue la paginazione a cursore finché ci sono pagine. */
async function requestAll(path, options) {
  const items = [];
  let next = path;
  let guard = 0;

  while (next && guard < 20) {
    const payload = await request(next, options);
    items.push(...(payload.data ?? []));
    const link = payload.links?.next;
    // I link di Klaviyo sono assoluti: si riporta al percorso relativo alla base.
    next = link ? link.replace(options.endpoints?.base ?? DEFAULT_ENDPOINTS.base, '') : null;
    guard += 1;
  }
  return items;
}

/** Flussi attivi ("live"). Gli altri non producono numeri utili. */
export async function listLiveFlows(options) {
  const flows = await requestAll('/flows/?filter=equals(status,"live")&page[size]=50', options);

  return flows.map((flow) => ({
    id: flow.id,
    name: flow.attributes?.name ?? '(senza nome)',
    status: flow.attributes?.status ?? 'live',
    trigger: flow.attributes?.trigger_type ?? '',
    createdAt: flow.attributes?.created ?? null,
  }));
}

/**
 * Metrica di conversione da usare per il fatturato. Klaviyo la richiede
 * esplicitamente: senza, il report non sa cosa considerare "revenue".
 * Si cerca "Placed Order" (e-commerce standard), altrimenti la prima disponibile.
 */
export async function findConversionMetric(options) {
  const metrics = await requestAll('/metrics/?page[size]=100', options);
  if (metrics.length === 0) {
    throw new HttpError(409, 'Nessuna metrica trovata su questo account Klaviyo');
  }

  const byName = (name) =>
    metrics.find((m) => (m.attributes?.name ?? '').toLowerCase() === name.toLowerCase());

  const chosen = byName('Placed Order') ?? byName('Ordered Product') ?? metrics[0];
  return { id: chosen.id, name: chosen.attributes?.name ?? chosen.id };
}

/**
 * Valori aggregati per flusso in un intervallo. Una sola chiamata per periodo:
 * il report di Klaviyo restituisce tutti i flussi insieme.
 */
export async function flowValues({ flowIds, conversionMetricId, start, end }, options) {
  if (flowIds.length === 0) return new Map();

  const body = {
    data: {
      type: 'flow-values-report',
      attributes: {
        timeframe: { start: `${start}T00:00:00+00:00`, end: `${end}T23:59:59+00:00` },
        conversion_metric_id: conversionMetricId,
        statistics: FLOW_STATISTICS,
        filter: `any(flow_id,["${flowIds.join('","')}"])`,
      },
    },
  };

  const payload = await request('/flow-values-reports/', { ...options, method: 'POST', body });
  const results = payload.data?.attributes?.results ?? [];

  return new Map(
    results.map((row) => [
      row.groupings?.flow_id ?? row.groupings?.send_channel ?? 'sconosciuto',
      row.statistics ?? {},
    ]),
  );
}
