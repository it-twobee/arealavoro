/* Verifica del CSV dei report. Esegui: npx tsx lib/tracking/csv.check.ts */
import { clientSlug, csvFilename, reportToCsv } from '@/lib/tracking/csv'
import type { ShapedReport } from '@/lib/tracking/reporting'

let fail = 0
const is = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'OK ' : 'NO '} ${label.padEnd(58)} ${JSON.stringify(got)}${ok ? '' : `  atteso ${JSON.stringify(want)}`}`)
}

const report: ShapedReport = {
  id: 'run-1', source: 'ga4', definition: 'E-commerce', definitionVersion: 1,
  period: { start: '2026-02-13', end: '2026-03-14', compareStart: '2026-01-14', compareEnd: '2026-02-12' },
  ok: true, error: null, createdAt: '2026-03-15T08:00:00Z', durationMs: 10,
  totals: [
    { metric: 'sessions', current: 1200, previous: 1000, variation: 20 },
    { metric: 'engagementRate', current: 0.123456, previous: 0.1, variation: 23.5 },
  ],
  breakdowns: [
    {
      id: 'canale', title: 'Per canale; "acquisizione"', dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions', 'purchaseRevenue'],
      rows: [
        { key: 'Organic Search', dimensions: { sessionDefaultChannelGroup: 'Organic Search' }, metrics: { sessions: 700, purchaseRevenue: 1234.5 }, previous: { sessions: 650, purchaseRevenue: 0 } },
        { key: 'Paid, Social', dimensions: { sessionDefaultChannelGroup: 'Paid, Social' }, metrics: { sessions: 500, purchaseRevenue: 1e21 }, previous: null },
      ],
    },
    {
      id: 'sorgenti', title: 'Sorgenti', dimensions: ['source', 'medium'], metrics: ['sessions'],
      rows: [{ key: 'google | cpc', dimensions: { source: 'google', medium: 'cpc' }, metrics: { sessions: 3 }, previous: null }],
    },
  ],
}

const csv = reportToCsv('Bar Da Gino srl', report)
const lines = csv.slice(1).split('\r\n')

is('BOM in testa', csv.charCodeAt(0), 0xfeff)
is('CRLF e riga finale vuota', [csv.endsWith('\r\n'), csv.includes('\n') && !csv.replace(/\r\n/g, '').includes('\n'), lines[lines.length - 1]], [true, true, ''])
is('intestazione: colonne fisse + unione metriche in ordine di apparizione', lines[0],
  'cliente;periodo;blocco;dimensione;valore;sessions;engagementRate;purchaseRevenue')
is('totali correnti: numeri grezzi come String()', lines[1], 'Bar Da Gino srl;2026-02-13…2026-03-14;totali;;;1200;0.123456;')
is('totali precedenti', lines[2], 'Bar Da Gino srl;2026-01-14…2026-02-12;totali;;;1000;0.1;')
is('riga breakdown: titolo con ; e " → quotato, virgolette raddoppiate', lines[3],
  'Bar Da Gino srl;2026-02-13…2026-03-14;"Per canale; ""acquisizione""";sessionDefaultChannelGroup;Organic Search;700;;1234.5')
is('riga previous solo se presente', lines[4],
  'Bar Da Gino srl;2026-01-14…2026-02-12;"Per canale; ""acquisizione""";sessionDefaultChannelGroup;Organic Search;650;;0')
is('valore con virgola quotato, 1e21 come JS', lines[5],
  'Bar Da Gino srl;2026-02-13…2026-03-14;"Per canale; ""acquisizione""";sessionDefaultChannelGroup;"Paid, Social";500;;1e+21')
is('dimensioni multiple unite con " | "', lines[6], 'Bar Da Gino srl;2026-02-13…2026-03-14;Sorgenti;source | medium;google | cpc;3;;')
is('numero righe: header + 2 totali + 3 canale + 1 sorgenti', lines.length - 1, 7)
is('nome cliente senza caratteri speciali non viene quotato', lines[1].startsWith('Bar Da Gino srl;'), true)
is('nome cliente con virgolette → quotato e raddoppiate',
  reportToCsv('Bar "Da Gino"', { ...report, breakdowns: [] }).slice(1).split('\r\n')[1].startsWith('"Bar ""Da Gino""";'), true)
is('nome cliente con ; viene quotato', reportToCsv('A;B', { ...report, breakdowns: [] }).slice(1).split('\r\n')[1].startsWith('"A;B";'), true)
is('newline nel valore → quotato', reportToCsv('X', { ...report, totals: [], breakdowns: [
  { id: 'b', title: 'B', dimensions: ['d'], metrics: ['m'], rows: [{ key: 'a\nb', dimensions: { d: 'a\nb' }, metrics: { m: 1 }, previous: null }] },
] }).includes(';"a\nb";1'), true)

is('clientSlug: accenti e simboli', clientSlug('Caffè Nönno & Figli S.r.l.'), 'caffe-nonno-figli-s-r-l')
is('clientSlug: vuoto → cliente', clientSlug('!!!'), 'cliente')
is('csvFilename', csvFilename('Bar "Da Gino" srl', 'ga4', '2026-03-14'), 'twobee-bar-da-gino-srl-ga4-2026-03-14.csv')
is('csvFilename: fonte klaviyo', csvFilename('Josè', 'klaviyo', '2026-03-14'), 'twobee-jose-klaviyo-2026-03-14.csv')

console.log(fail ? `\n${fail} controlli falliti` : '\nTutti i controlli passano')
process.exit(fail ? 1 : 0)
