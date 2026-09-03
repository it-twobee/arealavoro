/* Verifica dei controlli QA puri. Esegui: npx tsx lib/tracking/qa-checks.check.ts */
import {
  summarize, checkGtm, checkMetaPixel, evaluatePixels, evaluateGa4, promotionsFor, viewsFor, NO_SITE, type QaTarget, type QaSite,
} from '@/lib/tracking/qa-checks'

let fail = 0
const is = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'OK ' : 'NO '} ${label.padEnd(58)} ${JSON.stringify(got)}${ok ? '' : `  atteso ${JSON.stringify(want)}`}`)
}

type R = Parameters<typeof summarize>[0][number]
const r = (client_id: string, check_key: R['check_key'], status: R['status'], checked_at = '2026-09-01T07:00:00Z'): R =>
  ({ client_id, check_key, status, detail: `${check_key}:${status}`, checked_at })

const s = summarize([
  r('a', 'gtm', 'ok'), r('a', 'ga4', 'ok'), r('a', 'meta_pixel', 'indeterminato'),
  r('b', 'gtm', 'ok'), r('b', 'ga4', 'problema'), r('b', 'meta_pixel', 'na', '2026-09-02T07:00:00Z'),
  r('c', 'gtm', 'na'), r('c', 'ga4', 'na'), r('c', 'meta_pixel', 'na'),
  r('d', 'gtm', 'indeterminato'), r('d', 'ga4', 'na'), r('d', 'meta_pixel', 'indeterminato'),
])

is('a: ok + indeterminato → ok', s.get('a')?.status, 'ok')
is('a: due verificati', s.get('a')?.verified, 2)
is('b: un problema → problema', s.get('b')?.status, 'problema')
is('b: dettaglio del problema', s.get('b')?.problems, [{ key: 'ga4', detail: 'ga4:problema' }])
is('b: data più recente', s.get('b')?.checkedAt, '2026-09-02T07:00:00Z')
is('c: tutto na → na, non verde', s.get('c')?.status, 'na')
is('d: solo indeterminati → na', s.get('d')?.status, 'na')
is('cliente mai controllato assente', s.has('e'), false)

const t = (o: Partial<QaTarget>): QaTarget => ({ website: 'https://sito.it/', gtm_container_id: 'GTM-ABC1234', meta_pixel_id: '1234567890123456', ga4_property_id: '123456789', ...o })
const site = (o: Partial<QaSite['tags']>, ok = true): QaSite => ({ ok, error: ok ? null : 'Sito non raggiungibile: timeout', tags: { gtmIds: [], metaIds: [], ...o } })

is('gtm: senza URL → na', checkGtm(t({ website: null }), NO_SITE).status, 'na')
is('gtm: senza container → na', checkGtm(t({ gtm_container_id: '' }), site({})).status, 'na')
is('gtm: sito giù → problema', checkGtm(t({}), site({}, false)).status, 'problema')
is('gtm: trovato → ok', checkGtm(t({}), site({ gtmIds: ['GTM-ABC1234'] })).status, 'ok')
is('gtm: minuscolo in scheda → ok', checkGtm(t({ gtm_container_id: 'gtm-abc1234' }), site({ gtmIds: ['GTM-ABC1234'] })).status, 'ok')
is('gtm: altro container → problema con dettaglio', checkGtm(t({}), site({ gtmIds: ['GTM-ZZZ9999'] })).detail.includes('GTM-ZZZ9999'), true)
is('gtm: nessuno → problema', checkGtm(t({}), site({})).status, 'problema')

is('pixel: senza id → na', checkMetaPixel(t({ meta_pixel_id: '' }), site({})).status, 'na')
is('pixel: trovato → ok', checkMetaPixel(t({}), site({ metaIds: ['1234567890123456'] })).status, 'ok')
is('pixel: diverso → problema anche con GTM', checkMetaPixel(t({}), site({ metaIds: ['9'], gtmIds: ['GTM-X'] })).status, 'problema')
is('pixel: assente ma GTM presente → indeterminato', checkMetaPixel(t({}), site({ gtmIds: ['GTM-QUALSIASI'] })).status, 'indeterminato')
is('pixel: assente senza GTM → problema', checkMetaPixel(t({}), site({})).status, 'problema')

const now = Date.parse('2026-09-03T08:00:00Z')
is('pixel api: nessun pixel → problema', evaluatePixels([], now).status, 'problema')
is('pixel api: eventi recenti → ok', evaluatePixels([{ id: '1', name: 'Px', lastFiredTime: '2026-09-02T20:00:00Z' }], now).status, 'ok')
is('pixel api: eventi vecchi → problema', evaluatePixels([{ id: '1', name: 'Px', lastFiredTime: '2026-08-20T20:00:00Z' }], now).status, 'problema')
is('pixel api: mai → problema', evaluatePixels([{ id: '1', name: 'Px', lastFiredTime: null }], now).detail, 'Il pixel non ha mai ricevuto eventi')

is('ga4: dati → ok', evaluateGa4([{ metrics: { sessions: 12, eventCount: 40 } }], '1').status, 'ok')
is('ga4: zero → problema', evaluateGa4([{ metrics: { sessions: 0, eventCount: 0 } }], '1').status, 'problema')
is('ga4: nessuna riga → problema', evaluateGa4([], '1').status, 'problema')

const ok = { status: 'ok' as const, detail: '' }, no = { status: 'problema' as const, detail: '' }
is('promozione: solo i canali ok, mai na',
  promotionsFor({ status_gtm: 'todo', status_ga4: 'na', status_meta_pixel: 'partial' }, { gtm: ok, ga4: ok, meta_pixel: ok }),
  { status_gtm: 'active', status_meta_pixel: 'active' })
is('promozione: già active non cambia',
  promotionsFor({ status_gtm: 'active', status_ga4: 'todo', status_meta_pixel: 'todo' }, { gtm: ok, ga4: no, meta_pixel: no }), {})

is('viste: mai controllato', viewsFor([]).map(v => v.status), [null, null, null])
is('viste: ordine dei controlli', viewsFor([r('a', 'meta_pixel', 'ok')]).map(v => `${v.key}:${v.status}`), ['gtm:null', 'ga4:null', 'meta_pixel:ok'])

console.log(fail ? `\n${fail} controlli falliti` : '\nTutti i controlli passano')
process.exit(fail ? 1 : 0)
