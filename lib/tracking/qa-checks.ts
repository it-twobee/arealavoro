import { fetchSite, detectTags, type FoundTags } from './site-check'
import { normalizeUrl } from './validate'
import { runReport, type Ga4Context } from './ga4'
import { accountPixels, type MetaContext, type MetaPixel } from './meta'
import { errorMessage } from './errors'
import { QA_CHECKS, type QaCheckKey, type QaStatus, type TrackingStatus } from './vocab'

/**
 * §316 — I tre controlli del QA giornaliero, senza database: prendono i dati
 * e restituiscono un esito. Li usa il CRM (`qa.ts`, che legge e scrive su
 * Supabase) e li usa l'app di laboratorio con SQLite. Nessun import di
 * Supabase qui dentro, per scelta.
 *
 * Quattro esiti, e le differenze contano:
 *  'na'            manca il dato per controllare (nessun Pixel ID, nessun URL)
 *  'indeterminato' controllato ma non conclude: il sito carica GTM, che
 *                  inietta i tag a runtime, quindi l'assenza dall'HTML non
 *                  dimostra niente. Giallo, non rosso.
 *  'problema'      assenza reale, o errore
 *  'ok'            verificato
 */

export type CheckResult = { status: QaStatus; detail: string }

/** Ciò che serve dei dati del cliente, con i nomi delle colonne di `client_tracking`. */
export type QaTarget = {
  website: string | null
  gtm_container_id: string
  meta_pixel_id: string
  ga4_property_id: string
}

export type QaSite = { ok: boolean; error: string | null; tags: Pick<FoundTags, 'gtmIds' | 'metaIds'> }
export const NO_SITE: QaSite = { ok: false, error: 'Sito non interrogato', tags: { gtmIds: [], metaIds: [] } }

/** Ieri e l'altroieri, più oggi (incompleto). */
export const GA4_WINDOW = { startDate: '2daysAgo', endDate: 'today' }

/** Una sola richiesta al sito, usata sia per GTM sia per il Pixel. */
export async function fetchQaSite(website: string | null): Promise<QaSite> {
  if (!website) return NO_SITE
  try {
    const fetched = await fetchSite(normalizeUrl(website))
    return { ok: fetched.ok, error: fetched.error, tags: fetched.ok ? detectTags(fetched.html) : { gtmIds: [], metaIds: [] } }
  } catch (e) {
    return { ok: false, error: errorMessage(e), tags: { gtmIds: [], metaIds: [] } }
  }
}

export function checkGtm(t: QaTarget, site: QaSite): CheckResult {
  if (!t.website) return { status: 'na', detail: 'URL del sito non inserito' }
  if (!t.gtm_container_id) return { status: 'na', detail: 'Nessun container GTM configurato in scheda' }
  if (!site.ok) return { status: 'problema', detail: site.error ?? 'Sito non raggiungibile' }
  const wanted = t.gtm_container_id.toUpperCase()
  if (site.tags.gtmIds.includes(wanted)) return { status: 'ok', detail: `${wanted} presente sul sito` }
  return {
    status: 'problema',
    detail: site.tags.gtmIds.length
      ? `GTM non trovato: sul sito c'è ${site.tags.gtmIds.join(', ')}, non ${wanted}`
      : `GTM non trovato sul sito (atteso ${wanted})`,
  }
}

export function checkMetaPixel(t: QaTarget, site: QaSite): CheckResult {
  const pixel = t.meta_pixel_id
  if (!pixel) return { status: 'na', detail: 'Nessun Pixel ID salvato per questo cliente' }
  if (!t.website) return { status: 'na', detail: 'URL del sito non inserito' }
  if (!site.ok) return { status: 'problema', detail: site.error ?? 'Sito non raggiungibile' }
  if (site.tags.metaIds.includes(pixel)) return { status: 'ok', detail: `Pixel ${pixel} presente sul sito` }
  // un altro Pixel nel sorgente è un dato concreto, anche con GTM attivo
  if (site.tags.metaIds.length) {
    return { status: 'problema', detail: `Meta Pixel non trovato: sul sito c'è ${site.tags.metaIds.join(', ')}, non ${pixel}` }
  }
  // nessun Pixel ma il sito carica GTM (uno qualsiasi): l'assenza non dimostra nulla
  if (site.tags.gtmIds.length) {
    return {
      status: 'indeterminato',
      detail: "Non deducibile dall'HTML: il sito carica GTM, e un Pixel configurato lì dentro non compare nel sorgente. " +
        'La verifica certa arriva dal connettore Meta (token in Impostazioni + Ad Account ID nel tab Chiavi).',
    }
  }
  return { status: 'problema', detail: 'Meta Pixel non trovato sul sito' }
}

const fmtWhen = (iso: string) => new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })

/**
 * Fonte di verità quando il connettore Meta è configurato: il pixel ha
 * ricevuto eventi nelle ultime 48 ore? Non se il codice compare nell'HTML.
 */
