// Verifica automatica del tracking scaricando l'HTML del sito cliente.
//
// Fetch, riconoscimento dei tag e politica di aggiornamento degli stati stanno
// in lib/tracking/site-check.ts (condiviso col CRM). Qui resta solo la parte
// che tocca SQLite: applicare le modifiche proposte e tenere lo storico.

import { db } from './db.js';
import { HttpError } from './http-error.js';
import { normalizeUrl } from '../lib/tracking/validate.ts';
import { assertPublicHost, detectTags, evaluate, fetchSite } from '../lib/tracking/site-check.ts';

export { assertPublicHost, detectTags, evaluate, fetchSite, normalizeUrl };

/** Nessun tag: quando la pagina non si è scaricata non si conclude nulla. */
const NOTHING_FOUND = Object.freeze({
  gtmIds: [],
  ga4Ids: [],
  gtagLoaded: false,
  metaIds: [],
  fbevents: false,
  klaviyo: false,
});

/** Esegue la verifica, applica le modifiche e registra l'esito nello storico. */
export async function runCheck(client) {
  if (!client.website_url) {
    throw new HttpError(409, "Aggiungi l'URL del sito prima di lanciare la verifica");
  }

  const url = normalizeUrl(client.website_url);
  const result = await fetchSite(url);
  const found = result.ok ? detectTags(result.html) : { ...NOTHING_FOUND };

  // La riga del cliente ha le stesse colonne che `evaluate` si aspetta.
  const { changes, notes, gtmPresente } = result.ok
    ? evaluate(client, found)
    : { changes: [], notes: [], gtmPresente: false };

  if (changes.length > 0) {
    const assignments = changes.map((c) => `${c.field} = ?`).join(', ');
    db.prepare(
      `UPDATE clients SET ${assignments}, updated_at = datetime('now') WHERE id = ?`,
    ).run(...changes.map((c) => c.to), client.id);
  }

  db.prepare(
    `INSERT INTO tracking_checks
       (client_id, url, ok, http_status, error, gtm_ids, ga4_ids, meta_ids, klaviyo, changes, bytes, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    client.id,
    result.finalUrl,
    result.ok ? 1 : 0,
    result.httpStatus,
    result.error,
    JSON.stringify(found.gtmIds),
    JSON.stringify(found.ga4Ids),
    JSON.stringify(found.metaIds),
    found.klaviyo ? 1 : 0,
    JSON.stringify(changes),
    result.bytes,
    result.durationMs,
  );

  return {
    ok: result.ok,
    url: result.finalUrl,
    httpStatus: result.httpStatus,
    error: result.error,
    found,
    // Dice a chi legge se l'assenza di un tag nell'HTML sia concludente.
    gtmPresente,
    changes,
    notes,
    bytes: result.bytes,
    durationMs: result.durationMs,
  };
}

/** Ultime verifiche di un cliente, dalla più recente. */
export function checkHistory(clientId, limit = 10) {
  return db
    .prepare(
      `SELECT id, checked_at, url, ok, http_status, error, gtm_ids, ga4_ids, meta_ids,
              klaviyo, changes, duration_ms
         FROM tracking_checks WHERE client_id = ?
        ORDER BY checked_at DESC, id DESC LIMIT ?`,
    )
    .all(clientId, limit)
    .map((row) => ({
      id: row.id,
      checkedAt: row.checked_at,
      url: row.url,
      ok: Boolean(row.ok),
      httpStatus: row.http_status,
      error: row.error,
      gtmIds: JSON.parse(row.gtm_ids),
      ga4Ids: JSON.parse(row.ga4_ids),
      metaIds: JSON.parse(row.meta_ids),
      klaviyo: Boolean(row.klaviyo),
      changes: JSON.parse(row.changes),
      durationMs: row.duration_ms,
    }));
}
