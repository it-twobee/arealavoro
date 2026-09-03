import { TrackingError } from './errors'
import { ARCHETYPE_VALUES, STATUS_VALUES, type Archetype, type TrackingStatus } from './vocab'

/** Normalizza quello che scrive l'utente: "sito.it" → "https://sito.it/". Vuoto resta vuoto. */
export function normalizeUrl(input: unknown): string {
  const raw = String(input ?? '').trim()
  if (!raw) return ''
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new TrackingError(400, `URL non valido: ${raw}`)
  }
  if (!/^https?:$/.test(url.protocol)) throw new TrackingError(400, 'Sono ammessi solo indirizzi http o https')
  return url.toString()
}

export function parseArchetype(value: unknown): Archetype | null {
  const v = value === '' || value === null || value === undefined ? null : String(value).trim()
  if (v !== null && !ARCHETYPE_VALUES.includes(v as Archetype)) throw new TrackingError(400, `Archetipo non valido: ${v}`)
  return v as Archetype | null
}

export function parseStatus(field: string, value: unknown): TrackingStatus {
  const v = String(value ?? '').trim()
  if (!STATUS_VALUES.includes(v as TrackingStatus)) throw new TrackingError(400, `Stato non valido per ${field}: ${v}`)
  return v as TrackingStatus
}

export function parseGtmContainerId(value: unknown): string {
  const v = String(value ?? '').trim()
  if (!v) return ''
  if (!/^GTM-[A-Z0-9]{6,}$/i.test(v)) throw new TrackingError(400, 'ID container GTM non valido (formato atteso: GTM-XXXXXXX)')
  return v.toUpperCase()
}

/** Nome di un evento GA4: senza spazi, altrimenti il filtro non trova mai nulla. */
export function parseLeadEvent(value: unknown): string {
  const v = String(value ?? '').trim()
  if (v && !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(v)) {
    throw new TrackingError(400, 'Nome evento non valido: lettere, numeri e underscore, senza spazi (es. generate_lead)')
  }
  return v
}

/** Il Pixel ID è numerico: un valore sbagliato farebbe fallire il QA ogni giorno. */
export function parseMetaPixelId(value: unknown): string {
  const v = String(value ?? '').replace(/\s+/g, '')
  if (v && !/^\d{8,20}$/.test(v)) throw new TrackingError(400, 'Pixel ID Meta non valido: sono solo cifre (es. 1234567890123456)')
  return v
}

/** Si copia spesso come "properties/123" o come Measurement ID G-XXXX, che non è la property. */
export function parseGa4PropertyId(value: unknown): string {
  const v = String(value ?? '').trim().replace(/^properties\//, '').trim()
  if (v && !/^\d{6,}$/.test(v)) {
    throw new TrackingError(400, 'Property ID GA4 non valido: serve il numero della property (es. 123456789), non il Measurement ID G-XXXX')
  }
  return v
}

export const text = (value: unknown, max = 500): string => String(value ?? '').trim().slice(0, max)
