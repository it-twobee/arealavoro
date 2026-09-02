// Credenziali per cliente. Montato su /api/clients/:clientId/credentials.
//
// Il valore in chiaro esce da qui solo su richiesta esplicita (/reveal), che
// alimenta il toggle "mostra" in UI. La lista non lo espone mai.

import express from 'express';
import { db } from '../db.js';
import { PLATFORMS, PLATFORM_KEYS } from '../archetypes.js';
import { HttpError } from '../http-error.js';
import * as vault from '../vault.js';

export const router = express.Router({ mergeParams: true });

function clientOr404(clientId) {
  const row = db.prepare('SELECT id, name FROM clients WHERE id = ?').get(clientId);
  if (!row) throw new HttpError(404, 'Cliente non trovato');
  return row;
}

function assertPlatform(platform) {
  if (!PLATFORM_KEYS.includes(platform)) {
    throw new HttpError(400, `Piattaforma non gestita: ${platform}`);
  }
  return platform;
}

/**
 * Elenco delle piattaforme con la chiave già in chiaro.
 *
 * L'area di lavoro è locale e monoutente: mascherare i valori aggiungeva solo
 * un clic per leggerli. Restano cifrati **a riposo** nel database; è la
 * visualizzazione a non nasconderli più. Se la cifratura è bloccata si
 * restituisce comunque l'elenco, senza valori.
 */
router.get('/', (req, res) => {
  clientOr404(req.params.clientId);
  const unlocked = vault.isUnlocked();

  const saved = new Map(
    db
      .prepare('SELECT platform, blob, updated_at FROM credentials WHERE client_id = ?')
      .all(req.params.clientId)
      .map((row) => [row.platform, row]),
  );

  res.json({
    unlocked,
    items: PLATFORMS.map((p) => {
      const row = saved.get(p.key);
      let value = '';
      let error = null;

      if (row && unlocked) {
        // Una credenziale illeggibile (per esempio dopo un reset della chiave)
        // non deve far fallire l'intero elenco: si segnala solo quella.
        try {
          value = vault.open(row.blob);
        } catch (err) {
          error = err.message;
        }
      }

      return {
        platform: p.key,
        label: p.label,
        hint: p.hint,
        hasValue: Boolean(row),
        value,
        error,
        updatedAt: row?.updated_at ?? null,
      };
    }),
  });
});

/** Valore in chiaro: richiede il vault sbloccato. */
router.get('/:platform/reveal', (req, res) => {
  clientOr404(req.params.clientId);
  const platform = assertPlatform(req.params.platform);
  vault.requireKey();

  const row = db
    .prepare('SELECT blob FROM credentials WHERE client_id = ? AND platform = ?')
    .get(req.params.clientId, platform);
  if (!row) throw new HttpError(404, 'Nessuna credenziale salvata per questa piattaforma');

  res.json({ platform, value: vault.open(row.blob) });
});

/** Salva (cifrando) oppure cancella se il valore è vuoto. */
router.put('/:platform', (req, res) => {
  clientOr404(req.params.clientId);
  const platform = assertPlatform(req.params.platform);
  vault.requireKey();

  const value = String(req.body?.value ?? '').trim();

  if (value === '') {
    const { changes } = db
      .prepare('DELETE FROM credentials WHERE client_id = ? AND platform = ?')
      .run(req.params.clientId, platform);
    return res.json({ platform, hasValue: false, deleted: changes > 0 });
  }

  const row = db
    .prepare(
      `INSERT INTO credentials (client_id, platform, blob) VALUES (?, ?, ?)
       ON CONFLICT(client_id, platform)
         DO UPDATE SET blob = excluded.blob, updated_at = datetime('now')
       RETURNING updated_at`,
    )
    .get(req.params.clientId, platform, vault.seal(value));

  res.json({ platform, hasValue: true, updatedAt: row.updated_at });
});

router.delete('/:platform', (req, res) => {
  clientOr404(req.params.clientId);
  const platform = assertPlatform(req.params.platform);

  const { changes } = db
    .prepare('DELETE FROM credentials WHERE client_id = ? AND platform = ?')
    .run(req.params.clientId, platform);
  if (changes === 0) throw new HttpError(404, 'Nessuna credenziale salvata per questa piattaforma');

  res.status(204).end();
});
