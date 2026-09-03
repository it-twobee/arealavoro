/**
 * Client Meta Marketing API (Graph API), senza dipendenze esterne.
 *
 * Il token del System User è d'agenzia, l'Ad Account ID cambia per cliente:
 * il chiamante passa entrambi, qui non si legge nulla. Il token viaggia
 * nell'header Authorization e non nella query string, così non finisce nei
 * log intermedi.
 */
import { TrackingError } from '@/lib/tracking/errors'

export type MetaEndpoints = { base: string }

/** Letti a ogni chiamata, non al load del modulo: le env possono cambiare nei test. */
export function defaultEndpoints(): MetaEndpoints {
  return { base: process.env.TWOBEE_META_BASE ?? 'https://graph.facebook.com/v21.0' }
}

export type MetaContext = { token: string; endpoints?: MetaEndpoints }

export type MetaMetrics = {
  spesa: number
  impression: number
  click: number
  /** Frazione (0.0123), non percentuale: come tutti i tassi del sistema. */
  tasso_click: number
  conversioni: number
  costo_per_conversione: number
}

export type MetaAction = {
  action_type: string
  conteggio: number
  costo_per_azione: number
  conversione: boolean
}

export type MetaInsights = {
  metrics: MetaMetrics
  /** Ogni azione con il suo costo: nulla resta nascosto dentro "conversioni". */
  actions: MetaAction[]
  /** action_type effettivamente conteggiati come conversione, per ispezione. */
  conversionActions: string[]
  /** Nessuna riga nel periodo = nessuna erogazione, non un errore. */
  vuoto: boolean
}

export type MetaPixel = { id: string; name: string; lastFiredTime: string | null }

export type AccountInsightsParams = { adAccountId: string; since: string; until: string }

export type ActionClass = { evento: string; specificita: 0 | 1 | 2 }

export type ConversionSelection = { totale: number; actionTypes: string[] }

const REQUEST_TIMEOUT_MS = 30000

/**
 * Eventi che valgono come conversione. Non basta filtrare per prefisso:
 * `offsite_conversion.fb_pixel_view_content` è un evento del pixel ma non una
 * conversione, e sommarlo gonfia il dato di un ordine di grandezza.
 */
export const CONVERSION_EVENTS: ReadonlySet<string> = new Set([
  'lead',
  'purchase',
  'complete_registration',
  'submit_application',
  'subscribe',
  'start_trial',
  'contact',
  'schedule',
  'donate',
])

/**
 * Nome dell'evento dietro un action_type, e quanto è specifica quella voce.
 * Meta riporta lo stesso evento su più livelli di aggregazione — il pixel
 * (`offsite_conversion.fb_pixel_lead`) e la forma normalizzata (`lead`) — e
 * sommarli entrambi conterebbe ogni conversione due volte.
 */
export function classifyAction(actionType: string): ActionClass {
  const pixel = actionType.match(/^offsite_conversion\.fb_pixel_(.+)$/)
  if (pixel) return { evento: pixel[1], specificita: 2 }

  const onsite = actionType.match(/^onsite_conversion\.(.+)$/)
  if (onsite) return { evento: onsite[1], specificita: 1 }

  return { evento: actionType, specificita: 0 }
}

export function isConversionAction(actionType: string): boolean {
  return CONVERSION_EVENTS.has(classifyAction(actionType).evento)
}

/**
 * Sceglie una sola voce per evento di conversione, preferendo la più specifica.
 * Restituisce gli action_type effettivamente conteggiati, che il report mostra:
 * il numero deve essere sempre ispezionabile.
 */
export function selectConversions(azioni: Iterable<readonly [string, number]>): ConversionSelection {
  const perEvento = new Map<string, { actionType: string; valore: number; specificita: number }>()

  for (const [actionType, valore] of Array.from(azioni)) {
    const { evento, specificita } = classifyAction(actionType)
    if (!CONVERSION_EVENTS.has(evento)) continue

    const attuale = perEvento.get(evento)
    if (!attuale || specificita > attuale.specificita) {
      perEvento.set(evento, { actionType, valore, specificita })
    }
  }

  const scelte = Array.from(perEvento.values())
  return {
    totale: scelte.reduce((somma, s) => somma + s.valore, 0),
    actionTypes: scelte.map(s => s.actionType),
  }
}

