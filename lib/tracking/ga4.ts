/**
 * Client GA4 Data API, senza dipendenze esterne.
 *
 * Il flusso del service account è un JWT firmato RS256 scambiato per un access
 * token ("two-legged OAuth"): nessun consenso interattivo, che è il motivo per
 * cui si usa il service account invece di un flusso OAuth utente. node:crypto
 * firma il JWT, quindi zero librerie Google.
 *
 * Modulo puro: niente database, niente lettura di credenziali. Il chiamante
 * passa il service account già decifrato; gli endpoint sono iniettabili per
 * collaudare tutto contro un server finto locale.
 */
import crypto from 'node:crypto'
import { TrackingError } from '@/lib/tracking/errors'

export type Ga4Endpoints = { token: string; dataApi: string }

/** Letti a ogni chiamata, non al load del modulo: le env possono cambiare nei test. */
export function defaultEndpoints(): Ga4Endpoints {
  return {
    token: process.env.TWOBEE_GA4_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    dataApi: process.env.TWOBEE_GA4_DATA_URL ?? 'https://analyticsdata.googleapis.com/v1beta',
  }
}

export type ServiceAccount = {
  clientEmail: string
  privateKey: string
  projectId: string | null
}

export type Ga4Context = { account: ServiceAccount; endpoints?: Ga4Endpoints }

export type RunReportParams = {
  propertyId: string
  /** Formato Data API: 'YYYY-MM-DD', 'today', '7daysAgo'… */
  startDate: string
  endDate: string
  metrics: string[]
  dimensions?: string[]
  /** Metrica su cui ordinare (sempre decrescente). Deve stare in `metrics`. */
  orderBy?: string | null
  limit?: number
  /** Restringe la query a un solo evento (filtro EXACT su eventName). */
  eventName?: string | null
}

export type Ga4Row = { dimensions: Record<string, string>; metrics: Record<string, number> }

export type Ga4ReportResult = {
  rows: Ga4Row[]
  metricNames: string[]
  dimensionNames: string[]
  rowCount: number
  /** GA4 ha campionato/aggregato: va mostrato, non ignorato. */
  sampled: boolean
}

export type Ga4MetadataEntry = { apiName: string; uiName: string; category: string; custom: boolean }
export type Ga4Metadata = { metrics: Ga4MetadataEntry[]; dimensions: Ga4MetadataEntry[] }

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'
const TOKEN_TTL_SECONDS = 3600
const REQUEST_TIMEOUT_MS = 30000

/** Access token in cache per (client_email, endpoint token), finché non scade. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

const base64url = (input: string) => Buffer.from(input).toString('base64url')

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** `err.cause.code` (ECONNREFUSED, ETIMEDOUT…) è più utile del messaggio generico di fetch. */
function fetchFailure(err: unknown): string {
  if (err instanceof Error) {
    const cause: unknown = err.cause
    if (isRecord(cause) && typeof cause.code === 'string') return cause.code
    return err.message
  }
  return String(err)
}

async function readJson<T extends object>(response: Response): Promise<Partial<T>> {
  const parsed: unknown = await response.json().catch(() => null)
  return isRecord(parsed) ? (parsed as Partial<T>) : {}
}

/** Valida il JSON del service account e restituisce i campi che servono. */
export function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new TrackingError(400, 'Il service account non è un JSON valido')
  }
  const obj = isRecord(parsed) ? parsed : {}

  const missing = ['client_email', 'private_key'].filter(field => !obj[field])
  if (missing.length) {
    throw new TrackingError(400, `JSON del service account incompleto: manca ${missing.join(', ')}`)
  }
  if (obj.type && obj.type !== 'service_account') {
    throw new TrackingError(400, `Atteso un JSON di tipo service_account, ricevuto "${String(obj.type)}"`)
  }
  // Le chiavi copiate a mano perdono spesso gli a-capo, che diventano "\n" letterali.
  const privateKey = String(obj.private_key).replace(/\\n/g, '\n')
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new TrackingError(400, 'private_key non sembra una chiave PEM')
  }

  return {
    clientEmail: String(obj.client_email),
    privateKey,
    projectId: typeof obj.project_id === 'string' ? obj.project_id : null,
  }
}

/** Costruisce e firma il JWT di autorizzazione. */
export function buildAssertion(
  account: ServiceAccount,
  { audience, now = Math.floor(Date.now() / 1000) }: { audience: string; now?: number },
): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: SCOPE,
      aud: audience,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    }),
  )

  const signingInput = `${header}.${claims}`
  let signature: Buffer
  try {
    signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(account.privateKey)
  } catch (err) {
    throw new TrackingError(400, `Chiave privata non utilizzabile: ${err instanceof Error ? err.message : String(err)}`)
  }

  return `${signingInput}.${signature.toString('base64url')}`
}

type TokenResponse = { access_token: string; expires_in: number; error: string; error_description: string }

