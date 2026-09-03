/**
 * Verifica automatica del tracking leggendo l'HTML della homepage. Puro + fetch:
 * niente database, la scrittura sta nella server action.
 *
 * Politica asimmetrica, e il perché: lo snippet GTM sta SEMPRE nell'HTML, quindi
 * se il container configurato non compare è un'assenza reale e lo stato GTM si
 * muove in entrambe le direzioni. GA4, Meta Pixel e Klaviyo di solito li carica
 * GTM a runtime e nel sorgente non compaiono: non trovarli non prova niente, si
 * portano ad "active" solo quando il tag è visibile, mai al ribasso.
 */
import { TrackingError } from './errors'
import { channelsFor, type ChannelKey, type TrackingStatus } from './vocab'
import type { ClientTracking, TrackingChange } from '@/lib/types/database'

export const TIMEOUT_MS = 15_000
// Le homepage e-commerce reali viaggiano intorno a 1,5 MB: con un tetto più
// basso il body si troncava e i tag in fondo alla pagina sparivano.
export const MAX_BYTES = 4_000_000
export const USER_AGENT = 'TwoBeeOS-TrackingCheck/1.0 (+verifica interna tracking)'

/** Il server fa una richiesta verso un URL scelto dall'utente: mai verso la rete interna. */
export function assertPublicHost(url: string): void {
  const host = new URL(url).hostname.toLowerCase()
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^0\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  if (isPrivate) throw new TrackingError(400, `Indirizzo interno non ammesso: ${host}`)
}

export type FetchResult = {
  ok: boolean
  httpStatus: number | null
  finalUrl: string
  html: string
  bytes: number
  durationMs: number
  error: string | null
}

/** Legge il corpo con un tetto di byte: una homepage enorme non deve saturare la RAM. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let html = ''
  let received = 0
  while (received < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    html += decoder.decode(value, { stream: true })
    received += value.length
  }
  await reader.cancel().catch(() => {})
  return html + decoder.decode()
}

function failureMessage(err: unknown): string {
  const e = err instanceof Error ? err : null
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return `Timeout dopo ${TIMEOUT_MS / 1000}s`
  const cause = e?.cause as { code?: unknown } | undefined
  if (typeof cause?.code === 'string') return cause.code
  return e?.message ?? String(err)
}

/** Scarica la homepage. Non lancia sugli errori di rete: li restituisce. */
export async function fetchSite(url: string): Promise<FetchResult> {
  assertPublicHost(url)
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-IT,it;q=0.9',
      },
    })
    const html = await readCapped(response)
    return {
      ok: response.ok,
      httpStatus: response.status,
      finalUrl: response.url || url,
      html,
      bytes: html.length,
      durationMs: Date.now() - startedAt,
      error: response.ok ? null : `Risposta HTTP ${response.status}`,
    }
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      finalUrl: url,
      html: '',
      bytes: 0,
      durationMs: Date.now() - startedAt,
      error: `Sito non raggiungibile: ${failureMessage(err)}`,
    }
  }
}

export type FoundTags = {
  gtmIds: string[]
  ga4Ids: string[]
  gtagLoaded: boolean
  metaIds: string[]
  fbevents: boolean
  klaviyo: boolean
}

const unique = (values: string[]): string[] => Array.from(new Set(values))

// Parole che assomigliano a un container ID ma non lo sono: arrivano da attributi
// come id="gtm-noscript". Il match è già case-sensitive, questo copre gli
// attributi scritti in maiuscolo.
const NOT_CONTAINER_IDS = new Set(['SCRIPT', 'NOSCRIPT', 'CONTAINER', 'IFRAME', 'DATALAYER'])

const digits = (s: string): string => s.match(/(\d{8,})/)?.[1] ?? ''

