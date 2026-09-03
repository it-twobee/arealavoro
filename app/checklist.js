// Checklist di tracking per archetipo.
//
// I template JSON e la loro validazione stanno in lib/tracking/checklist.ts
// (condiviso col CRM, cartella lib/tracking/templates). A DB va solo
// l'avanzamento per cliente e per voce (fatto/non fatto + nota): quella parte
// resta qui, su SQLite.

import { db } from './db.js';
import { HttpError } from './http-error.js';
import {
  EMPTY_CHECKLIST,
  hasItem,
  listTemplates,
  mergeChecklist,
  templateFor,
} from '../lib/tracking/checklist.ts';

export { hasItem, listTemplates, mergeChecklist, templateFor };

function savedStates(clientId) {
  return db
    .prepare('SELECT item_id, done, note, updated_at FROM checklist_state WHERE client_id = ?')
    .all(clientId);
}

/** Template + avanzamento del cliente, pronto per la UI. */
export function checklistFor(client) {
  const template = templateFor(client.archetype);
  if (!template) return { ...EMPTY_CHECKLIST, archetype: null };

  const merged = mergeChecklist(template, savedStates(client.id));
  return {
    ...merged,
    archetype: client.archetype,
    // La UI legge `done`/`total` direttamente sulla sezione: si affiancano a
    // `progress`, che è la forma del nucleo condiviso.
    sections: merged.sections.map((s) => ({ ...s, done: s.progress.done, total: s.progress.total })),
  };
}

/** Aggiorna una voce. L'id deve esistere nel template dell'archetipo. */
export function setItemState(client, itemId, { done, note }) {
  const template = templateFor(client.archetype);
  if (!template) throw new HttpError(409, 'Assegna prima un archetipo al cliente');

  if (!hasItem(template, itemId)) {
    throw new HttpError(404, `Voce "${itemId}" non presente nel template ${client.archetype}`);
  }

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
