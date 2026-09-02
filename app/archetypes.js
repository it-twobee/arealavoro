// Vocabolario condiviso backend/frontend: archetipi, canali di tracking, stati.
// Il frontend lo riceve via GET /api/meta, così esiste una sola fonte di verità.

/** Stati usati da tutti i campi status_* */
export const STATUSES = [
  { value: 'active', label: 'Attivo', dot: '🟢' },
  { value: 'partial', label: 'Parziale', dot: '🟡' },
  { value: 'todo', label: 'Da fare', dot: '🔴' },
  { value: 'na', label: 'Non applicabile', dot: '⚪' },
];

export const STATUS_VALUES = STATUSES.map((s) => s.value);

/** Canali di tracking gestiti. La chiave corrisponde alla colonna status_<key>. */
export const CHANNELS = [
  { key: 'gtm', label: 'Google Tag Manager' },
  { key: 'ga4', label: 'GA4' },
  { key: 'meta_pixel', label: 'Meta Pixel' },
  { key: 'klaviyo', label: 'Klaviyo' },
];

export const CHANNEL_KEYS = CHANNELS.map((c) => c.key);

/**
 * Archetipi cliente. `channels` = canali rilevanti per quell'archetipo
 * (gli altri vengono precompilati a 'na' alla creazione).
 * `templateDir` punta alla cartella in tracking-templates/ (usata dal modulo 3).
 */
export const ARCHETYPES = [
  {
    value: 'ecommerce',
    label: 'E-commerce',
    templateDir: 'ecommerce-shopify',
    channels: ['gtm', 'ga4', 'meta_pixel', 'klaviyo'],
  },
  {
    value: 'leadgen-b2b',
    label: 'Lead gen B2B',
    templateDir: 'leadgen-b2b',
    channels: ['gtm', 'ga4', 'meta_pixel'],
  },
  {
    value: 'hospitality',
    label: 'Hospitality',
    templateDir: 'hospitality',
    channels: ['gtm', 'ga4', 'meta_pixel'],
  },
];

export const ARCHETYPE_VALUES = ARCHETYPES.map((a) => a.value);

/**
 * Piattaforme per cui si conserva una credenziale cifrata (modulo 2).
 * La chiave finisce nella colonna `platform` della tabella credentials.
 */
export const PLATFORMS = [
  { key: 'ga4', label: 'GA4', hint: 'Measurement ID / API secret' },
  { key: 'google_ads', label: 'Google Ads', hint: 'Customer ID, es. 123-456-7890' },
  // Il token di accesso Meta è uno solo per tutta l'agenzia e sta in
  // Impostazioni: qui serve l'identificativo dell'ad account di questo cliente.
  { key: 'meta', label: 'Meta — Ad Account ID', hint: 'Ad Account ID, es. act_1234567890' },
  { key: 'klaviyo', label: 'Klaviyo', hint: 'Private API key' },
];

export const PLATFORM_KEYS = PLATFORMS.map((p) => p.key);

/**
 * Servizi suggeriti per gli accessi ad account di un cliente (utente+password).
 * È un elenco di comodo, non una gabbia: `service` accetta qualsiasi testo, così
 * si aggiunge un servizio nuovo senza toccare il codice.
 */
export const ACCOUNT_SERVICES = [
  { key: 'instagram', label: 'Instagram', icon: '📷' },
  { key: 'facebook', label: 'Facebook', icon: '👍' },
  { key: 'meta_business', label: 'Meta Business Suite', icon: '🏢' },
  { key: 'tiktok', label: 'TikTok', icon: '🎵' },
  { key: 'linkedin', label: 'LinkedIn', icon: '💼' },
  { key: 'gmail', label: 'Gmail / account Google', icon: '✉️' },
  { key: 'webmail', label: 'Webmail', icon: '📬' },
  { key: 'dominio', label: 'Dominio / registrar', icon: '🌐' },
  { key: 'hosting', label: 'Hosting / pannello', icon: '🗄️' },
  { key: 'cms', label: 'CMS del sito', icon: '⚙️' },
  { key: 'shopify', label: 'Shopify', icon: '🛍️' },
  { key: 'klaviyo', label: 'Klaviyo (account)', icon: '📨' },
  { key: 'google_ads', label: 'Google Ads (account)', icon: '🅖' },
  { key: 'google_business', label: "Profilo dell'attività", icon: '📍' },
  { key: 'analytics', label: 'Google Analytics', icon: '📊' },
  { key: 'search_console', label: 'Search Console', icon: '🔎' },
  { key: 'gtm', label: 'Google Tag Manager', icon: '🏷️' },
  { key: 'altro', label: 'Altro', icon: '🔑' },
];

