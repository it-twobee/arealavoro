/**
 * §316 — Reporting: la parte pura. Definizioni per archetipo (JSON importati
 * staticamente: build `standalone`, niente disco), periodo, congelamento della
 * definizione dentro il run e lettura del run in forma pronta per la UI.
 * Le chiamate GA4/Klaviyo/Meta e il DB stanno altrove: qui niente server-side.
 */

import type { TrackingReportRow, TrackingReportRun } from '@/lib/types/database'
import { ARCHETYPE_VALUES, archetypeByValue, type Archetype, type ReportSource } from '@/lib/tracking/vocab'
import { TrackingError } from '@/lib/tracking/errors'
import ecommerce from './definitions/ecommerce.json'
import leadgenB2b from './definitions/leadgen-b2b.json'
import hospitality from './definitions/hospitality.json'

/* ---------- tipi ---------- */

export type Ga4Totals = { metrics: string[] }
export type Ga4Funnel = {
  id: string
  title?: string
  dimensions: string[]
  dimensionLabel?: string
  step1Label?: string
  step2Label?: string
  limit?: number
}
export type Ga4Breakdown = {
  id: string
  title?: string
  dimensions: string[]
  metrics: string[]
  orderBy?: string
  limit?: number
}
export type Ga4EventParameter = {
  id: string
  title?: string
  eventName?: string
  dimension: string
  metrics?: string[]
  limit?: number
}
export type Ga4Definition = {
  totals: Ga4Totals
  funnels?: Ga4Funnel[]
  breakdowns?: Ga4Breakdown[]
  eventParameters?: Ga4EventParameter[]
}
export type ReportDefinition = {
  archetype: string
  title: string
  version?: number
  note?: string
  ga4: Ga4Definition
}

export type DefinitionSummary = {
  archetype: Archetype
  title: string
  version: number
  note: string
  totalsMetrics: number
  breakdowns: FrozenBreakdown[]
}

/** Sezione così come viene congelata nel run: solo ciò che serve a rileggerlo. */
export type FrozenBreakdown = { id: string; title: string; dimensions: string[]; metrics: string[] }

/**
 * Definizione congelata dentro `report_runs.definition`. `breakdowns` è comune a
 * tutte le fonti; `ga4` resta per compatibilità con i run già salvati.
 */
export type FrozenDefinition = {
  title: string
  version: number | null
  breakdowns: FrozenBreakdown[]
  ga4?: Ga4Definition
  note?: string
}

/** Ciò che `freezeDefinition` accetta: una definizione GA4, una fissa (Klaviyo/Meta) o un congelato. */
export type FreezableDefinition = {
  title: string
  version?: number | null
  note?: string
  breakdowns?: FrozenBreakdown[]
  ga4?: Ga4Definition
}

export type ReportPeriod = { start: string; end: string; compareStart: string; compareEnd: string }
export type ShapedPeriod = { start: string; end: string; compareStart: string | null; compareEnd: string | null }

/** Riga di una query (GA4 o altra fonte), prima di essere attribuita a periodo e blocco. */
export type QueryRow = { dimensions: Record<string, string>; metrics: Record<string, number> }

/** Riga pronta per `report_rows`, senza id e run_id. */
export type CollectedRow = Omit<TrackingReportRow, 'id' | 'run_id'>

/** Parametri della query GA4 derivati da una sezione della definizione. */
export type Ga4Query = {
  metrics: string[]
  dimensions?: string[]
  eventName?: string | null
  orderBy?: string
  limit: number
}

export type SkippedSection = { id: string; title: string; reason: string }

export type ShapedTotal = { metric: string; current: number; previous: number; variation: number | null }
export type ShapedBreakdownRow = {
  key: string
  dimensions: Record<string, string>
  metrics: Record<string, number>
  previous: Record<string, number> | null
}
export type ShapedBreakdown = {
  id: string
  title: string
  dimensions: string[]
  metrics: string[]
  rows: ShapedBreakdownRow[]
}
export type ShapedReport = {
  id: string
  source: ReportSource
  definition: string
  definitionVersion: number | null
  period: ShapedPeriod
  ok: boolean
  error: string | null
  createdAt: string
  durationMs: number | null
  totals: ShapedTotal[]
  breakdowns: ShapedBreakdown[]
}

