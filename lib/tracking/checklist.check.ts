/* Verifica delle checklist di tracking. Esegui: npx tsx lib/tracking/checklist.check.ts */
import { EMPTY_CHECKLIST, hasItem, listTemplates, mergeChecklist, templateFor } from '@/lib/tracking/checklist'
import { isTrackingError } from '@/lib/tracking/errors'

let fail = 0
const is = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'OK ' : 'NO '} ${label.padEnd(58)} ${JSON.stringify(got)}${ok ? '' : `  atteso ${JSON.stringify(want)}`}`)
}

const count = (archetype: string) => templateFor(archetype)?.sections.reduce((n, s) => n + s.items.length, 0) ?? null

is('tre template caricati', listTemplates().map(t => t.archetype), ['ecommerce', 'leadgen-b2b', 'hospitality'])
is('voci e-commerce', count('ecommerce'), 27)
is('voci lead gen B2B', count('leadgen-b2b'), 25)
is('voci hospitality', count('hospitality'), 22)
is('listTemplates: totalItems coerente', listTemplates().map(t => t.totalItems), [27, 25, 22])
is('listTemplates: sezioni sommano a totalItems',
  listTemplates().map(t => t.sections.reduce((n, s) => n + s.items, 0)), [27, 25, 22])
is('archetipo null → null', templateFor(null), null)
is('archetipo ignoto → null', templateFor('boh'), null)
is('memoizzato: stessa istanza', templateFor('ecommerce') === templateFor('ecommerce'), true)

const ecommerce = templateFor('ecommerce')
if (!ecommerce) throw new Error('template e-commerce assente')
const first = ecommerce.sections[0]
const [a, b] = first.items

is('hasItem: voce esistente', hasItem(ecommerce, a.id), true)
is('hasItem: voce inesistente', hasItem(ecommerce, 'non-esiste'), false)

const merged = mergeChecklist(ecommerce, [
  { item_id: a.id, done: true, note: 'fatto ieri', updated_at: '2026-03-01T10:00:00Z' },
  { item_id: b.id, done: false, note: 'in attesa del cliente' },
  { item_id: 'voce-orfana', done: true, note: '' },
])
const mergedFirst = merged.sections[0]
is('sezione 1: una voce fatta', mergedFirst.progress, {
  done: 1, total: first.items.length, percent: Math.round((1 / first.items.length) * 100),
})
is('voce fatta con nota e data', [mergedFirst.items[0].done, mergedFirst.items[0].note, mergedFirst.items[0].updatedAt],
  [true, 'fatto ieri', '2026-03-01T10:00:00Z'])
is('voce non fatta con nota', [mergedFirst.items[1].done, mergedFirst.items[1].note, mergedFirst.items[1].updatedAt],
  [false, 'in attesa del cliente', null])
is('voce senza stato: default', [mergedFirst.items[2].done, mergedFirst.items[2].note], [false, ''])
is('detail sempre stringa', merged.sections.every(s => s.items.every(i => typeof i.detail === 'string')), true)
is('avanzamento complessivo (orfana ignorata)', merged.progress, { done: 1, total: 27, percent: 4 })
is('altre sezioni a zero', merged.sections.slice(1).every(s => s.progress.done === 0), true)
is('archetype/title/version/note', [merged.archetype, merged.title, merged.version, typeof merged.note],
  ['ecommerce', ecommerce.title, ecommerce.version ?? 1, 'string'])
is('nessuno stato → 0%', mergeChecklist(ecommerce, []).progress, { done: 0, total: 27, percent: 0 })
is('EMPTY_CHECKLIST', EMPTY_CHECKLIST, { archetype: null, title: '', version: 1, note: '', sections: [], progress: { done: 0, total: 0, percent: 0 } })

// Gli errori di struttura escono come TrackingError 500 (qui via il parser interno,
// esercitato indirettamente: i JSON reali devono passare senza eccezioni).
let threw: unknown = null
try {
  templateFor('hospitality')
} catch (e) {
  threw = e
}
is('template validi: nessun TrackingError', isTrackingError(threw), false)

console.log(fail ? `\n${fail} controlli falliti` : '\nTutti i controlli passano')
process.exit(fail ? 1 : 0)