/** Accetta 1234567890 o act_1234567890 e restituisce sempre act_1234567890. */
export function normalizeAdAccount(value: string | null | undefined): string {
  const raw = String(value ?? '').trim().replace(/^act_/i, '')
  if (!/^\d{5,}$/.test(raw)) {
    throw new TrackingError(400, `Ad Account ID non valido: "${value}" (attese solo cifre, es. act_1234567890)`)
  }
  return `act_${raw}`
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Meta restituisce il CTR già in percentuale (1.23 = 1,23%): qui si porta a frazione. */
export function ctrToFraction(ctr: unknown): number {
  return num(ctr) / 100
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function fetchFailure(err: unknown): string {
  if (err instanceof Error) {
    const cause: unknown = err.cause
    if (isRecord(cause) && typeof cause.code === 'string') return cause.code
    return err.message
  }
  return String(err)
}

type GraphError = { code?: number; message?: string; error_user_msg?: string }

async function request<T extends object>(
  path: string,
  params: Record<string, string | undefined>,
  ctx: MetaContext,
): Promise<Partial<T>> {
  if (!ctx.token) throw new TrackingError(409, 'Token System User Meta non configurato in Impostazioni')
  const endpoints = ctx.endpoints ?? defaultEndpoints()

  const url = new URL(`${endpoints.base}/${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }

  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${ctx.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new TrackingError(502, `Meta non raggiungibile: ${fetchFailure(err)}`)
  }

  const parsed: unknown = await response.json().catch(() => null)
  const payload: Partial<T> & { error?: GraphError } = isRecord(parsed) ? (parsed as Partial<T> & { error?: GraphError }) : {}

  if (!response.ok || payload.error) {
    const e: GraphError = payload.error ?? {}
    // I codici di Meta sono specifici e vale la pena tradurli in indicazioni.
    const hint =
      e.code === 190
        ? ' — il token è scaduto o revocato: rigeneralo e aggiornalo in Impostazioni'
        : e.code === 200 || e.code === 10
          ? ' — al System User mancano i permessi ads_read su questo ad account'
          : e.code === 100
            ? " — parametro rifiutato: controlla che l'Ad Account ID appartenga a questo token"
            : ''
    throw new TrackingError(
      e.code === 190 || e.code === 200 || e.code === 10 ? 403 : 502,
      `Meta: ${e.error_user_msg ?? e.message ?? `HTTP ${response.status}`}${hint}`,
    )
  }
  return payload
}

type ActionEntry = { action_type: string; value?: unknown }

/** Elenco {action_type: valore} da una lista di Meta. */
function actionMap(list: ActionEntry[] | undefined): Map<string, number> {
  const map = new Map<string, number>()
  for (const entry of list ?? []) map.set(entry.action_type, num(entry.value))
  return map
}

type InsightsRow = {
  spend?: unknown
  impressions?: unknown
  clicks?: unknown
  ctr?: unknown
  actions?: ActionEntry[]
  cost_per_action_type?: ActionEntry[]
}
type InsightsResponse = { data: InsightsRow[] }

function zeroMetrics(): MetaMetrics {
  return { spesa: 0, impression: 0, click: 0, tasso_click: 0, conversioni: 0, costo_per_conversione: 0 }
}

/**
 * Insight a livello account per un intervallo di date.
 * Restituisce già le metriche normalizzate nei nomi usati dal report.
 */
export async function accountInsights({ adAccountId, since, until }: AccountInsightsParams, ctx: MetaContext): Promise<MetaInsights> {
  const payload = await request<InsightsResponse>(
    `${normalizeAdAccount(adAccountId)}/insights`,
    {
      level: 'account',
      time_range: JSON.stringify({ since, until }),
      fields: 'spend,impressions,clicks,ctr,cpc,reach,actions,cost_per_action_type',
    },
    ctx,
  )

  const row = payload.data?.[0]
  if (!row) {
    return { metrics: zeroMetrics(), actions: [], vuoto: true, conversionActions: [] }
  }

  const azioni = actionMap(row.actions)
  const costi = actionMap(row.cost_per_action_type)

  const { totale: conversioni, actionTypes: conversionActions } = selectConversions(azioni)
  const spesa = num(row.spend)

  return {
    metrics: {
      spesa,
      impression: num(row.impressions),
      click: num(row.clicks),
      tasso_click: ctrToFraction(row.ctr),
      conversioni,
      costo_per_conversione: conversioni ? spesa / conversioni : 0,
    },
    actions: Array.from(azioni.entries()).map(([action_type, conteggio]) => ({
      action_type,
      conteggio,
      costo_per_azione: costi.get(action_type) ?? 0,
      conversione: isConversionAction(action_type),
    })),
    conversionActions,
    vuoto: false,
  }
}

type PixelsResponse = { data: { id: string; name?: string; last_fired_time?: string }[] }

/**
 * Pixel dell'ad account con l'ultimo evento ricevuto. È la fonte di verità per
 * il controllo giornaliero: dice se il pixel *riceve dati*, non se il codice
 * compare nell'HTML.
 */
export async function accountPixels(adAccountId: string, ctx: MetaContext): Promise<MetaPixel[]> {
  const payload = await request<PixelsResponse>(
    `${normalizeAdAccount(adAccountId)}/adspixels`,
    { fields: 'id,name,last_fired_time' },
    ctx,
  )

  return (payload.data ?? []).map(p => ({
    id: p.id,
    name: p.name ?? p.id,
    lastFiredTime: p.last_fired_time ?? null,
  }))
}