/* ---------- costanti ---------- */

/** Convenzione GA4 per l'evento di lead, se il cliente non ne ha uno diverso. */
export const DEFAULT_LEAD_EVENT = 'generate_lead'

/** Colonne calcolate del funnel: italiano in snake_case, come Klaviyo. */
export const FUNNEL_METRICS = [
  'utenti_visita',
  'utenti_lead',
  'percentuale_completamento',
  'abbandoni',
  'tasso_abbandono',
] as const

export const EVENT_PARAMETER_DEFAULT_METRICS = ['eventCount', 'activeUsers'] as const

/** Definizione del report Klaviyo: fissa, non dipende dall'archetipo. */
export const KLAVIYO_DEFINITION: FrozenDefinition = Object.freeze({
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
})

export const META_DEFINITION: FrozenDefinition = Object.freeze({
  title: 'Meta Ads — 30 giorni',
  version: 1,
  breakdowns: [
    {
      id: 'azioni',
      title: "Azioni registrate sull'account",
      dimensions: ['azione'],
      metrics: ['conteggio', 'costo_per_azione'],
    },
  ],
})

/* ---------- definizioni ---------- */

/** Chiave = valore dell'archetipo, cioè il nome del file in ./definitions. */
const RAW_DEFINITIONS: Record<string, unknown> = {
  ecommerce,
  'leadgen-b2b': leadgenB2b,
  hospitality,
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const optString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const optNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** Sezione facoltativa: assente → vuota; presente ma non array → errore parlante. */
function optList(file: string, key: string, v: unknown): unknown[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Error(`${file}: ga4.${key} deve essere un array`)
  return v
}

const withOptional = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/** Stesse regole e messaggi dell'originale: intercetta prima di chiamare Google. */
export function validateDefinition(file: string, def: unknown): ReportDefinition {
  if (!isRecord(def) || typeof def.title !== 'string') throw new Error(`${file}: manca "title"`)
  const ga4 = isRecord(def.ga4) ? def.ga4 : undefined
  const totals = ga4 && isRecord(ga4.totals) ? ga4.totals : undefined
  if (!ga4 || !totals || !isStringArray(totals.metrics) || totals.metrics.length === 0) {
    throw new Error(`${file}: ga4.totals.metrics deve elencare almeno una metrica`)
  }

  const funnels: Ga4Funnel[] = optList(file, 'funnels', ga4.funnels).map(funnel => {
    if (!isRecord(funnel) || typeof funnel.id !== 'string' || !funnel.id) throw new Error(`${file}: funnel senza id`)
    if (!isStringArray(funnel.dimensions) || funnel.dimensions.length === 0) {
      throw new Error(`${file}: funnel "${funnel.id}" senza dimensioni`)
    }
    return withOptional({
      id: funnel.id,
      title: optString(funnel.title),
      dimensions: funnel.dimensions,
      dimensionLabel: optString(funnel.dimensionLabel),
      step1Label: optString(funnel.step1Label),
      step2Label: optString(funnel.step2Label),
      limit: optNumber(funnel.limit),
    })
  })

  const eventParameters: Ga4EventParameter[] = optList(file, 'eventParameters', ga4.eventParameters).map(param => {
    if (!isRecord(param) || typeof param.id !== 'string' || !param.id || typeof param.dimension !== 'string' || !param.dimension) {
      throw new Error(`${file}: parametro evento senza id o dimension`)
    }
    return withOptional({
      id: param.id,
      title: optString(param.title),
      eventName: optString(param.eventName),
      dimension: param.dimension,
      metrics: isStringArray(param.metrics) ? param.metrics : undefined,
      limit: optNumber(param.limit),
    })
  })

  const seen = new Set<string>()
  const breakdowns: Ga4Breakdown[] = optList(file, 'breakdowns', ga4.breakdowns).map(breakdown => {
    if (!isRecord(breakdown) || typeof breakdown.id !== 'string' || !breakdown.id) throw new Error(`${file}: breakdown senza id`)
    if (seen.has(breakdown.id)) throw new Error(`${file}: id breakdown duplicato "${breakdown.id}"`)
    seen.add(breakdown.id)

    if (!isStringArray(breakdown.dimensions) || breakdown.dimensions.length === 0) {
      throw new Error(`${file}: breakdown "${breakdown.id}" senza dimensioni`)
    }
    if (!isStringArray(breakdown.metrics) || breakdown.metrics.length === 0) {
      throw new Error(`${file}: breakdown "${breakdown.id}" senza metriche`)
    }
    const orderBy = optString(breakdown.orderBy)
    if (orderBy && !breakdown.metrics.includes(orderBy)) {
      // GA4 rifiuta un orderBy su una metrica non richiesta: meglio dirlo qui.
      throw new Error(
        `${file}: breakdown "${breakdown.id}" ordina per "${orderBy}", che non è tra le sue metriche`,
      )
    }
    return withOptional({
      id: breakdown.id,
      title: optString(breakdown.title),
      dimensions: breakdown.dimensions,
      metrics: breakdown.metrics,
      orderBy,
      limit: optNumber(breakdown.limit),
    })
  })

  return withOptional({
    archetype: typeof def.archetype === 'string' ? def.archetype : '',
    title: def.title,
    version: optNumber(def.version),
    note: optString(def.note),
    ga4: withOptional({
      totals: { metrics: totals.metrics },
      funnels: funnels.length ? funnels : undefined,
      breakdowns: breakdowns.length ? breakdowns : undefined,
      eventParameters: eventParameters.length ? eventParameters : undefined,
    }),
  })
}

/** Validazione pigra e memoizzata: un JSON rotto si scopre al primo uso, una volta sola. */
const cache = new Map<string, ReportDefinition>()

/** Definizione di un archetipo, o null se l'archetipo non è assegnato/noto. */
export function definitionFor(archetype: string | null | undefined): ReportDefinition | null {
  const meta = archetypeByValue(archetype)
  if (!meta) return null

  const cached = cache.get(meta.value)
  if (cached) return cached

  const file = `${meta.value}.json`
  const raw = RAW_DEFINITIONS[meta.value]
  if (raw === undefined) throw new TrackingError(500, `Definizione report mancante per ${archetype}: ${file}`)

  let def: ReportDefinition
  try {
    def = validateDefinition(file, raw)
  } catch (err) {
    throw new TrackingError(500, `Definizione report non valida: ${err instanceof Error ? err.message : String(err)}`)
  }

  cache.set(meta.value, def)
  return def
}

export function listDefinitions(): DefinitionSummary[] {
  return ARCHETYPE_VALUES.map(archetype => {
    const def = definitionFor(archetype)
    if (!def) throw new TrackingError(500, `Definizione report mancante per ${archetype}`)
    return {
      archetype,
      title: def.title,
      version: def.version ?? 1,
      note: def.note ?? '',
      totalsMetrics: def.ga4.totals.metrics.length,
      breakdowns: (def.ga4.breakdowns ?? []).map(b => ({
        id: b.id,
        title: b.title ?? b.id,
        dimensions: b.dimensions,
        metrics: b.metrics,
      })),
    }
  })
}

/* ---------- periodo ---------- */

const isoDate = (date: Date) => date.toISOString().slice(0, 10)

/**
 * Ultimi 30 giorni con confronto sui 30 precedenti. La finestra chiude *ieri*:
 * il giorno in corso in GA4 è incompleto e farebbe sembrare ogni report in calo.
 * Le date sono in UTC: conta l'istante di `reference`, non il fuso locale.
 */
export function periodLast30(reference: Date = new Date()): ReportPeriod {
  const end = new Date(reference)
  end.setUTCDate(end.getUTCDate() - 1)

  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 29)

  const compareEnd = new Date(start)
  compareEnd.setUTCDate(compareEnd.getUTCDate() - 1)

  const compareStart = new Date(compareEnd)
  compareStart.setUTCDate(compareStart.getUTCDate() - 29)

  return {
    start: isoDate(start),
    end: isoDate(end),
    compareStart: isoDate(compareStart),
    compareEnd: isoDate(compareEnd),
  }
}

