/**
 * Client Klaviyo API, senza dipendenze esterne.
 *
 * La chiave è **per cliente** (ogni cliente ha il proprio account Klaviyo):
 * il chiamante la passa già decifrata, qui non si legge nulla.
 *
 * Klaviyo versiona l'API con l'header `revision`: una data. Se una risposta
 * cambia forma si aggiorna TWOBEE_KLAVIYO_REVISION invece di inseguire
 * modifiche silenziose. Gli endpoint sono iniettabili per collaudare il flusso
 * contro un server finto, senza una chiave reale.
 */
import { TrackingError } from '@/lib/tracking/errors'

export const DEFAULT_REVISION = '2024-10-15'

export type KlaviyoEndpoints = { base: string; revision: string }

/** Letti a ogni chiamata, non al load del modulo: le env possono cambiare nei test. */
export function defaultEndpoints(): KlaviyoEndpoints {
  return {
    base: process.env.TWOBEE_KLAVIYO_BASE ?? 'https://a.klaviyo.com/api',
    revision: process.env.TWOBEE_KLAVIYO_REVISION ?? DEFAULT_REVISION,
  }
}

export type KlaviyoContext = { apiKey: string; endpoints?: KlaviyoEndpoints }

export type KlaviyoFlow = {
  id: string
  name: string
  status: string
  trigger: string
  createdAt: string | null
}

export type KlaviyoMetric = { id: string; name: string }

/** Statistiche richieste al report: il minimo che serve alla vista. */
export const FLOW_STATISTICS = ['opens', 'open_rate', 'clicks', 'click_rate', 'conversion_value', 'recipients'] as const
export type FlowStatistic = (typeof FLOW_STATISTICS)[number]

/** Le statistiche tornano come numeri; chiavi assenti se Klaviyo non le calcola. */
export type FlowStatistics = Partial<Record<FlowStatistic, number>> & Record<string, number | undefined>

export type FlowValuesParams = {
  flowIds: string[]
  conversionMetricId: string
  /** 'YYYY-MM-DD', inclusivi, in UTC. */
  start: string
  end: string
}

const REQUEST_TIMEOUT_MS = 30000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function fetchFailure(err: unknown): string {
  if (err instanceof Error) {
    const cause: unknown = err.cause
    if (isRecord(cause) && typeof cause.code === 'string') return cause.code
    return err.message
  }
  return String(err)
}

type KlaviyoErrorBody = { errors?: { detail?: string; title?: string }[] }

async function request<T extends object>(
  path: string,
  ctx: KlaviyoContext,
  init: { method?: 'GET' | 'POST'; body?: object | null } = {},
): Promise<Partial<T>> {
  if (!ctx.apiKey) throw new TrackingError(409, 'Chiave API Klaviyo mancante per questo cliente')
  const endpoints = ctx.endpoints ?? defaultEndpoints()
  const { method = 'GET', body = null } = init

  let response: Response
  try {
    response = await fetch(`${endpoints.base}${path}`, {
      method,
      headers: {
        Authorization: `Klaviyo-API-Key ${ctx.apiKey}`,
        accept: 'application/vnd.api+json',
        revision: endpoints.revision,
        ...(body ? { 'content-type': 'application/vnd.api+json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new TrackingError(502, `Klaviyo non raggiungibile: ${fetchFailure(err)}`)
  }

  const parsed: unknown = await response.json().catch(() => null)
  const payload: Partial<T> & KlaviyoErrorBody = isRecord(parsed) ? (parsed as Partial<T> & KlaviyoErrorBody) : {}

  if (!response.ok) {
    // Klaviyo restituisce errors[] con detail: è specifico e vale riportarlo.
    const detail = (payload.errors ?? []).map(e => e.detail ?? e.title).filter(Boolean).join(' · ')
    const hint =
      response.status === 401 || response.status === 403
        ? ' — controlla che la chiave sia una Private API Key con i permessi di lettura su flussi e metriche'
        : response.status === 400 && detail.includes('revision')
          ? ` — la revisione API usata è ${endpoints.revision}: aggiornala con TWOBEE_KLAVIYO_REVISION`
          : ''

    throw new TrackingError(
      response.status === 401 || response.status === 403 ? 403 : 502,
      `Klaviyo: ${detail || `HTTP ${response.status}`}${hint}`,
    )
  }
  return payload
}

type Resource = { id: string; attributes?: Record<string, unknown> }
type PagedResponse = { data: Resource[]; links: { next?: string | null } }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Segue la paginazione a cursore finché ci sono pagine (max 20: guardia anti-loop). */
async function requestAll(path: string, ctx: KlaviyoContext): Promise<Resource[]> {
  const base = (ctx.endpoints ?? defaultEndpoints()).base
  const items: Resource[] = []
  let next: string | null = path
  let guard = 0

  while (next && guard < 20) {
    const payload: Partial<PagedResponse> = await request<PagedResponse>(next, ctx)
    items.push(...(payload.data ?? []))
    const link: string | null | undefined = payload.links?.next
    // I link di Klaviyo sono assoluti: si riporta al percorso relativo alla base.
    next = link ? link.replace(base, '') : null
    guard += 1
  }
  return items
}

/** Flussi attivi ("live"). Gli altri non producono numeri utili. */
export async function listLiveFlows(ctx: KlaviyoContext): Promise<KlaviyoFlow[]> {
  const flows = await requestAll('/flows/?filter=equals(status,"live")&page[size]=50', ctx)

  return flows.map(flow => ({
    id: flow.id,
    name: str(flow.attributes?.name) ?? '(senza nome)',
    status: str(flow.attributes?.status) ?? 'live',
    trigger: str(flow.attributes?.trigger_type) ?? '',
    createdAt: str(flow.attributes?.created),
  }))
}

/**
 * Metrica di conversione da usare per il fatturato. Klaviyo la richiede
 * esplicitamente: senza, il report non sa cosa considerare "revenue".
 * Si cerca "Placed Order" (e-commerce standard), altrimenti la prima disponibile.
 */
export async function findConversionMetric(ctx: KlaviyoContext): Promise<KlaviyoMetric> {
  const metrics = await requestAll('/metrics/?page[size]=100', ctx)
  if (metrics.length === 0) {
    throw new TrackingError(409, 'Nessuna metrica trovata su questo account Klaviyo')
  }

  const byName = (name: string) =>
    metrics.find(m => (str(m.attributes?.name) ?? '').toLowerCase() === name.toLowerCase())

  const chosen = byName('Placed Order') ?? byName('Ordered Product') ?? metrics[0]
  return { id: chosen.id, name: str(chosen.attributes?.name) ?? chosen.id }
}

type FlowValuesRow = { groupings?: { flow_id?: string; send_channel?: string }; statistics?: FlowStatistics }
type FlowValuesResponse = { data: { attributes?: { results?: FlowValuesRow[] } } }

/**
 * Valori aggregati per flusso in un intervallo. Una sola chiamata per periodo:
 * il report di Klaviyo restituisce tutti i flussi insieme.
 */
export async function flowValues(
  { flowIds, conversionMetricId, start, end }: FlowValuesParams,
  ctx: KlaviyoContext,
): Promise<Map<string, FlowStatistics>> {
  if (flowIds.length === 0) return new Map()

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
  }

  const payload = await request<FlowValuesResponse>('/flow-values-reports/', ctx, { method: 'POST', body })
  const results = payload.data?.attributes?.results ?? []

  return new Map(
    results.map(row => [
      row.groupings?.flow_id ?? row.groupings?.send_channel ?? 'sconosciuto',
      row.statistics ?? {},
    ]),
  )
}
