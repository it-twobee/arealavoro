/**
 * §316 — Vocabolario del modulo Tracking: archetipi, canali, stati, piattaforme.
 * Una sola fonte per server e componenti client: qui non si importa niente di
 * server-side.
 */

export type TrackingStatus = 'active' | 'partial' | 'todo' | 'na'
export type ChannelKey = 'gtm' | 'ga4' | 'meta_pixel' | 'klaviyo'
export type StatusChannelKey = ChannelKey | 'gsc'
export type Archetype = 'ecommerce' | 'leadgen-b2b' | 'hospitality'
export type PlatformKey = 'ga4' | 'google_ads' | 'meta' | 'klaviyo'
export type AgencyPlatformKey = 'ga4' | 'google_ads' | 'meta'
export type QaCheckKey = 'gtm' | 'ga4' | 'meta_pixel'
export type QaStatus = 'ok' | 'indeterminato' | 'problema' | 'na'
export type ReportSource = 'ga4' | 'klaviyo' | 'meta'

/** Toni semantici: si mappano sui token `text-<tone>` / `bg-<tone>-dim`. */
export type Tone = 'success' | 'warning' | 'error' | 'muted'

export const STATUSES: { value: TrackingStatus; label: string; tone: Tone }[] = [
  { value: 'active', label: 'Attivo', tone: 'success' },
  { value: 'partial', label: 'Parziale', tone: 'warning' },
  { value: 'todo', label: 'Da fare', tone: 'error' },
  { value: 'na', label: 'N/A', tone: 'muted' },
]
export const STATUS_VALUES = STATUSES.map(s => s.value)
export const statusByValue = (v: string | null | undefined) => STATUSES.find(s => s.value === v) ?? null

/** Canali di tracking. La chiave corrisponde alla colonna status_<key>. */
export const CHANNELS: { key: ChannelKey; label: string }[] = [
  { key: 'gtm', label: 'Google Tag Manager' },
  { key: 'ga4', label: 'GA4' },
  { key: 'meta_pixel', label: 'Meta Pixel' },
  { key: 'klaviyo', label: 'Klaviyo' },
]
export const CHANNEL_KEYS = CHANNELS.map(c => c.key)

/** GSC sta a parte: è SEO, non tracking, e non entra nel badge. */
export const GSC_CHANNEL = { key: 'gsc' as const, label: 'Search Console' }

export const ARCHETYPES: { value: Archetype; label: string; templateKey: string; channels: ChannelKey[] }[] = [
  { value: 'ecommerce', label: 'E-commerce', templateKey: 'ecommerce-shopify', channels: ['gtm', 'ga4', 'meta_pixel', 'klaviyo'] },
  { value: 'leadgen-b2b', label: 'Lead gen B2B', templateKey: 'leadgen-b2b', channels: ['gtm', 'ga4', 'meta_pixel'] },
  { value: 'hospitality', label: 'Hospitality', templateKey: 'hospitality', channels: ['gtm', 'ga4', 'meta_pixel'] },
]
export const ARCHETYPE_VALUES = ARCHETYPES.map(a => a.value)
export const archetypeByValue = (v: string | null | undefined) => ARCHETYPES.find(a => a.value === v) ?? null

const BASE_CHANNELS: ChannelKey[] = ['gtm', 'ga4', 'meta_pixel']

/** Canali pertinenti per un archetipo; senza archetipo il set base. */
export function channelsFor(archetype: string | null | undefined): ChannelKey[] {
  return archetypeByValue(archetype)?.channels ?? BASE_CHANNELS
}

/**
 * Slot di chiave per cliente. Per Meta il token è d'agenzia: qui va l'Ad
 * Account ID del cliente. Vale lo stesso per Google Ads con il Customer ID.
 */