export function evaluatePixels(pixels: MetaPixel[], now: number = Date.now()): CheckResult {
  if (pixels.length === 0) return { status: 'problema', detail: 'Nessun pixel collegato a questo ad account Meta' }
  const limit = now - 48 * 3600 * 1000
  const active = pixels.filter(p => p.lastFiredTime && Date.parse(p.lastFiredTime) >= limit)
  if (active.length) {
    const p = active[0]
    return { status: 'ok', detail: `Pixel "${p.name}" ha ricevuto eventi il ${fmtWhen(p.lastFiredTime!)}` }
  }
  const last = pixels.filter(p => p.lastFiredTime).sort((a, b) => Date.parse(b.lastFiredTime!) - Date.parse(a.lastFiredTime!))[0]
  return {
    status: 'problema',
    detail: last ? `Nessun evento pixel nelle ultime 48h · ultimo: ${fmtWhen(last.lastFiredTime!)}` : 'Il pixel non ha mai ricevuto eventi',
  }
}

export async function checkMetaPixelViaApi(adAccountId: string, ctx: MetaContext): Promise<CheckResult> {
  return evaluatePixels(await accountPixels(adAccountId, ctx))
}

/** Sessioni o eventi nelle ultime 48 ore sulla property. */
export function evaluateGa4(rows: { metrics: Record<string, number> }[], propertyId: string): CheckResult {
  const sessions = rows[0]?.metrics.sessions ?? 0
  const events = rows[0]?.metrics.eventCount ?? 0
  if (sessions > 0 || events > 0) {
    return { status: 'ok', detail: `${sessions.toLocaleString('it-IT')} sessioni e ${events.toLocaleString('it-IT')} eventi nelle ultime 48h` }
  }
  return { status: 'problema', detail: `Nessun dato GA4 nelle ultime 48h (property ${propertyId})` }
}

/** `ctx` null = service account non disponibile, con `ctxError` che dice perché. */
export async function checkGa4(t: QaTarget, ctx: Ga4Context | null, ctxError?: string): Promise<CheckResult> {
  const property = t.ga4_property_id
  if (!property) return { status: 'na', detail: 'Property ID GA4 non inserito' }
  if (!ctx) return { status: 'na', detail: ctxError ?? 'Service account GA4 non configurato' }
  try {
    const result = await runReport({ propertyId: property, ...GA4_WINDOW, metrics: ['sessions', 'eventCount'], limit: 1 }, ctx)
    return evaluateGa4(result.rows, property)
  } catch (e) {
    // il messaggio di Google è specifico: si riporta intero, non riassunto
    const msg = errorMessage(e)
    console.error(`[qa] GA4 property ${property}: ${msg}`)
    return { status: 'problema', detail: `GA4 non interrogabile: ${msg}` }
  }
}

export type QaResults = Record<QaCheckKey, CheckResult>
export type QaStatuses = { status_gtm: TrackingStatus; status_ga4: TrackingStatus; status_meta_pixel: TrackingStatus }

/**
 * Un controllo riuscito è la prova più forte che il canale funziona. Solo
 * promozione, mai declassamento — stessa regola della verifica del sito.
 * Ritorna le colonne da portare ad `active`.
 */
export function promotionsFor(current: QaStatuses, results: QaResults): Partial<QaStatuses> {
  const patch: Partial<QaStatuses> = {}
  const pairs: [QaCheckKey, keyof QaStatuses][] = [['gtm', 'status_gtm'], ['ga4', 'status_ga4'], ['meta_pixel', 'status_meta_pixel']]
  for (const [key, field] of pairs) {
    if (results[key].status !== 'ok') continue
    const value = current[field]
    if (value === 'active' || value === 'na') continue
    patch[field] = 'active'
  }
  return patch
}

export const countProblems = (results: QaResults) => Object.values(results).filter(r => r.status === 'problema').length

export type QaCheckView = { key: QaCheckKey; label: string; needs: string; status: QaStatus | null; detail: string; checkedAt: string | null }

type SavedResult = { check_key: QaCheckKey; status: QaStatus; detail: string; checked_at: string }

/** Esiti nell'ordine dei controlli; `status` null = mai controllato. */
export function viewsFor(rows: SavedResult[]): QaCheckView[] {
  const byKey = new Map(rows.map(r => [r.check_key, r]))
  return QA_CHECKS.map(check => {
    const row = byKey.get(check.key)
    return {
      key: check.key, label: check.label, needs: check.needs,
      status: row?.status ?? null, detail: row?.detail ?? 'Mai controllato', checkedAt: row?.checked_at ?? null,
    }
  })
}

export type QaSummary = { status: 'ok' | 'problema' | 'na'; problems: { key: QaCheckKey; detail: string }[]; verified: number; checkedAt: string }

/**
 * Un solo stato per cliente. Un cliente in cui nessun controllo è stato
 * possibile NON è verde: verde solo se almeno un controllo è passato davvero
 * e nessuno è fallito. `indeterminato` non è un problema.
 */
export function summarize(rows: (SavedResult & { client_id: string })[]): Map<string, QaSummary> {
  const map = new Map<string, QaSummary>()
  for (const row of rows) {
    let entry = map.get(row.client_id)
    if (!entry) { entry = { status: 'na', problems: [], verified: 0, checkedAt: row.checked_at }; map.set(row.client_id, entry) }
    if (row.status === 'problema') entry.problems.push({ key: row.check_key, detail: row.detail })
    else if (row.status === 'ok') entry.verified += 1
    if (row.checked_at > entry.checkedAt) entry.checkedAt = row.checked_at
  }
  for (const entry of Array.from(map.values())) entry.status = entry.problems.length ? 'problema' : entry.verified > 0 ? 'ok' : 'na'
  return map
}