/* ---------- helper puri per i runner ---------- */

/** Chiave di confronto fra periodi: i valori delle dimensioni, in ordine. */
export const dimensionKey = (dimensions: Record<string, string>): string => Object.values(dimensions).join(' | ')

/** Totali del periodo: la prima riga, o tutte le metriche a zero se GA4 non ha dati. */
export function totalsMetrics(rows: QueryRow[], metrics: readonly string[]): Record<string, number> {
  return rows[0]?.metrics ?? Object.fromEntries(metrics.map(m => [m, 0]))
}

/** Query GA4 di un funnel: la stessa per i due passaggi, il secondo filtrato sull'evento di lead. */
export function funnelQuery(funnel: Ga4Funnel): Ga4Query {
  return {
    metrics: ['activeUsers'],
    dimensions: funnel.dimensions,
    orderBy: 'activeUsers',
    limit: funnel.limit ?? 20,
  }
}

export function breakdownQuery(breakdown: Ga4Breakdown): Ga4Query {
  return {
    metrics: breakdown.metrics,
    dimensions: breakdown.dimensions,
    orderBy: breakdown.orderBy ?? breakdown.metrics[0],
    limit: breakdown.limit ?? 20,
  }
}

export function eventParameterQuery(param: Ga4EventParameter): Ga4Query {
  const metrics = param.metrics ?? [...EVENT_PARAMETER_DEFAULT_METRICS]
  return {
    metrics,
    dimensions: [param.dimension],
    eventName: param.eventName ?? null,
    orderBy: metrics[0],
    limit: param.limit ?? 20,
  }
}