/** Access token, dalla cache se ancora valido. */
export async function getAccessToken(account: ServiceAccount, endpoints: Ga4Endpoints = defaultEndpoints()): Promise<string> {
  const cacheKey = `${account.clientEmail}@${endpoints.token}`
  const cached = tokenCache.get(cacheKey)
  // Margine di 60s: un token che scade durante la richiesta è un errore inutile.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const assertion = buildAssertion(account, { audience: endpoints.token })

  let response: Response
  try {
    response = await fetch(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new TrackingError(502, `Google non raggiungibile: ${fetchFailure(err)}`)
  }

  const payload = await readJson<TokenResponse>(response)
  if (!response.ok) {
    // Il campo error_description di Google è specifico: vale riportarlo così com'è.
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`
    throw new TrackingError(
      response.status === 400 || response.status === 401 ? 401 : 502,
      `Autenticazione GA4 rifiutata: ${detail}`,
    )
  }

  const token = payload.access_token
  if (!token) throw new TrackingError(502, 'Risposta di Google senza access_token')

  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + (payload.expires_in ?? TOKEN_TTL_SECONDS) * 1000,
  })
  return token
}

/** Svuota la cache dei token: serve quando si sostituisce il service account. */
export function clearTokenCache(): void {
  tokenCache.clear()
}

type ApiErrorBody = { error: { message?: string } }

async function callDataApi<T extends object>(path: string, body: object | null, ctx: Ga4Context): Promise<Partial<T>> {
  const endpoints = ctx.endpoints ?? defaultEndpoints()
  const token = await getAccessToken(ctx.account, endpoints)

  let response: Response
  try {
    response = await fetch(`${endpoints.dataApi}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new TrackingError(502, `GA4 Data API non raggiungibile: ${fetchFailure(err)}`)
  }

  const payload = await readJson<T & ApiErrorBody>(response)
  if (!response.ok) {
    const detail = payload.error?.message ?? `HTTP ${response.status}`
    // 403 su una property quasi sempre significa service account non autorizzato.
    const hint =
      response.status === 403
        ? ' — verifica di aver aggiunto il service account come utente con permesso di lettura sulla property'
        : ''
    throw new TrackingError(response.status === 403 ? 403 : 502, `GA4: ${detail}${hint}`)
  }
  return payload
}

type RunReportResponse = {
  metricHeaders: { name: string }[]
  dimensionHeaders: { name: string }[]
  rows: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[]
  rowCount: number
  metadata: { samplingMetadatas?: unknown[] }
}

/**
 * Esegue una query. `metrics` e `dimensions` sono nomi della Data API, gli stessi
 * che si scelgono in Esplora.
 */
export async function runReport(params: RunReportParams, ctx: Ga4Context): Promise<Ga4ReportResult> {
  const { propertyId, startDate, endDate, metrics, dimensions = [], orderBy = null, limit = 100, eventName = null } = params
  if (!propertyId) throw new TrackingError(409, 'Property ID GA4 mancante per questo cliente')

  const body: Record<string, unknown> = {
    dateRanges: [{ startDate, endDate }],
    metrics: metrics.map(name => ({ name })),
    dimensions: dimensions.map(name => ({ name })),
    limit,
    // Le righe (other) aggregate falsano i totali di un breakdown: meglio senza.
    keepEmptyRows: false,
  }

  // Restringe la query a un singolo evento. Serve al secondo passaggio del
  // funnel: la Data API v1beta non ha un endpoint funnel (esiste solo in alpha),
  // quindi il funnel si costruisce con due query filtrate e un calcolo.
  if (eventName) {
    body.dimensionFilter = {
      filter: {
        fieldName: 'eventName',
        stringFilter: { matchType: 'EXACT', value: eventName },
      },
    }
  }

  if (orderBy) {
    body.orderBys = [{ metric: { metricName: orderBy }, desc: true }]
  }

  const payload = await callDataApi<RunReportResponse>(`properties/${propertyId}:runReport`, body, ctx)

  const metricNames = (payload.metricHeaders ?? []).map(h => h.name)
  const dimensionNames = (payload.dimensionHeaders ?? []).map(h => h.name)

  const rows: Ga4Row[] = (payload.rows ?? []).map(row => {
    const dims: Record<string, string> = {}
    dimensionNames.forEach((name, i) => {
      dims[name] = row.dimensionValues?.[i]?.value ?? ''
    })

    const values: Record<string, number> = {}
    metricNames.forEach((name, i) => {
      const num = Number(row.metricValues?.[i]?.value)
      values[name] = Number.isFinite(num) ? num : 0
    })

    return { dimensions: dims, metrics: values }
  })

  return {
    rows,
    metricNames,
    dimensionNames,
    rowCount: payload.rowCount ?? rows.length,
    sampled: Boolean(payload.metadata?.samplingMetadatas?.length),
  }
}

type MetadataEntry = { apiName: string; uiName?: string; category?: string; customDefinition?: boolean }
type MetadataResponse = { metrics: MetadataEntry[]; dimensions: MetadataEntry[] }

/** Metriche e dimensioni disponibili sulla property: aiuta a scrivere le definizioni. */
export async function fetchMetadata(propertyId: string, ctx: Ga4Context): Promise<Ga4Metadata> {
  if (!propertyId) throw new TrackingError(409, 'Property ID GA4 mancante per questo cliente')
  const payload = await callDataApi<MetadataResponse>(`properties/${propertyId}/metadata`, null, ctx)

  const map = (list: MetadataEntry[] | undefined): Ga4MetadataEntry[] =>
    (list ?? []).map(entry => ({
      apiName: entry.apiName,
      uiName: entry.uiName ?? entry.apiName,
      category: entry.category ?? '',
      custom: Boolean(entry.customDefinition),
    }))

  return { metrics: map(payload.metrics), dimensions: map(payload.dimensions) }
}