export function accountServiceByKey(key) {
  return ACCOUNT_SERVICES.find((s) => s.key === key) ?? null;
}

/**
 * Segreti a livello agenzia per il reporting via API (modulo 4). Sono una copia
 * per tutto il portafoglio; il dato che cambia da cliente a cliente è solo
 * l'identificativo in `clientField`, che non è segreto.
 * `implemented: false` = connettore ancora da scrivere: la UI lo mostra ma non
 * lo lascia usare, invece di far finta che funzioni.
 */
export const AGENCY_CREDENTIALS = [
  {
    key: 'ga4',
    label: 'GA4 — Service Account',
    kind: 'json',
    hint: 'Contenuto del file JSON della chiave del service account',
    clientField: 'ga4_property_id',
    clientFieldLabel: 'Property ID',
    clientFieldHint: 'Solo il numero, es. 123456789',
    implemented: true,
  },
  {
    key: 'google_ads',
    label: 'Google Ads — Developer + refresh token',
    kind: 'json',
    hint: 'JSON con developer_token, client_id, client_secret, refresh_token',
    clientField: 'google_ads_customer_id',
    clientFieldLabel: 'Customer ID',
    clientFieldHint: 'Es. 123-456-7890',
    implemented: false,
  },
  {
    // Un solo token per tutta l'agenzia. L'Ad Account ID cambia da cliente a
    // cliente e si inserisce nella scheda Chiavi del cliente, non qui.
    key: 'meta',
    label: 'Meta — System User Token',
    kind: 'text',
    hint: 'Token del system user con accesso agli ad account',
    clientField: 'meta_ad_account_id',
    clientFieldLabel: 'Ad Account ID (nella scheda Chiavi del cliente)',
    clientFieldHint: 'Es. act_1234567890',
    implemented: true,
  },
];

export const AGENCY_CREDENTIAL_KEYS = AGENCY_CREDENTIALS.map((c) => c.key);

export function agencyCredentialByKey(key) {
  return AGENCY_CREDENTIALS.find((c) => c.key === key) ?? null;
}

/** Suggerimenti per il campo CMS. */
export const CMS_SUGGESTIONS = [
  'Shopify',
  'WooCommerce',
  'WordPress',
  'PrestaShop',
  'Magento',
  'Wix',
  'Squarespace',
  'Custom',
];

export function archetypeByValue(value) {
  return ARCHETYPES.find((a) => a.value === value) ?? null;
}

/** Canali rilevanti per un archetipo; senza archetipo assegnato usa il set base. */
export function channelsFor(archetype) {
  return archetypeByValue(archetype)?.channels ?? ['gtm', 'ga4', 'meta_pixel'];
}

/**
 * Badge di sintesi mostrato nella lista clienti.
 * Considera solo i canali rilevanti e non marcati 'na'.
 * GSC resta fuori: è SEO, non tracking.
 */
export function trackingBadge(client) {
  const values = channelsFor(client.archetype)
    .map((key) => client[`status_${key}`])
    .filter((v) => v && v !== 'na');

  if (values.length === 0) return 'todo';
  if (values.every((v) => v === 'active')) return 'active';
  if (values.some((v) => v === 'active' || v === 'partial')) return 'partial';
  return 'todo';
}

export const meta = {
  statuses: STATUSES,
  channels: CHANNELS,
  archetypes: ARCHETYPES,
  cmsSuggestions: CMS_SUGGESTIONS,
  platforms: PLATFORMS,
  agencyCredentials: AGENCY_CREDENTIALS,
  accountServices: ACCOUNT_SERVICES,
};
