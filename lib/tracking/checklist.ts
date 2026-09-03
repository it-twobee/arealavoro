/**
 * §316 — Checklist di tracking per archetipo.
 *
 * Le voci stanno nei JSON in ./templates (importati staticamente: la build è
 * `standalone`, niente letture da disco a runtime). A DB va solo l'avanzamento
 * per cliente e per voce; qui non si importa niente di server-side.
 */

import type { TrackingChecklistState } from '@/lib/types/database'
import { ARCHETYPES, archetypeByValue, type Archetype } from '@/lib/tracking/vocab'
import { TrackingError } from '@/lib/tracking/errors'
import ecommerceShopify from './templates/ecommerce-shopify.json'
import leadgenB2b from './templates/leadgen-b2b.json'
import hospitality from './templates/hospitality.json'

export type ChecklistItem = { id: string; title: string; detail?: string }
export type ChecklistSection = { id: string; title: string; items: ChecklistItem[] }
export type ChecklistTemplate = {
  archetype: string
  title: string
  version?: number
  note?: string
  sections: ChecklistSection[]
}

export type ChecklistProgress = { done: number; total: number; percent: number }

export type MergedChecklistItem = {
  id: string
  title: string
  detail: string
  done: boolean
  note: string
  updatedAt: string | null
}
export type MergedChecklistSection = {
  id: string
  title: string
  items: MergedChecklistItem[]
  progress: ChecklistProgress
}
export type MergedChecklist = {
  archetype: string | null
  title: string
  version: number
  note: string
  sections: MergedChecklistSection[]
  progress: ChecklistProgress
}

export type TemplateSummary = {
  archetype: Archetype
  label: string
  title: string
  version: number
  totalItems: number
  sections: { id: string; title: string; items: number }[]
}

/** Stato salvato di una voce; `updated_at` è facoltativo per chi non lo carica. */
export type ChecklistItemState = Pick<TrackingChecklistState, 'item_id' | 'done' | 'note'> &
  Partial<Pick<TrackingChecklistState, 'updated_at'>>

/** Chiave = `templateKey` dell'archetipo in vocab.ts, cioè il nome del file. */
const RAW_TEMPLATES: Record<string, unknown> = {
  'ecommerce-shopify': ecommerceShopify,
  'leadgen-b2b': leadgenB2b,
  hospitality,
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseTemplate(file: string, raw: unknown): ChecklistTemplate {
  if (!isRecord(raw) || typeof raw.title !== 'string') throw new Error(`${file}: manca "title"`)
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
    throw new Error(`${file}: manca l'array "sections"`)
  }

  // Gli id finiscono a DB come chiave primaria: un duplicato farebbe
  // condividere lo stato a due voci diverse. Meglio scoprirlo qui.
  const seen = new Set<string>()
  const sections: ChecklistSection[] = raw.sections.map((section: unknown) => {
    if (!isRecord(section) || typeof section.id !== 'string' || !section.id || !Array.isArray(section.items)) {
      throw new Error(`${file}: sezione senza id o senza items`)
    }
    const items: ChecklistItem[] = section.items.map((item: unknown) => {
      if (!isRecord(item) || typeof item.id !== 'string' || !item.id) {
        throw new Error(`${file}: voce senza id nella sezione ${section.id}`)
      }
      if (seen.has(item.id)) throw new Error(`${file}: id voce duplicato "${item.id}"`)
      seen.add(item.id)
      return {
        id: item.id,
        title: typeof item.title === 'string' ? item.title : item.id,
        ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
      }
    })
    return { id: section.id, title: typeof section.title === 'string' ? section.title : section.id, items }
  })

  return {
    archetype: typeof raw.archetype === 'string' ? raw.archetype : '',
    title: raw.title,
    ...(typeof raw.version === 'number' ? { version: raw.version } : {}),
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
    sections,
  }
}

/** Validazione pigra e memoizzata: un JSON rotto si scopre al primo uso, una volta sola. */
const cache = new Map<string, ChecklistTemplate>()

/** Template di un archetipo, o null se l'archetipo non è assegnato/noto. */
export function templateFor(archetype: string | null | undefined): ChecklistTemplate | null {
  const meta = archetypeByValue(archetype)
  if (!meta) return null

  const cached = cache.get(meta.templateKey)
  if (cached) return cached

  const file = `${meta.templateKey}.json`
  const raw = RAW_TEMPLATES[meta.templateKey]
  if (raw === undefined) throw new TrackingError(500, `Template mancante per l'archetipo ${archetype}: ${file}`)

  let template: ChecklistTemplate
  try {
    template = parseTemplate(file, raw)
  } catch (err) {
    throw new TrackingError(500, `Template non valido: ${err instanceof Error ? err.message : String(err)}`)
  }

  cache.set(meta.templateKey, template)
  return template
}

/** Riepilogo di tutti i template disponibili (per la vista di riepilogo). */
export function listTemplates(): TemplateSummary[] {
  return ARCHETYPES.map(a => {
    const template = templateFor(a.value)
    if (!template) throw new TrackingError(500, `Template mancante per l'archetipo ${a.value}`)
    return {
      archetype: a.value,
      label: a.label,
      title: template.title,
      version: template.version ?? 1,
      totalItems: template.sections.reduce((n, s) => n + s.items.length, 0),
      sections: template.sections.map(s => ({ id: s.id, title: s.title, items: s.items.length })),
    }
  })
}

const progressOf = (done: number, total: number): ChecklistProgress => ({
  done,
  total,
  percent: total === 0 ? 0 : Math.round((done / total) * 100),
})

/** Risposta per un cliente senza archetipo: niente voci, avanzamento a zero. */
export const EMPTY_CHECKLIST: MergedChecklist = {
  archetype: null,
  title: '',
  version: 1,
  note: '',
  sections: [],
  progress: progressOf(0, 0),
}

/** Template + avanzamento del cliente, pronto per la UI. */
export function mergeChecklist(template: ChecklistTemplate, states: ChecklistItemState[]): MergedChecklist {
  const state = new Map(states.map(s => [s.item_id, s]))

  let done = 0
  let total = 0

  const sections: MergedChecklistSection[] = template.sections.map(section => {
    const items: MergedChecklistItem[] = section.items.map(item => {
      const saved = state.get(item.id)
      const isDone = Boolean(saved?.done)
      total += 1
      if (isDone) done += 1
      return {
        id: item.id,
        title: item.title,
        detail: item.detail ?? '',
        done: isDone,
        note: saved?.note ?? '',
        updatedAt: saved?.updated_at ?? null,
      }
    })
    return {
      id: section.id,
      title: section.title,
      items,
      progress: progressOf(items.filter(i => i.done).length, items.length),
    }
  })

  return {
    archetype: template.archetype,
    title: template.title,
    version: template.version ?? 1,
    note: template.note ?? '',
    sections,
    progress: progressOf(done, total),
  }
}

/** Vero se la voce esiste nel template: da verificare prima di salvarne lo stato. */
export function hasItem(template: ChecklistTemplate, itemId: string): boolean {
  return template.sections.some(s => s.items.some(i => i.id === itemId))
}