/**
 * Funnel calcolato da due query (visite e visite con l'evento di lead): la
 * Data API v1beta non espone un endpoint funnel, le colonne le deriviamo qui.
 */
export function deriveFunnel(visite: QueryRow[], lead: QueryRow[]): QueryRow[] {
  const leadPerChiave = new Map(lead.map(r => [dimensionKey(r.dimensions), r.metrics.activeUsers ?? 0]))

  return visite.map(row => {
    const step1 = row.metrics.activeUsers ?? 0
    const step2 = leadPerChiave.get(dimensionKey(row.dimensions)) ?? 0
    return {
      dimensions: row.dimensions,
      metrics: {
        utenti_visita: step1,
        utenti_lead: step2,
        percentuale_completamento: step1 ? step2 / step1 : 0,
        abbandoni: Math.max(step1 - step2, 0),
        tasso_abbandono: step1 ? Math.max(step1 - step2, 0) / step1 : 0,
      },
    }
  })
}

/**
 * I parametri custom dipendono dal GTM del cliente: se la dimensione non è
 * registrata sulla property, la sezione si salta con il motivo, senza affondare
 * il report. Da registrare solo per il periodo corrente.
 */
export const skippedEmpty = (param: Ga4EventParameter): SkippedSection => ({
  id: param.id,
  title: param.title ?? param.id,
  reason: 'Nessun dato nel periodo',
})
export const skippedUnavailable = (param: Ga4EventParameter, message: string): SkippedSection => ({
  id: param.id,
  title: param.title ?? param.id,
  reason: `${param.dimension} non disponibile su questa property: ${message}`,
})

/**
 * Sezioni ordinate di un report GA4 con i nomi di colonna per le intestazioni.
 * Funnel e parametri custom sono descritti come i breakdown normali, così la
 * resa è la stessa.
 */