/** Estrae gli identificativi dei tag presenti nel sorgente. */
export function detectTags(html: string): FoundTags {
  // Case-sensitive di proposito: nello snippet il container è sempre maiuscolo,
  // gli attributi HTML che davano falsi positivi (gtm-script) sono minuscoli.
  const gtmIds = unique((html.match(/GTM-[A-Z0-9]{5,}/g) ?? []).filter(id => !NOT_CONTAINER_IDS.has(id.slice(4))))

  const ga4Ids = unique(html.match(/\bG-[A-Z0-9]{7,}\b/g) ?? [])
  const gtagLoaded = /googletagmanager\.com\/gtag\/js/i.test(html)

  const metaIds = unique(
    [
      ...(html.match(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{8,})['"]/gi) ?? []),
      ...(html.match(/facebook\.com\/tr\?id=(\d{8,})/gi) ?? []),
    ].map(digits).filter(Boolean),
  )
  const fbevents = /connect\.facebook\.net\/[^"']*\/fbevents\.js/i.test(html)

  // Solo segnali di codice eseguibile: la parola "klaviyo" in un footer
  // "powered by" non prova che il tracking sia attivo.
  const klaviyo =
    /(static|a|fast)[\w.-]*\.klaviyo\.com/i.test(html) ||
    /klaviyo\.js/i.test(html) ||
    /_learnq/.test(html)

  return { gtmIds, ga4Ids, gtagLoaded, metaIds, fbevents, klaviyo }
}

export type EvaluationInput = Pick<
  ClientTracking,
  'archetype' | 'gtm_container_id' | 'meta_pixel_id' | 'status_gtm' | 'status_ga4' | 'status_meta_pixel' | 'status_klaviyo'
>
export type Evaluation = { changes: TrackingChange[]; notes: string[]; gtmPresente: boolean }

type StatusField = `status_${ChannelKey}`

/**
 * Traduce i tag trovati in aggiornamenti di stato. Non scrive: restituisce le
 * modifiche proposte. Chiamare solo se la pagina si è scaricata: su un HTML
 * vuoto proporrebbe un declassamento GTM che non è una conclusione.
 */
export function evaluate(tracking: EvaluationInput, found: FoundTags): Evaluation {
  const changes: TrackingChange[] = []
  const notes: string[] = []
  const relevant = new Set(channelsFor(tracking.archetype))

  const propose = (field: StatusField, to: TrackingStatus, reason: string) => {
    const from = tracking[field]
    if (from === 'na') return
    if (from === to) return
    changes.push({ field, from, to, reason })
  }

  const gtmPresente = found.gtmIds.length > 0

  if (relevant.has('gtm')) {
    const configured = (tracking.gtm_container_id ?? '').toUpperCase()
    const list = found.gtmIds.join(', ')
    if (!gtmPresente) {
      propose('status_gtm', 'todo', 'Nessuno snippet GTM trovato nel sorgente della homepage')
    } else if (!configured) {
      propose('status_gtm', 'partial', `Trovato ${list} ma nessun container configurato in scheda`)
      notes.push(`Container trovato sul sito: ${list}. Salvalo nel campo "ID container GTM".`)
    } else if (found.gtmIds.includes(configured)) {
      propose('status_gtm', 'active', `Container ${configured} presente sul sito`)
    } else {
      propose('status_gtm', 'partial', `Sul sito c'è ${list}, non il container configurato ${configured}`)
      notes.push(`Disallineamento container: in scheda ${configured}, sul sito ${list}.`)
    }
  }

  // Pixel: come per GTM un ID diverso da quello in scheda non è una prova, ma
  // qui non si declassa — l'incoerenza si segnala soltanto.
  const configuredPixel = (tracking.meta_pixel_id ?? '').trim()
  const pixelMismatch = !!configuredPixel && found.metaIds.length > 0 && !found.metaIds.includes(configuredPixel)

  const positives: { key: ChannelKey; label: string; hit: boolean; reason: string; viaApi?: string }[] = [
    {
      key: 'ga4',
      label: 'GA4',
      hit: found.ga4Ids.length > 0 || found.gtagLoaded,
      reason: found.ga4Ids.length ? `Measurement ID ${found.ga4Ids.join(', ')} nel sorgente` : 'gtag.js caricato direttamente nel sorgente',
      viaApi: 'La prova reale è "Dati GA4 recenti", che interroga la Data API.',
    },
    {
      key: 'meta_pixel',
      label: 'Meta Pixel',
      hit: !pixelMismatch && (found.metaIds.length > 0 || found.fbevents),
      reason: found.metaIds.length ? `Pixel ${found.metaIds.join(', ')} nel sorgente` : 'fbevents.js caricato nel sorgente',
    },
    { key: 'klaviyo', label: 'Klaviyo', hit: found.klaviyo, reason: 'Script Klaviyo nel sorgente' },
  ]

  for (const channel of positives) {
    const field: StatusField = `status_${channel.key}`
    // Fuori dall'archetipo o "na": né promozioni né note.
    if (!relevant.has(channel.key) || tracking[field] === 'na') continue

    if (channel.key === 'meta_pixel' && pixelMismatch) {
      notes.push(`Disallineamento Pixel: in scheda ${configuredPixel}, sul sito ${found.metaIds.join(', ')}.`)
      continue
    }

    if (channel.hit) {
      propose(field, 'active', channel.reason)
    } else if (gtmPresente) {
      // GTM inietta gli altri tag a runtime: un "non trovato" qui non dice niente.
      notes.push(
        `${channel.label} non compare nell'HTML, ma il sito carica GTM: è il caso normale quando è configurato lì dentro. ` +
          (channel.viaApi ?? 'Il segnale attendibile è il controllo giornaliero, non il sorgente della pagina.'),
      )
    } else if (tracking[field] === 'active') {
      notes.push(`${channel.label} è segnato attivo ma non compare nell'HTML, e sul sito non c'è GTM che possa caricarlo: da controllare.`)
    }
  }

  return { changes, notes, gtmPresente }
}
