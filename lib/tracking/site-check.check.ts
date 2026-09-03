/* Verifica di site-check (rilevamento tag e politica di aggiornamento). Esegui: npx tsx lib/tracking/site-check.check.ts */
import { assertPublicHost, detectTags, evaluate, type EvaluationInput, type FoundTags } from '@/lib/tracking/site-check'
import { isTrackingError } from '@/lib/tracking/errors'

let fail = 0
const is = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'OK ' : 'NO '} ${label.padEnd(64)} ${JSON.stringify(got)}${ok ? '' : `  atteso ${JSON.stringify(want)}`}`)
}
const throws = (label: string, fn: () => void, status: number) => {
  let got: unknown = null
  try { fn() } catch (e) { got = isTrackingError(e) ? e.status : String(e) }
  is(label, got, status)
}

const FIXTURE = `<!doctype html><html><head>
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});
var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;
j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-ABC1234');</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXX"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-XXXXXXX');</script>
<script>!function(f,b,e,v,n,t,s){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1234567890123456');fbq('track','PageView');</script>
<script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=ABC123"></script>
</head><body>
<noscript id="gtm-noscript"><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-ABC1234"></iframe></noscript>
<div class="gtm-script"></div>
<footer>powered by klaviyo</footer>
</body></html>`

// --- detectTags
const found = detectTags(FIXTURE)
is('GTM: solo il container vero, una volta', found.gtmIds, ['GTM-ABC1234'])
is('GA4: measurement id', found.ga4Ids, ['G-XXXXXXX'])
is('GA4: gtag.js caricato', found.gtagLoaded, true)
is('Meta: pixel id da fbq init', found.metaIds, ['1234567890123456'])
is('Meta: fbevents.js', found.fbevents, true)
is('Klaviyo: script con company_id', found.klaviyo, true)

is('attributi gtm-noscript/gtm-script non contano', detectTags('<div id="gtm-noscript" class="gtm-script"></div>').gtmIds, [])
is('GTM-NOSCRIPT maiuscolo in blocklist', detectTags('<div id="GTM-NOSCRIPT" class="GTM-SCRIPT"></div>').gtmIds, [])
is('gtm-abc1234 minuscolo non conta (case-sensitive)', detectTags("'gtm-abc1234'").gtmIds, [])
is('"powered by klaviyo" da solo non conta', detectTags('<footer>powered by klaviyo</footer>').klaviyo, false)
is('_learnq conta', detectTags('<script>var _learnq=_learnq||[];</script>').klaviyo, true)
is('pixel via img di fallback', detectTags('<img src="https://www.facebook.com/tr?id=9876543210&ev=PageView"/>').metaIds, ['9876543210'])
is('HTML vuoto: niente trovato', detectTags(''), { gtmIds: [], ga4Ids: [], gtagLoaded: false, metaIds: [], fbevents: false, klaviyo: false })

// --- assertPublicHost
throws('localhost rifiutato', () => assertPublicHost('http://localhost:3000/'), 400)
throws('10.x rifiutato', () => assertPublicHost('https://10.0.0.5/'), 400)
throws('172.16-31 rifiutato', () => assertPublicHost('https://172.20.1.1/'), 400)
throws('169.254 rifiutato', () => assertPublicHost('https://169.254.169.254/'), 400)
throws('[::1] rifiutato', () => assertPublicHost('http://[::1]/'), 400)
is('host pubblico passa', (() => { assertPublicHost('https://www.example.com/'); return 'ok' })(), 'ok')
is('172.32 è pubblico', (() => { assertPublicHost('https://172.32.0.1/'); return 'ok' })(), 'ok')

// --- evaluate
const none: FoundTags = { gtmIds: [], ga4Ids: [], gtagLoaded: false, metaIds: [], fbevents: false, klaviyo: false }
const withGtm: FoundTags = { ...none, gtmIds: ['GTM-ABC1234'] }
const row = (o: Partial<EvaluationInput> = {}): EvaluationInput => ({
  archetype: 'ecommerce', gtm_container_id: 'GTM-ABC1234', meta_pixel_id: '',
  status_gtm: 'todo', status_ga4: 'todo', status_meta_pixel: 'todo', status_klaviyo: 'todo', ...o,
})
const fields = (r: ReturnType<typeof evaluate>) => r.changes.map(c => `${c.field}:${c.from}>${c.to}`)

let r = evaluate(row(), withGtm)
is('GTM configurato e trovato → active', fields(r), ['status_gtm:todo>active'])
is('  reason cita il container', r.changes[0]?.reason, 'Container GTM-ABC1234 presente sul sito')
is('  gtmPresente', r.gtmPresente, true)

r = evaluate(row({ status_gtm: 'active' }), none)
is('GTM configurato e assente → declassato a todo', fields(r), ['status_gtm:active>todo'])
is('  reason di assenza', r.changes[0]?.reason, 'Nessuno snippet GTM trovato nel sorgente della homepage')
is('  gtmPresente false', r.gtmPresente, false)

r = evaluate(row({ status_gtm: 'active' }), { ...none, gtmIds: ['GTM-ZZZ9999'] })
is('GTM diverso → partial + nota', fields(r), ['status_gtm:active>partial'])
is('  nota disallineamento', r.notes[0], 'Disallineamento container: in scheda GTM-ABC1234, sul sito GTM-ZZZ9999.')

r = evaluate(row({ gtm_container_id: '' }), withGtm)
is('GTM trovato ma non in scheda → partial + nota', fields(r), ['status_gtm:todo>partial'])
is('  nota invita a salvarlo', r.notes[0]?.includes('Salvalo nel campo'), true)

r = evaluate(row({ gtm_container_id: 'gtm-abc1234' }), withGtm)
is('container in scheda minuscolo viene confrontato maiuscolo', fields(r), ['status_gtm:todo>active'])

r = evaluate(row({ status_gtm: 'active' }), withGtm)
is('GTM già active e trovato → nessuna modifica', fields(r), [])

r = evaluate(row({ status_gtm: 'active', status_ga4: 'todo' }), withGtm)
is('GA4 non trovato con GTM presente → nessuna modifica', fields(r).filter(f => f.startsWith('status_ga4')), [])
is('  nota GA4 via GTM + Data API', r.notes.some(n => n.startsWith('GA4 non compare') && n.includes('Data API')), true)
is('  note anche per Meta e Klaviyo', r.notes.length, 3)

r = evaluate(row({ status_gtm: 'active', status_ga4: 'active' }), none)
is('GA4 active, niente GTM né GA4 → nessuna modifica, nota da controllare',
  [fields(r).filter(f => f.startsWith('status_ga4')), r.notes.some(n => n.startsWith('GA4 è segnato attivo'))], [[], true])

r = evaluate(row({ status_gtm: 'active' }), { ...withGtm, ga4Ids: ['G-XXXXXXX'] })
is('GA4 trovato → active', fields(r), ['status_ga4:todo>active'])
is('  reason con Measurement ID', r.changes[0]?.reason, 'Measurement ID G-XXXXXXX nel sorgente')

r = evaluate(row({ status_gtm: 'active' }), { ...withGtm, gtagLoaded: true })
is('gtag.js senza ID → active con reason gtag', r.changes[0]?.reason, 'gtag.js caricato direttamente nel sorgente')

r = evaluate(row({ status_gtm: 'active', status_ga4: 'active' }), { ...none, ga4Ids: ['G-XXXXXXX'] })
is('GA4 già active e trovato → niente', fields(r).filter(f => f.startsWith('status_ga4')), [])

r = evaluate(row({ status_gtm: 'active', status_ga4: 'active' }), { ...withGtm, metaIds: ['1234567890123456'] })
is('pixel senza id in scheda → active', fields(r), ['status_meta_pixel:todo>active'])

r = evaluate(row({ status_gtm: 'active', status_ga4: 'active', meta_pixel_id: '1234567890123456' }), { ...withGtm, metaIds: ['1234567890123456'], fbevents: true })
is('pixel id combacia → active', fields(r), ['status_meta_pixel:todo>active'])
is('  reason con Pixel ID', r.changes[0]?.reason, 'Pixel 1234567890123456 nel sorgente')

r = evaluate(row({ status_gtm: 'active', status_ga4: 'active', meta_pixel_id: '1234567890123456' }), { ...withGtm, metaIds: ['9999999999999999'], fbevents: true })
is('pixel diverso → nessuna modifica', fields(r), [])
is('  nota disallineamento Pixel', r.notes.some(n => n === 'Disallineamento Pixel: in scheda 1234567890123456, sul sito 9999999999999999.'), true)

r = evaluate(row({ status_gtm: 'active', status_ga4: 'active', meta_pixel_id: '1234567890123456' }), { ...withGtm, fbevents: true })
is('pixel id in scheda, solo fbevents.js → active', fields(r), ['status_meta_pixel:todo>active'])

r = evaluate(row({ status_gtm: 'active', status_ga4: 'active', status_meta_pixel: 'active' }), { ...withGtm, klaviyo: true })
is('klaviyo trovato (ecommerce) → active', fields(r), ['status_klaviyo:todo>active'])

r = evaluate(row({ status_gtm: 'active', status_ga4: 'active', status_meta_pixel: 'active', status_klaviyo: 'na' }), { ...withGtm, klaviyo: true })
is('klaviyo na → non toccato anche se trovato', [fields(r), r.notes.some(n => n.includes('Klaviyo'))], [[], false])

r = evaluate(row({ archetype: 'leadgen-b2b', status_gtm: 'active', status_ga4: 'active', status_meta_pixel: 'active' }), { ...withGtm, klaviyo: true })
is('leadgen: klaviyo fuori archetipo → né modifica né nota', [fields(r), r.notes.some(n => n.includes('Klaviyo'))], [[], false])

r = evaluate(row({ archetype: null, status_gtm: 'active', status_ga4: 'active', status_meta_pixel: 'active' }), { ...withGtm, klaviyo: true })
is('senza archetipo: set base, klaviyo non toccato', fields(r), [])

r = evaluate(row({ status_gtm: 'na', status_ga4: 'na', status_meta_pixel: 'na', status_klaviyo: 'na' }), { ...withGtm, ga4Ids: ['G-XXXXXXX'], metaIds: ['1234567890123456'], klaviyo: true })
is('tutti na → niente, nemmeno note', [fields(r), r.notes], [[], []])

r = evaluate(row({ status_gtm: 'active', status_ga4: 'active', status_meta_pixel: 'active', status_klaviyo: 'active' }), none)
is('pagina vuota, tutto active: solo GTM scende, gli altri notano', [fields(r), r.notes.length], [['status_gtm:active>todo'], 3])

r = evaluate(row(), none)
is('pagina vuota, tutto todo: nessuna modifica e nessuna nota', [fields(r), r.notes, r.gtmPresente], [[], [], false])

// fixture intera contro una scheda coerente
r = evaluate(row({ meta_pixel_id: '1234567890123456' }), detectTags(FIXTURE))
is('fixture completa: quattro promozioni, zero note',
  [fields(r), r.notes], [['status_gtm:todo>active', 'status_ga4:todo>active', 'status_meta_pixel:todo>active', 'status_klaviyo:todo>active'], []])

console.log(fail ? `\n${fail} controlli falliti` : '\nTutti i controlli passano')
process.exit(fail ? 1 : 0)
