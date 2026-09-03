/* Verifica del client Meta (parte pura). Esegui: npx tsx lib/tracking/meta.check.ts */
import { normalizeAdAccount, classifyAction, isConversionAction, selectConversions, ctrToFraction, CONVERSION_EVENTS } from '@/lib/tracking/meta'
import { isTrackingError } from '@/lib/tracking/errors'

let fail = 0
const is = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'OK ' : 'NO '} ${label.padEnd(58)} ${JSON.stringify(got)}${ok ? '' : `  atteso ${JSON.stringify(want)}`}`)
}
const throwsStatus = (fn: () => unknown): number | null => {
  try { fn(); return null } catch (e) { return isTrackingError(e) ? e.status : -1 }
}

// normalizeAdAccount
is('solo cifre → act_', normalizeAdAccount('1234567890'), 'act_1234567890')
is('act_ già presente: invariato', normalizeAdAccount('act_1234567890'), 'act_1234567890')
is('spazi attorno ignorati', normalizeAdAccount('  act_1234567890  '), 'act_1234567890')
is('ACT_ maiuscolo accettato', normalizeAdAccount('ACT_1234567890'), 'act_1234567890')
is('troppo corto → 400', throwsStatus(() => normalizeAdAccount('123')), 400)
is('lettere → 400', throwsStatus(() => normalizeAdAccount('act_12ab567')), 400)
is('vuoto → 400', throwsStatus(() => normalizeAdAccount('')), 400)
is('null → 400', throwsStatus(() => normalizeAdAccount(null)), 400)

// classifyAction
is('pixel → evento + specificità 2', classifyAction('offsite_conversion.fb_pixel_lead'), { evento: 'lead', specificita: 2 })
is('onsite → evento + specificità 1', classifyAction('onsite_conversion.lead_grouped'), { evento: 'lead_grouped', specificita: 1 })
is('forma normalizzata → specificità 0', classifyAction('lead'), { evento: 'lead', specificita: 0 })
is('link_click resta com\'è', classifyAction('link_click'), { evento: 'link_click', specificita: 0 })

// isConversionAction
is('nove eventi di conversione', CONVERSION_EVENTS.size, 9)
is('lead è conversione', isConversionAction('lead'), true)
is('pixel purchase è conversione', isConversionAction('offsite_conversion.fb_pixel_purchase'), true)
is('pixel view_content NON è conversione', isConversionAction('offsite_conversion.fb_pixel_view_content'), false)
is('link_click NON è conversione', isConversionAction('link_click'), false)
is('onsite lead_grouped NON è conversione (nome diverso)', isConversionAction('onsite_conversion.lead_grouped'), false)

// selectConversions su un elenco realistico: lo stesso lead su più livelli
const azioni: [string, number][] = [
  ['link_click', 1500],
  ['post_engagement', 2074],
  ['landing_page_view', 900],
  ['offsite_conversion.fb_pixel_view_content', 700],
  ['lead', 87],
  ['offsite_conversion.fb_pixel_lead', 87],
  ['onsite_conversion.lead_grouped', 87],
  ['onsite_conversion.lead', 3],
  ['purchase', 12],
  ['offsite_conversion.fb_pixel_purchase', 12],
  ['omni_purchase', 12],
]
const scelta = selectConversions(azioni)
is('totale = lead pixel + purchase pixel', scelta.totale, 99)
is('una voce per evento, la più specifica',
  [...scelta.actionTypes].sort(), ['offsite_conversion.fb_pixel_lead', 'offsite_conversion.fb_pixel_purchase'])
is('nessuna non-conversione fra le scelte',
  scelta.actionTypes.some(a => ['link_click', 'post_engagement', 'landing_page_view', 'offsite_conversion.fb_pixel_view_content', 'omni_purchase'].includes(a)), false)

// ordine d'arrivo irrilevante: la specificità decide
is('pixel prima della forma normalizzata: stessa scelta',
  selectConversions([['offsite_conversion.fb_pixel_lead', 87], ['lead', 90]] as const).actionTypes, ['offsite_conversion.fb_pixel_lead'])
is('onsite batte la forma normalizzata',
  selectConversions([['lead', 90], ['onsite_conversion.lead', 3]] as const).actionTypes, ['onsite_conversion.lead'])
is('a parità di specificità vince la prima',
  selectConversions([['lead', 90], ['lead', 5]] as const), { totale: 90, actionTypes: ['lead'] })
is('solo forma normalizzata: contata', selectConversions([['contact', 4], ['link_click', 10]] as const), { totale: 4, actionTypes: ['contact'] })
is('nessuna conversione → 0', selectConversions([['link_click', 10]] as const), { totale: 0, actionTypes: [] })
is('elenco vuoto → 0', selectConversions([]), { totale: 0, actionTypes: [] })
is('accetta una Map', selectConversions(new Map([['purchase', 2]])), { totale: 2, actionTypes: ['purchase'] })

// CTR: Meta lo dà in percentuale, il sistema lo vuole in frazione
is('ctr 1.23 → 0.0123', ctrToFraction('1.23'), 0.0123)
is('ctr numerico', ctrToFraction(2.5), 0.025)
is('ctr assente → 0', ctrToFraction(undefined), 0)
is('ctr non numerico → 0', ctrToFraction('n/a'), 0)

console.log(fail ? `\n${fail} controlli falliti` : '\nTutti i controlli passano')
process.exit(fail ? 1 : 0)
