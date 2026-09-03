// Vocabolario condiviso backend/frontend: archetipi, canali, stati, piattaforme.
//
// La fonte è lib/tracking/vocab.ts, la stessa del CRM. Qui si riesporta tutto
// e si ricostruisce l'oggetto `meta` che il frontend riceve da GET /api/meta,
// nella forma che la UI vanilla si aspetta: il vocabolario parla di "toni"
// (success/warning/error/muted), la UI vuole le emoji dei pallini e le icone
// dei servizi. Quelle mappe restano qui, perché sono un dettaglio di questa UI.

export * from '../lib/tracking/vocab.ts';

import {
  ACCOUNT_SERVICES,
  AGENCY_CREDENTIALS,
  ARCHETYPES,
  CHANNELS,
  CMS_SUGGESTIONS,
  PLATFORMS,
  STATUSES,
} from '../lib/tracking/vocab.ts';

/** Tono semantico del vocabolario → emoji del pallino nella UI. */
export const TONE_EMOJI = {
  success: '🟢',
  warning: '🟡',
  error: '🔴',
  muted: '⚪',
};

/** Icone dei servizi per il menu degli accessi. Chi manca prende 🔑. */
const SERVICE_ICONS = {
  instagram: '📷',
  facebook: '👍',
  meta_business: '🏢',
  tiktok: '🎵',
  linkedin: '💼',
  whatsapp_business: '💬',
  google_business: '📍',
  google_ads: '🅖',
  analytics: '📊',
  search_console: '🔎',
  gtm: '🏷️',
  google_merchant: '🛒',
  gmail: '✉️',
  webmail: '📬',
  brevo: '📮',
  klaviyo: '📨',
  mailchimp: '🐵',
  tharvel: '🧩',
  cms: '⚙️',
  shopify: '🛍️',
  dominio: '🌐',
  dns: '🧭',
  hosting: '🗄️',
  ftp: '📁',
  stripe: '💳',
  paypal: '🅿️',
  altro: '🔑',
};

/** Stati con il pallino: la UI li usa nelle select e nei badge. */
export const STATUSES_WITH_DOT = STATUSES.map((s) => ({ ...s, dot: TONE_EMOJI[s.tone] ?? '⚪' }));

/** Servizi con l'icona per il menu. */
export const ACCOUNT_SERVICES_WITH_ICON = ACCOUNT_SERVICES.map((s) => ({
  ...s,
  icon: SERVICE_ICONS[s.key] ?? '🔑',
}));

export function accountServiceByKey(key) {
  return ACCOUNT_SERVICES_WITH_ICON.find((s) => s.key === key) ?? null;
}

export function agencyCredentialByKey(key) {
  return AGENCY_CREDENTIALS.find((c) => c.key === key) ?? null;
}

export const meta = {
  statuses: STATUSES_WITH_DOT,
  channels: CHANNELS,
  // `templateDir` è il nome storico di `templateKey`: la UI lo legge così.
  archetypes: ARCHETYPES.map((a) => ({ ...a, templateDir: a.templateKey })),
  cmsSuggestions: CMS_SUGGESTIONS,
  platforms: PLATFORMS,
  agencyCredentials: AGENCY_CREDENTIALS,
  accountServices: ACCOUNT_SERVICES_WITH_ICON,
};