export const PLATFORMS: { key: PlatformKey; label: string; hint: string }[] = [
  { key: 'ga4', label: 'GA4', hint: 'Measurement ID / API secret' },
  { key: 'google_ads', label: 'Google Ads', hint: 'Customer ID, es. 123-456-7890' },
  { key: 'meta', label: 'Meta — Ad Account ID', hint: 'Ad Account ID, es. act_1234567890' },
  { key: 'klaviyo', label: 'Klaviyo', hint: 'Private API key' },
]
export const PLATFORM_KEYS = PLATFORMS.map(p => p.key)
export const isPlatformKey = (v: string): v is PlatformKey => PLATFORM_KEYS.includes(v as PlatformKey)

/** Menu per gli accessi, raggruppato come lo si cerca. Il campo accetta anche testo libero. */
export const ACCOUNT_SERVICES: { key: string; label: string; group: string }[] = [
  { key: 'instagram', label: 'Instagram', group: 'Social' },
  { key: 'facebook', label: 'Facebook', group: 'Social' },
  { key: 'meta_business', label: 'Meta Business Suite', group: 'Social' },
  { key: 'tiktok', label: 'TikTok', group: 'Social' },
  { key: 'linkedin', label: 'LinkedIn', group: 'Social' },
  { key: 'whatsapp_business', label: 'WhatsApp Business', group: 'Social' },
  { key: 'google_business', label: "Profilo dell'attività (Google)", group: 'Social' },
  { key: 'google_ads', label: 'Google Ads (account)', group: 'Ads e misurazione' },
  { key: 'analytics', label: 'Google Analytics', group: 'Ads e misurazione' },
  { key: 'search_console', label: 'Search Console', group: 'Ads e misurazione' },
  { key: 'gtm', label: 'Google Tag Manager', group: 'Ads e misurazione' },
  { key: 'google_merchant', label: 'Google Merchant Center', group: 'Ads e misurazione' },
  { key: 'gmail', label: 'Gmail / account Google', group: 'Email' },
  { key: 'webmail', label: 'Webmail', group: 'Email' },
  { key: 'brevo', label: 'Brevo (email marketing / SMTP)', group: 'Email' },
  { key: 'klaviyo', label: 'Klaviyo (account)', group: 'Email' },
  { key: 'mailchimp', label: 'Mailchimp', group: 'Email' },
  { key: 'tharvel', label: 'Tharvel (pannello sito)', group: 'Sito e infrastruttura' },
  { key: 'cms', label: 'CMS del sito (WordPress, ecc.)', group: 'Sito e infrastruttura' },
  { key: 'shopify', label: 'Shopify', group: 'Sito e infrastruttura' },
  { key: 'dominio', label: 'Dominio / registrar', group: 'Sito e infrastruttura' },
  { key: 'dns', label: 'DNS (Cloudflare, ecc.)', group: 'Sito e infrastruttura' },
  { key: 'hosting', label: 'Hosting / pannello', group: 'Sito e infrastruttura' },
  { key: 'ftp', label: 'FTP / SFTP', group: 'Sito e infrastruttura' },
  { key: 'stripe', label: 'Stripe', group: 'Pagamenti' },
  { key: 'paypal', label: 'PayPal', group: 'Pagamenti' },
  { key: 'altro', label: 'Altro', group: 'Altro' },
]
export const ACCOUNT_SERVICE_GROUPS = Array.from(new Set(ACCOUNT_SERVICES.map(s => s.group)))
export const accountServiceLabel = (key: string) => ACCOUNT_SERVICES.find(s => s.key === key)?.label ?? key

/**
 * Segreti d'agenzia per il reporting. `implemented: false` = connettore da
 * scrivere: la UI lo mostra come non attivo invece di fingere che funzioni.
 */
