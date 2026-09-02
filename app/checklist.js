// Checklist di tracking per archetipo.
//
// Le voci stanno nei file tracking-templates/<dir>/checklist.json, non a DB:
// così l'agenzia le modifica con un editor, restano versionabili e non serve
// una migrazione per aggiungere un controllo. A DB va solo l'avanzamento
// (fatto/non fatto + nota) per cliente e per voce.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, db } from './db.js';
import { ARCHETYPES, archetypeByValue } from './archetypes.js';
import { HttpError } from './http-error.js';

const TEMPLATES_DIR = path.join(ROOT, 'tracking-templates');

/** Cache invalidata dall'mtime: modificare il JSON basta, senza riavvii. */
const cache = new Map();

function parseTemplate(file, raw) {
  const template = JSON.parse(raw);

  if (!Array.isArray(template.sections) || template.sections.length === 0) {
    throw new Error(`${file}: manca l'array "sections"`);
  }

  // Gli id finiscono a DB come chiave primaria: un duplicato farebbe
  // condividere lo stato a due voci diverse. Meglio scoprirlo qui.
  const seen = new Set();
  for (const section of template.sections) {
    if (!section.id || !Array.isArray(section.items)) {
      throw new Error(`${file}: sezione senza id o senza items`);
    }
    for (const item of section.items) {
      if (!item.id) throw new Error(`${file}: voce senza id nella sezione ${section.id}`);
      if (seen.has(item.id)) throw new Error(`${file}: id voce duplicato "${item.id}"`);
      seen.add(item.id);
    }
  }
  return template;
}

/** Template di un archetipo, o null se l'archetipo non è assegnato. */
export function templateFor(archetype) {
  const meta = archetypeByValue(archetype);
  if (!meta) return null;

  const file = path.join(TEMPLATES_DIR, meta.templateDir, 'checklist.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HttpError(500, `Template mancante per l'archetipo ${archetype}: ${file}`);
  }

  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.template;

  let template;
  try {
    template = parseTemplate(file, fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new HttpError(500, `Template non valido: ${err.message}`);
  }

  cache.set(file, { mtimeMs: stat.mtimeMs, template });
  return template;
}

/** Riepilogo di tutti i template disponibili (per la vista di riepilogo). */
export function listTemplates() {
  return ARCHETYPES.map((a) => {
    const template = templateFor(a.value);
    return {
      archetype: a.value,
      label: a.label,
      title: template.title,
      version: template.version ?? 1,
      totalItems: template.sections.reduce((n, s) => n + s.items.length, 0),
      sections: template.sections.map((s) => ({ id: s.id, title: s.title, items: s.items.length })),
    };
  });
}

/** Template + avanzamento del cliente, pronto per la UI. */
export function checklistFor(client) {
  const template = templateFor(client.archetype);
  if (!template) {
    return { archetype: null, sections: [], progress: { done: 0, total: 0, percent: 0 } };
  }

  const state = new Map(
    db
      .prepare('SELECT item_id, done, note, updated_at FROM checklist_state WHERE client_id = ?')
      .all(client.id)
      .map((row) => [row.item_id, row]),
  );

  let done = 0;
  let total = 0;

  const sections = template.sections.map((section) => {
    const items = section.items.map((item) => {
      const saved = state.get(item.id);
      const isDone = Boolean(saved?.done);
      total += 1;
      if (isDone) done += 1;
      return {
        id: item.id,
        title: item.title,
        detail: item.detail ?? '',
        done: isDone,
        note: saved?.note ?? '',
        updatedAt: saved?.updated_at ?? null,
      };
    });

    return {
      id: section.id,
      title: section.title,
      items,
      done: items.filter((i) => i.done).length,
      total: items.length,
    };
  });

  return {
    archetype: client.archetype,
    title: template.title,
    version: template.version ?? 1,
    note: template.note ?? '',
    sections,
    progress: { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) },
  };
}

/** Aggiorna una voce. L'id deve esistere nel template dell'archetipo. */
export function setItemState(client, itemId, { done, note }) {
  const template = templateFor(client.archetype);
  if (!template) throw new HttpError(409, 'Assegna prima un archetipo al cliente');

  const exists = template.sections.some((s) => s.items.some((i) => i.id === itemId));
  if (!exists) throw new HttpError(404, `Voce "${itemId}" non presente nel template ${client.archetype}`);

  const current = db
    .prepare('SELECT done, note FROM checklist_state WHERE client_id = ? AND item_id = ?')
    .get(client.id, itemId);

  const nextDone = done === undefined ? Boolean(current?.done) : Boolean(done);
  const nextNote = note === undefined ? (current?.note ?? '') : String(note).trim();

  db.prepare(
    `INSERT INTO checklist_state (client_id, item_id, done, note)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(client_id, item_id) DO UPDATE
       SET done = excluded.done, note = excluded.note, updated_at = datetime('now')`,
  ).run(client.id, itemId, nextDone ? 1 : 0, nextNote);

  return { itemId, done: nextDone, note: nextNote };
}
