// Accessi ad account di un cliente. Montato su /api/clients/:clientId/accounts.
//
// Diversi dalle chiavi API (routes/credentials.js): qui serve la coppia utente +
// password, più indirizzo e note. La password è l'unico campo cifrato; utente,
// servizio e indirizzo restano in chiaro perché servono a cercare e a leggere
// l'elenco senza aprire il vault.

import express from 'express';
import { db } from '../db.js';
import { HttpError } from '../http-error.js';
import * as vault from '../vault.js';

export const router = express.Router({ mergeParams: true });

const WRITABLE = ['service', 'label', 'username', 'url', 'note', 'sort'];

function clientOr404(clientId) {
  const row = db.prepare('SELECT id, name FROM clients WHERE id = ?').get(clientId);
  if (!row) throw new HttpError(404, 'Cliente non trovato');
  return row;
}

function accountOr404(clientId, accountId) {
  const row = db
    .prepare('SELECT * FROM client_accounts WHERE id = ? AND client_id = ?')
    .get(accountId, clientId);
  if (!row) throw new HttpError(404, 'Accesso non trovato');
  return row;
}

/**
 * Riga pronta per la UI, password compresa: l'area è locale e monoutente,
 * quindi non ha senso costringere a un clic per leggerla. Resta cifrata a
 * riposo nel database. Con la cifratura bloccata si restituisce senza password.
 */
function present(row) {
  let secret = '';
  let error = null;

  if (row.secret !== '' && vault.isUnlocked()) {
    try {
      secret = vault.open(row.secret);
    } catch (err) {
      error = err.message;
    }
  }

  return {
    id: row.id,
    service: row.service,
    label: row.label,
    username: row.username,
    url: row.url,
    note: row.note,
    hasSecret: row.secret !== '',
    secret,
    error,
    updatedAt: row.updated_at,
  };
}

function sanitize(body, { partial }) {
  const out = {};
  for (const field of WRITABLE) {
    if (!(field in body)) continue;
    if (field === 'sort') {
      out.sort = Number.isFinite(Number(body.sort)) ? Number(body.sort) : 0;
      continue;
    }
    out[field] = String(body[field] ?? '').trim();
  }

  if (!partial && !out.service) throw new HttpError(400, 'Indica il servizio (es. instagram, gmail, dominio)');
  if ('service' in out && !out.service) throw new HttpError(400, 'Il servizio non può essere vuoto');
  return out;
}

router.get('/', (req, res) => {
  clientOr404(req.params.clientId);
  const rows = db
    .prepare('SELECT * FROM client_accounts WHERE client_id = ? ORDER BY sort, id')
    .all(req.params.clientId);

  res.json({ unlocked: vault.isUnlocked(), items: rows.map(present) });
});

router.post('/', (req, res) => {
  clientOr404(req.params.clientId);
  const fields = sanitize(req.body ?? {}, { partial: false });

  // La password si cifra solo se è stata fornita: un accesso può essere
  // registrato anche senza, per completarlo dopo.
  const secretValue = String(req.body?.secret ?? '').trim();
  if (secretValue) vault.requireKey();

  const columns = ['client_id', ...Object.keys(fields), 'secret'];
  const values = [req.params.clientId, ...Object.keys(fields).map((k) => fields[k]), secretValue ? vault.seal(secretValue) : ''];

  const row = db
    .prepare(
      `INSERT INTO client_accounts (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`,
    )
    .get(...values);

  res.status(201).json(present(row));
});

router.patch('/:accountId', (req, res) => {
  clientOr404(req.params.clientId);
  accountOr404(req.params.clientId, req.params.accountId);

  const fields = sanitize(req.body ?? {}, { partial: true });

  // `secret` assente = non toccare; stringa vuota = cancella la password.
  if ('secret' in (req.body ?? {})) {
    const secretValue = String(req.body.secret ?? '').trim();
    fields.secret = secretValue ? vault.seal(secretValue) : '';
  }

  const columns = Object.keys(fields);
  if (columns.length === 0) throw new HttpError(400, 'Nessun campo da aggiornare');

  const row = db
    .prepare(
      `UPDATE client_accounts SET ${columns.map((c) => `${c} = ?`).join(', ')},
              updated_at = datetime('now')
        WHERE id = ? AND client_id = ? RETURNING *`,
    )
    .get(...columns.map((c) => fields[c]), req.params.accountId, req.params.clientId);

  res.json(present(row));
});

/** Password in chiaro: richiede il vault aperto. */
router.get('/:accountId/reveal', (req, res) => {
  clientOr404(req.params.clientId);
  const row = accountOr404(req.params.clientId, req.params.accountId);
  vault.requireKey();

  if (row.secret === '') throw new HttpError(404, 'Nessuna password salvata per questo accesso');
  res.json({ id: row.id, secret: vault.open(row.secret) });
});

router.delete('/:accountId', (req, res) => {
  clientOr404(req.params.clientId);
  accountOr404(req.params.clientId, req.params.accountId);

  db.prepare('DELETE FROM client_accounts WHERE id = ? AND client_id = ?').run(
    req.params.accountId,
    req.params.clientId,
  );
  res.status(204).end();
});
