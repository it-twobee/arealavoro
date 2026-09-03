/* Verifica della parte pura del reporting. Esegui: npx tsx lib/tracking/reporting.check.ts */
import type { TrackingReportRow, TrackingReportRun } from '@/lib/types/database'
import {
  DEFAULT_LEAD_EVENT, KLAVIYO_DEFINITION, META_DEFINITION, FUNNEL_METRICS,
  definitionFor, listDefinitions, validateDefinition, periodLast30, variation,
  freezeDefinition, ga4Sections, ga4Snapshot, storedDefinition, shapeReport,
  deriveFunnel, totalsMetrics, breakdownQuery, eventParameterQuery, funnelQuery,
  klaviyoMetrics, sumFlows, skippedEmpty, skippedUnavailable, dimensionKey,
} from '@/lib/tracking/reporting'

let fail = 0
const is = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'OK ' : 'NO '} ${label.padEnd(58)} ${JSON.stringify(got)}${ok ? '' : `  atteso ${JSON.stringify(want)}`}`)
}
const throwsWith = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/* ---------- periodo ---------- */
is('periodLast30: finestra chiude ieri (UTC)', periodLast30(new Date('2026-03-15T10:00:00Z')), {
  start: '2026-02-13', end: '2026-03-14', compareStart: '2026-01-14', compareEnd: '2026-02-12',
})
is('periodLast30: conta l\'istante UTC del riferimento', periodLast30(new Date('2026-03-15T00:30:00+02:00')).end, '2026-03-13')
is('periodLast30: 30 giorni per finestra', (() => {
  const p = periodLast30(new Date('2026-08-01T12:00:00Z'))
  const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000 + 1
  return [days(p.start, p.end), days(p.compareStart, p.compareEnd)]
})(), [30, 30])
is('periodLast30: default = oggi, end è ieri', periodLast30().end < new Date().toISOString().slice(0, 10), true)

/* ---------- variazione ---------- */
is('variation: +50%', variation(150, 100), 50)
is('variation: -25%', variation(75, 100), -25)
is('variation: un decimale', variation(1234, 1000), 23.4)
is('variation: arrotondamento .05', variation(1005, 1000), 0.5)
is('variation: previous 0, current > 0 → null', variation(10, 0), null)
is('variation: previous 0, current 0 → 0', variation(0, 0), 0)
is('variation: current 0 → -100', variation(0, 40), -100)

/* ---------- definizioni ---------- */
is('tre definizioni', listDefinitions().map(d => d.archetype), ['ecommerce', 'leadgen-b2b', 'hospitality'])
is('versioni', listDefinitions().map(d => d.version), [1, 2, 1])
is('totali per archetipo', listDefinitions().map(d => d.totalsMetrics), [10, 7, 8])
is('breakdown per archetipo', listDefinitions().map(d => d.breakdowns.map(b => b.id)), [
  ['canale', 'prodotti', 'dispositivo'],
  ['sorgenti', 'eventi', 'pagine'],
  ['canale', 'eventi', 'paese', 'lingua'],
])
is('archetipo null → null', definitionFor(null), null)
is('archetipo ignoto → null', definitionFor('boh'), null)
is('memoizzato: stessa istanza', definitionFor('ecommerce') === definitionFor('ecommerce'), true)

const leadgen = definitionFor('leadgen-b2b')
if (!leadgen) throw new Error('definizione leadgen assente')
is('leadgen: un funnel, due parametri evento', [leadgen.ga4.funnels?.length, leadgen.ga4.eventParameters?.length], [1, 2])
is('leadgen: campi facoltativi assenti non compaiono', 'orderBy' in (leadgen.ga4.funnels?.[0] ?? {}), false)
is('DEFAULT_LEAD_EVENT', DEFAULT_LEAD_EVENT, 'generate_lead')

const base = { title: 'T', ga4: { totals: { metrics: ['sessions'] } } }
is('validateDefinition: orderBy su metrica non richiesta',
  throwsWith(() => validateDefinition('x.json', {
    ...base, ga4: { ...base.ga4, breakdowns: [{ id: 'b', dimensions: ['d'], metrics: ['sessions'], orderBy: 'totalUsers' }] },
  })),
  'x.json: breakdown "b" ordina per "totalUsers", che non è tra le sue metriche')
is('validateDefinition: totals vuoti', throwsWith(() => validateDefinition('x.json', { title: 'T', ga4: { totals: { metrics: [] } } })),
  'x.json: ga4.totals.metrics deve elencare almeno una metrica')
is('validateDefinition: breakdown duplicato', throwsWith(() => validateDefinition('x.json', {
  ...base, ga4: { ...base.ga4, breakdowns: [
    { id: 'b', dimensions: ['d'], metrics: ['m'] }, { id: 'b', dimensions: ['d'], metrics: ['m'] },
  ] },
})), 'x.json: id breakdown duplicato "b"')
is('validateDefinition: breakdown senza dimensioni', throwsWith(() => validateDefinition('x.json', {
  ...base, ga4: { ...base.ga4, breakdowns: [{ id: 'b', dimensions: [], metrics: ['m'] }] },
})), 'x.json: breakdown "b" senza dimensioni')
is('validateDefinition: funnel senza id', throwsWith(() => validateDefinition('x.json', {
  ...base, ga4: { ...base.ga4, funnels: [{ dimensions: ['d'] }] },
})), 'x.json: funnel senza id')
is('validateDefinition: parametro senza dimension', throwsWith(() => validateDefinition('x.json', {
  ...base, ga4: { ...base.ga4, eventParameters: [{ id: 'p' }] },
})), 'x.json: parametro evento senza id o dimension')
is('validateDefinition: valida → oggetto normalizzato', validateDefinition('x.json', base),
  { archetype: '', title: 'T', ga4: { totals: { metrics: ['sessions'] } } })

/* ---------- helper per i runner ---------- */
is('dimensionKey', dimensionKey({ a: 'x', b: 'y' }), 'x | y')
is('totalsMetrics: prima riga', totalsMetrics([{ dimensions: {}, metrics: { sessions: 5 } }], ['sessions']), { sessions: 5 })
is('totalsMetrics: nessuna riga → zeri', totalsMetrics([], ['sessions', 'totalUsers']), { sessions: 0, totalUsers: 0 })
is('funnelQuery', funnelQuery({ id: 'f', dimensions: ['ch'] }), { metrics: ['activeUsers'], dimensions: ['ch'], orderBy: 'activeUsers', limit: 20 })
is('breakdownQuery: default orderBy = prima metrica, limit 20',
  breakdownQuery({ id: 'b', dimensions: ['d'], metrics: ['m1', 'm2'] }), { metrics: ['m1', 'm2'], dimensions: ['d'], orderBy: 'm1', limit: 20 })
is('breakdownQuery: orderBy e limit espliciti',
  breakdownQuery({ id: 'b', dimensions: ['d'], metrics: ['m1', 'm2'], orderBy: 'm2', limit: 5 }), { metrics: ['m1', 'm2'], dimensions: ['d'], orderBy: 'm2', limit: 5 })
is('eventParameterQuery: default',
  eventParameterQuery({ id: 'p', dimension: 'customEvent:x' }),
  { metrics: ['eventCount', 'activeUsers'], dimensions: ['customEvent:x'], eventName: null, orderBy: 'eventCount', limit: 20 })
is('eventParameterQuery: con eventName',
  eventParameterQuery({ id: 'p', dimension: 'customEvent:x', eventName: 'click', metrics: ['activeUsers'], limit: 3 }),
  { metrics: ['activeUsers'], dimensions: ['customEvent:x'], eventName: 'click', orderBy: 'activeUsers', limit: 3 })

const funnel = deriveFunnel(
  [{ dimensions: { ch: 'Organic' }, metrics: { activeUsers: 200 } }, { dimensions: { ch: 'Paid' }, metrics: { activeUsers: 50 } }, { dimensions: { ch: 'Vuoto' }, metrics: {} }],
  [{ dimensions: { ch: 'Organic' }, metrics: { activeUsers: 20 } }, { dimensions: { ch: 'Altro' }, metrics: { activeUsers: 5 } }],
)
is('deriveFunnel: una riga per visita, lead abbinato per chiave', funnel.map(r => r.dimensions.ch), ['Organic', 'Paid', 'Vuoto'])
is('deriveFunnel: Organic 200→20', funnel[0].metrics, { utenti_visita: 200, utenti_lead: 20, percentuale_completamento: 0.1, abbandoni: 180, tasso_abbandono: 0.9 })
is('deriveFunnel: Paid senza lead', funnel[1].metrics, { utenti_visita: 50, utenti_lead: 0, percentuale_completamento: 0, abbandoni: 50, tasso_abbandono: 1 })
is('deriveFunnel: zero visite → tutto zero', funnel[2].metrics, { utenti_visita: 0, utenti_lead: 0, percentuale_completamento: 0, abbandoni: 0, tasso_abbandono: 0 })
is('deriveFunnel: colonne = FUNNEL_METRICS', Object.keys(funnel[0].metrics), [...FUNNEL_METRICS])

is('skippedEmpty', skippedEmpty({ id: 'p', title: 'Piano', dimension: 'customEvent:p' }), { id: 'p', title: 'Piano', reason: 'Nessun dato nel periodo' })
is('skippedUnavailable', skippedUnavailable({ id: 'p', dimension: 'customEvent:p' }, 'boom'),
  { id: 'p', title: 'p', reason: 'customEvent:p non disponibile su questa property: boom' })

/* ---------- congelamento ---------- */
const sections = ga4Sections(leadgen, 'lead_custom')
is('ga4Sections: ordine funnel, breakdown, parametri', sections.map(s => s.id),
  ['funnel', 'sorgenti', 'eventi', 'pagine', 'piano-selezionato', 'linkedin-target'])
is('ga4Sections: titolo funnel con evento', sections[0].title, '1. Funnel di conversione · Visita sito → Lead generato (lead_custom)')
is('ga4Sections: metriche funnel', sections[0].metrics, [...FUNNEL_METRICS])
is('ga4Sections: parametro → dimensione singola', sections[4].dimensions, ['customEvent:piano_selezionato'])

const snap = ga4Snapshot(leadgen, DEFAULT_LEAD_EVENT)
is('ga4Snapshot: niente blocco ga4, versione 2', [snap.version, 'ga4' in snap, snap.breakdowns.length], [2, false, 6])
is('freezeDefinition: Klaviyo', freezeDefinition(KLAVIYO_DEFINITION), KLAVIYO_DEFINITION)
is('freezeDefinition: Meta', freezeDefinition(META_DEFINITION), META_DEFINITION)
const ecommerceDef = definitionFor('ecommerce')
if (!ecommerceDef) throw new Error('definizione ecommerce assente')
const frozenFailed = freezeDefinition(ecommerceDef)
is('freezeDefinition: da definizione GA4 (run fallito) porta ga4 e breakdown', [frozenFailed.breakdowns.map(b => b.id), 'ga4' in frozenFailed, frozenFailed.version],
  [['canale', 'prodotti', 'dispositivo'], true, 1])
is('freezeDefinition: versione assente → 1', freezeDefinition({ title: 'X' }).version, 1)

is('storedDefinition: oggetto congelato', storedDefinition({ title: 'T', version: 3, breakdowns: [{ id: 'a', dimensions: ['d'], metrics: ['m'] }] }),
  { title: 'T', version: 3, breakdowns: [{ id: 'a', title: 'a', dimensions: ['d'], metrics: ['m'] }] })
is('storedDefinition: stringa JSON', storedDefinition('{"title":"T","version":1,"breakdowns":[]}'), { title: 'T', version: 1, breakdowns: [] })
is('storedDefinition: testo semplice (run vecchio)', storedDefinition('Solo titolo'), { title: 'Solo titolo', version: null, breakdowns: [] })
is('storedDefinition: solo ga4 (run vecchio)', storedDefinition({ title: 'T', ga4: { totals: { metrics: ['s'] }, breakdowns: [{ id: 'c', title: 'C', dimensions: ['d'], metrics: ['s'] }] } }).ga4?.breakdowns?.[0].id, 'c')

/* ---------- Klaviyo ---------- */
is('klaviyoMetrics: numeri e stringhe, mancanti a 0', klaviyoMetrics({ recipients: '100', opens: 40, open_rate: 0.4, clicks: null, click_rate: undefined, conversion_value: 'x' }),
  { destinatari: 100, aperture: 40, tasso_apertura: 0.4, click: 0, tasso_click: 0, ricavi: 0 })
is('sumFlows: tassi sui totali', sumFlows([
  { dimensions: { flusso: 'A' }, metrics: klaviyoMetrics({ recipients: 10, opens: 5, open_rate: 0.5, clicks: 1, click_rate: 0.1, conversion_value: 10 }) },
  { dimensions: { flusso: 'B' }, metrics: klaviyoMetrics({ recipients: 990, opens: 99, open_rate: 0.1, clicks: 9, click_rate: 0.009, conversion_value: 90 }) },
]), { flussi_attivi: 2, destinatari: 1000, aperture: 104, click: 10, ricavi: 100, tasso_apertura: 0.104, tasso_click: 0.01 })
is('sumFlows: vuoto', sumFlows([]), { flussi_attivi: 0, destinatari: 0, aperture: 0, click: 0, ricavi: 0, tasso_apertura: 0, tasso_click: 0 })

/* ---------- shapeReport ---------- */
const run: TrackingReportRun = {
  id: 'run-1', client_id: 'c-1', source: 'ga4',
  definition: { title: 'E-commerce — panoramica 30 giorni', version: 1, breakdowns: [
    { id: 'canale', title: 'Per canale', dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions', 'purchaseRevenue'] },
  ] },
  definition_ver: 1, period_start: '2026-02-13', period_end: '2026-03-14', compare_start: '2026-01-14', compare_end: '2026-02-12',
  ok: true, error: null, row_count: 6, duration_ms: 1234, created_at: '2026-03-15T08:00:00Z', created_by: null,
}
const row = (id: number, period: TrackingReportRow['period'], scope: TrackingReportRow['scope'], breakdown: string | null, dimensions: Record<string, string>, metrics: Record<string, number>): TrackingReportRow =>
  ({ id, run_id: 'run-1', period, scope, breakdown, dimensions, metrics })
const rows: TrackingReportRow[] = [
  row(1, 'current', 'total', null, {}, { sessions: 1200, purchaseRevenue: 500, newMetric: 3 }),
  row(2, 'previous', 'total', null, {}, { sessions: 1000, purchaseRevenue: 0 }),
  row(3, 'current', 'breakdown', 'canale', { sessionDefaultChannelGroup: 'Organic Search' }, { sessions: 700, purchaseRevenue: 300 }),
  row(4, 'current', 'breakdown', 'canale', { sessionDefaultChannelGroup: 'Paid Social' }, { sessions: 500, purchaseRevenue: 200 }),
  row(5, 'previous', 'breakdown', 'canale', { sessionDefaultChannelGroup: 'Organic Search' }, { sessions: 650, purchaseRevenue: 0 }),
  row(6, 'previous', 'breakdown', 'canale', { sessionDefaultChannelGroup: 'Direct' }, { sessions: 350, purchaseRevenue: 0 }),
]
const shaped = shapeReport(run, [...rows].reverse())
is('shapeReport: testata', [shaped.id, shaped.source, shaped.definition, shaped.definitionVersion, shaped.ok, shaped.error, shaped.createdAt, shaped.durationMs],
  ['run-1', 'ga4', 'E-commerce — panoramica 30 giorni', 1, true, null, '2026-03-15T08:00:00Z', 1234])
is('shapeReport: periodo', shaped.period, { start: '2026-02-13', end: '2026-03-14', compareStart: '2026-01-14', compareEnd: '2026-02-12' })
is('shapeReport: totali con variazione (previous 0 → null, assente → 0)', shaped.totals, [
  { metric: 'sessions', current: 1200, previous: 1000, variation: 20 },
  { metric: 'purchaseRevenue', current: 500, previous: 0, variation: null },
  { metric: 'newMetric', current: 3, previous: 0, variation: null },
])
is('shapeReport: un breakdown, titolo e colonne dallo snapshot', [shaped.breakdowns.length, shaped.breakdowns[0].title, shaped.breakdowns[0].dimensions, shaped.breakdowns[0].metrics],
  [1, 'Per canale', ['sessionDefaultChannelGroup'], ['sessions', 'purchaseRevenue']])
is('shapeReport: righe correnti in ordine di id, previous abbinato per chiave', shaped.breakdowns[0].rows, [
  { key: 'Organic Search', dimensions: { sessionDefaultChannelGroup: 'Organic Search' }, metrics: { sessions: 700, purchaseRevenue: 300 }, previous: { sessions: 650, purchaseRevenue: 0 } },
  { key: 'Paid Social', dimensions: { sessionDefaultChannelGroup: 'Paid Social' }, metrics: { sessions: 500, purchaseRevenue: 200 }, previous: null },
])
is('shapeReport: Direct (solo previous) non compare', shaped.breakdowns[0].rows.some(r => r.key === 'Direct'), false)

const unknownRun: TrackingReportRun = { ...run, definition: { title: 'Vecchio' }, definition_ver: null }
const unknownShaped = shapeReport(unknownRun, rows)
is('shapeReport: breakdown senza spec → colonne dalle righe', [unknownShaped.breakdowns[0].title, unknownShaped.breakdowns[0].dimensions, unknownShaped.breakdowns[0].metrics],
  ['canale', ['sessionDefaultChannelGroup'], ['sessions', 'purchaseRevenue']])
is('shapeReport: run fallito senza righe', shapeReport({ ...run, ok: false, error: 'boom', row_count: 0 }, []).totals, [])

console.log(fail ? `\n${fail} controlli falliti` : '\nTutti i controlli passano')
process.exit(fail ? 1 : 0)