export const AGENCY_CREDENTIALS: {
  key: AgencyPlatformKey; label: string; kind: 'json' | 'text'; hint: string
  clientFieldLabel: string; clientFieldHint: string; implemented: boolean
}[] = [
  {
    key: 'ga4', label: 'GA4 — Service Account', kind: 'json',
    hint: 'Contenuto del file JSON della chiave del service account',
    clientFieldLabel: 'Property ID (tab Report del cliente)', clientFieldHint: 'Solo il numero, es. 123456789',
    implemented: true,
  },
  {
    key: 'meta', label: 'Meta — System User Token', kind: 'text',
    hint: 'Token del system user con accesso agli ad account',
    clientFieldLabel: 'Ad Account ID (tab Chiavi del cliente)', clientFieldHint: 'Es. act_1234567890',
    implemented: true,
  },
  {
    key: 'google_ads', label: 'Google Ads — Developer + refresh token', kind: 'json',
    hint: 'JSON con developer_token, client_id, client_secret, refresh_token',
    clientFieldLabel: 'Customer ID (tab Chiavi del cliente)', clientFieldHint: 'Es. 123-456-7890',
    implemented: false,
  },
]
export const AGENCY_CREDENTIAL_KEYS = AGENCY_CREDENTIALS.map(c => c.key)
export const isAgencyPlatformKey = (v: string): v is AgencyPlatformKey => AGENCY_CREDENTIAL_KEYS.includes(v as AgencyPlatformKey)

export const CMS_SUGGESTIONS = ['Shopify', 'WooCommerce', 'WordPress', 'PrestaShop', 'Magento', 'Wix', 'Squarespace', 'Custom']

export const QA_CHECKS: { key: QaCheckKey; label: string; needs: string }[] = [
  { key: 'gtm', label: 'GTM sul sito', needs: 'URL sito + ID container' },
  { key: 'ga4', label: 'Dati GA4 recenti', needs: 'Property ID + service account' },
  { key: 'meta_pixel', label: 'Meta Pixel', needs: 'URL sito + Pixel ID' },
]

export const QA_STATUSES: { value: QaStatus; label: string; tone: Tone }[] = [
  { value: 'ok', label: 'OK', tone: 'success' },
  { value: 'indeterminato', label: 'Indeterminato', tone: 'warning' },
  { value: 'problema', label: 'Problema', tone: 'error' },
  { value: 'na', label: 'N/A', tone: 'muted' },
]
export const qaStatusByValue = (v: string | null | undefined) => QA_STATUSES.find(s => s.value === v) ?? null

export const REPORT_SOURCES: { key: ReportSource; label: string }[] = [
  { key: 'ga4', label: 'GA4' },
  { key: 'klaviyo', label: 'Klaviyo' },
  { key: 'meta', label: 'Meta Ads' },
]

/** Il sottoinsieme di client_tracking che serve al badge. */
export type TrackingStatusRow = {
  archetype: string | null
  status_gtm: TrackingStatus
  status_ga4: TrackingStatus
  status_meta_pixel: TrackingStatus
  status_klaviyo: TrackingStatus
}

/**
 * Badge di sintesi, derivato e mai salvato: guarda solo i canali pertinenti
 * all'archetipo e ignora quelli `na`. Tutti attivi → active, almeno uno
 * avviato → partial, nessuno → todo.
 */
export function trackingBadge(row: TrackingStatusRow | null | undefined): TrackingStatus {
  if (!row) return 'todo'
  const values = channelsFor(row.archetype)
    .map(key => row[`status_${key}` as keyof TrackingStatusRow] as TrackingStatus | null)
    .filter((v): v is TrackingStatus => !!v && v !== 'na')
  if (values.length === 0) return 'todo'
  if (values.every(v => v === 'active')) return 'active'
  if (values.some(v => v === 'active' || v === 'partial')) return 'partial'
  return 'todo'
}

/** Classi Tailwind per un tono, come chip e come inchiostro. */
export const TONE_CHIP: Record<Tone, string> = {
  success: 'bg-success-dim text-success',
  warning: 'bg-warning-dim text-warning',
  error: 'bg-error-dim text-error',
  muted: 'bg-surface-active text-text-tertiary',
}
export const TONE_DOT: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  muted: 'bg-text-tertiary',
}