export function ga4Sections(def: ReportDefinition, leadEvent: string): FrozenBreakdown[] {
  const funnels = (def.ga4.funnels ?? []).map(f => ({
    id: f.id,
    title: `${f.title ?? f.id} · ${f.step1Label ?? 'Passaggio 1'} → ${f.step2Label ?? 'Passaggio 2'} (${leadEvent})`,
    dimensions: f.dimensions,
    metrics: [...FUNNEL_METRICS],
  }))

  const breakdowns = (def.ga4.breakdowns ?? []).map(b => ({
    id: b.id,
    title: b.title ?? b.id,
    dimensions: b.dimensions,
    metrics: b.metrics,
  }))

  const parameters = (def.ga4.eventParameters ?? []).map(p => ({
    id: p.id,
    title: p.title ?? p.id,
    dimensions: [p.dimension],
    metrics: p.metrics ?? [...EVENT_PARAMETER_DEFAULT_METRICS],
  }))

  return [...funnels, ...breakdowns, ...parameters]
}

/**
 * Definizione da congelare nel run: si salva ciò che si è usato, non solo il
 * titolo, perché i file cambiano e un report vecchio deve restare leggibile.
 */
export function freezeDefinition(def: FreezableDefinition): FrozenDefinition {
  return {
    title: def.title,
    version: def.version ?? 1,
    breakdowns:
      def.breakdowns ??
      (def.ga4?.breakdowns ?? []).map(b => ({
        id: b.id,
        title: b.title ?? b.id,
        dimensions: b.dimensions,
        metrics: b.metrics,
      })),
    ...(def.ga4 ? { ga4: def.ga4 } : {}),
    ...(def.note ? { note: def.note } : {}),
  }
}

/** Snapshot di un run GA4 riuscito: descrive ogni sezione prodotta, funnel e parametri compresi. */
export function ga4Snapshot(def: ReportDefinition, leadEvent: string): FrozenDefinition {
  return freezeDefinition({ title: def.title, version: def.version, breakdowns: ga4Sections(def, leadEvent) })
}

/* ---------- Klaviyo: traduzione nello schema comune ---------- */

export type KlaviyoFlowStats = {
  recipients?: unknown
  opens?: unknown
  open_rate?: unknown
  clicks?: unknown
  click_rate?: unknown
  conversion_value?: unknown
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** Traduce le statistiche di Klaviyo nei nomi usati dallo schema comune. */
export function klaviyoMetrics(stats: KlaviyoFlowStats = {}): Record<string, number> {
  return {
    destinatari: num(stats.recipients),
    aperture: num(stats.opens),
    // Klaviyo restituisce i tassi come frazione 0..1, come GA4: si mantiene.
    tasso_apertura: num(stats.open_rate),
    click: num(stats.clicks),
    tasso_click: num(stats.click_rate),
    ricavi: num(stats.conversion_value),
  }
}

/** Somma i flussi per ottenere i totali del periodo. */
export function sumFlows(rows: QueryRow[]): Record<string, number> {
  const totale: Record<string, number> = { flussi_attivi: rows.length, destinatari: 0, aperture: 0, click: 0, ricavi: 0 }
  for (const row of rows) {
    totale.destinatari += row.metrics.destinatari ?? 0
    totale.aperture += row.metrics.aperture ?? 0
    totale.click += row.metrics.click ?? 0
    totale.ricavi += row.metrics.ricavi ?? 0
  }
  // I tassi complessivi si ricalcolano sui totali: la media dei tassi dei singoli
  // flussi darebbe lo stesso peso a un flusso da 10 invii e a uno da 10.000.
  totale.tasso_apertura = totale.destinatari ? totale.aperture / totale.destinatari : 0
  totale.tasso_click = totale.destinatari ? totale.click / totale.destinatari : 0
  return totale
}

/* ---------- lettura ---------- */

/** Breakdown congelato, o null se manca un campo: le vecchie voci senza titolo prendono l'id. */
function frozenBreakdown(v: unknown): FrozenBreakdown | null {
  if (!isRecord(v) || typeof v.id !== 'string' || !isStringArray(v.dimensions) || !isStringArray(v.metrics)) return null
  return { id: v.id, title: typeof v.title === 'string' ? v.title : v.id, dimensions: v.dimensions, metrics: v.metrics }
}

/** Blocco `ga4` dei run già salvati: serve solo a ritrovare i breakdown, non si rivalida. */
function looseGa4(v: Record<string, unknown>): Ga4Definition {
  const totals = isRecord(v.totals) && isStringArray(v.totals.metrics) ? v.totals.metrics : []
  const list: unknown[] = Array.isArray(v.breakdowns) ? v.breakdowns : []
  const breakdowns = list.map(frozenBreakdown).filter((b): b is FrozenBreakdown => b !== null)
  return { totals: { metrics: totals }, ...(breakdowns.length ? { breakdowns } : {}) }
}

/**
 * La definizione congelata nel run. Tollera i run più vecchi (colonna con il
 * solo titolo come testo) e i breakdown con titolo mancante.
 * Il riconoscimento è su `title`, non su `ga4`: le fonti sono più di una.
 */
export function storedDefinition(raw: unknown): FrozenDefinition {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null // testo semplice: si usa così com'è
    }
  }
  if (isRecord(parsed) && typeof parsed.title === 'string') {
    const list: unknown[] = Array.isArray(parsed.breakdowns) ? parsed.breakdowns : []
    const breakdowns = list.map(frozenBreakdown).filter((b): b is FrozenBreakdown => b !== null)
    return {
      title: parsed.title,
      version: typeof parsed.version === 'number' ? parsed.version : null,
      breakdowns,
      ...(isRecord(parsed.ga4) ? { ga4: looseGa4(parsed.ga4) } : {}),
      ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
    }
  }
  return { title: String(raw ?? ''), version: null, breakdowns: [] }
}

