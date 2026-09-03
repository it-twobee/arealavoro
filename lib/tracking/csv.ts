/**
 * §316 — CSV dei dati grezzi di un report, per uso interno. Un unico foglio
 * con tutti i blocchi: le metriche assenti in un blocco restano vuote, così
 * resta apribile in Excel. Separatore `;`, righe CRLF, BOM per gli accenti.
 */

import type { ShapedReport } from '@/lib/tracking/reporting'
import type { ReportSource } from '@/lib/tracking/vocab'

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function reportToCsv(clientName: string, report: ShapedReport): string {
  const allMetrics = Array.from(new Set([
    ...report.totals.map(t => t.metric),
    ...report.breakdowns.flatMap(b => b.metrics),
  ]))

  const header = ['cliente', 'periodo', 'blocco', 'dimensione', 'valore', ...allMetrics]
  const lines = [header.map(csvCell).join(';')]

  const push = (periodo: string, blocco: string, dimensione: string, valore: string, metrics: Record<string, number>) => {
    const row: unknown[] = [clientName, periodo, blocco, dimensione, valore]
    for (const metric of allMetrics) row.push(metrics[metric] ?? '')
    lines.push(row.map(csvCell).join(';'))
  }

  const label = `${report.period.start}…${report.period.end}`
  const labelPrev = `${report.period.compareStart}…${report.period.compareEnd}`

  push(label, 'totali', '', '', Object.fromEntries(report.totals.map(t => [t.metric, t.current])))
  push(labelPrev, 'totali', '', '', Object.fromEntries(report.totals.map(t => [t.metric, t.previous])))

  for (const breakdown of report.breakdowns) {
    for (const row of breakdown.rows) {
      push(label, breakdown.title, breakdown.dimensions.join(' | '), row.key, row.metrics)
      if (row.previous) {
        push(labelPrev, breakdown.title, breakdown.dimensions.join(' | '), row.key, row.previous)
      }
    }
  }

  // BOM: senza, Excel su Windows sbaglia gli accenti.
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** Nome cliente ridotto a slug ASCII per il nome del file; vuoto → "cliente". */
export function clientSlug(clientName: string): string {
  const slug = clientName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'cliente'
}

/** Es. `twobee-nome-cliente-ga4-2026-03-14.csv` (l'intestazione Content-Disposition la mette la route). */
export function csvFilename(clientName: string, source: ReportSource | string, periodEnd: string): string {
  return `twobee-${clientSlug(clientName)}-${clientSlug(source)}-${periodEnd}.csv`
}
