/* Verifica del vocabolario tracking. Esegui: npx tsx lib/tracking/vocab.check.ts */
import { trackingBadge, channelsFor, ARCHETYPES, PLATFORMS, AGENCY_CREDENTIALS, type TrackingStatusRow } from '@/lib/tracking/vocab'

let fail = 0
const is = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'OK ' : 'NO '} ${label.padEnd(58)} ${JSON.stringify(got)}${ok ? '' : `  atteso ${JSON.stringify(want)}`}`)
}

const row = (o: Partial<TrackingStatusRow>): TrackingStatusRow => ({
  archetype: null, status_gtm: 'todo', status_ga4: 'todo', status_meta_pixel: 'todo', status_klaviyo: 'todo', ...o,
})

is('senza riga → todo', trackingBadge(null), 'todo')
is('senza archetipo: set base gtm/ga4/meta', channelsFor(null), ['gtm', 'ga4', 'meta_pixel'])
is('ecommerce include klaviyo', channelsFor('ecommerce'), ['gtm', 'ga4', 'meta_pixel', 'klaviyo'])
is('archetipo ignoto: set base', channelsFor('boh'), ['gtm', 'ga4', 'meta_pixel'])

is('tutti todo → todo', trackingBadge(row({})), 'todo')
is('tutti active → active', trackingBadge(row({ status_gtm: 'active', status_ga4: 'active', status_meta_pixel: 'active' })), 'active')
is('uno partial → partial', trackingBadge(row({ status_gtm: 'partial' })), 'partial')
is('uno active, altri todo → partial', trackingBadge(row({ status_ga4: 'active' })), 'partial')
is('na ignorati: gtm+ga4 active, meta na → active',
  trackingBadge(row({ status_gtm: 'active', status_ga4: 'active', status_meta_pixel: 'na' })), 'active')
is('tutti na → todo', trackingBadge(row({ status_gtm: 'na', status_ga4: 'na', status_meta_pixel: 'na' })), 'todo')
is('leadgen: klaviyo non conta',
  trackingBadge(row({ archetype: 'leadgen-b2b', status_gtm: 'active', status_ga4: 'active', status_meta_pixel: 'active', status_klaviyo: 'todo' })), 'active')
is('ecommerce: klaviyo conta',
  trackingBadge(row({ archetype: 'ecommerce', status_gtm: 'active', status_ga4: 'active', status_meta_pixel: 'active', status_klaviyo: 'todo' })), 'partial')

is('tre archetipi', ARCHETYPES.map(a => a.value), ['ecommerce', 'leadgen-b2b', 'hospitality'])
is('quattro slot chiave', PLATFORMS.map(p => p.key), ['ga4', 'google_ads', 'meta', 'klaviyo'])
is('google_ads agenzia non implementato', AGENCY_CREDENTIALS.find(c => c.key === 'google_ads')?.implemented, false)

console.log(fail ? `\n${fail} controlli falliti` : '\nTutti i controlli passano')
process.exit(fail ? 1 : 0)