/** Variazione percentuale con un decimale; null = da zero, la percentuale non ha senso. */
export function variation(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

const hasBreakdown = (r: TrackingReportRow): r is TrackingReportRow & { breakdown: string } =>
  r.scope === 'breakdown' && typeof r.breakdown === 'string'

/** Report completo, con totali confrontati e breakdown pronti per la UI (la parte pura di getReport). */
export function shapeReport(run: TrackingReportRun, rowsIn: TrackingReportRow[]): ShapedReport {
  // L'ordine delle sezioni è quello di inserimento: si ricostruisce dall'id.
  const rows = [...rowsIn].sort((a, b) => a.id - b.id)

  const totalsCurrent = rows.find(r => r.scope === 'total' && r.period === 'current')?.metrics ?? {}
  const totalsPrevious = rows.find(r => r.scope === 'total' && r.period === 'previous')?.metrics ?? {}

  const totals: ShapedTotal[] = Object.keys(totalsCurrent).map(metric => ({
    metric,
    current: totalsCurrent[metric],
    previous: totalsPrevious[metric] ?? 0,
    variation: variation(totalsCurrent[metric], totalsPrevious[metric] ?? 0),
  }))

  const breakdownRows = rows.filter(hasBreakdown)
  const breakdownIds = Array.from(new Set(breakdownRows.map(r => r.breakdown)))
  const definition = storedDefinition(run.definition)

  const breakdowns: ShapedBreakdown[] = breakdownIds.map(id => {
    const spec = definition.breakdowns.find(b => b.id === id) ?? definition.ga4?.breakdowns?.find(b => b.id === id)
    const current = breakdownRows.filter(r => r.breakdown === id && r.period === 'current')
    const previous = breakdownRows.filter(r => r.breakdown === id && r.period === 'previous')

    // Confronto riga per riga sulla chiave delle dimensioni: un canale presente
    // solo in un periodo compare comunque, con l'altro a zero.
    const previousByKey = new Map(previous.map(r => [dimensionKey(r.dimensions), r.metrics]))

    return {
      id,
      title: spec?.title ?? id,
      dimensions: spec?.dimensions ?? Object.keys(current[0]?.dimensions ?? {}),
      metrics: spec?.metrics ?? Object.keys(current[0]?.metrics ?? {}),
      rows: current.map(row => ({
        key: dimensionKey(row.dimensions),
        dimensions: row.dimensions,
        metrics: row.metrics,
        previous: previousByKey.get(dimensionKey(row.dimensions)) ?? null,
      })),
    }
  })

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
  }
}
