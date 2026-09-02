// Checklist e verifica automatica. Montato su /api/clients/:clientId/tracking.

import express from 'express';
import { db } from '../db.js';
import { HttpError } from '../http-error.js';
import { checklistFor, setItemState } from '../checklist.js';
import { checkHistory, runCheck } from '../site-check.js';

export const router = express.Router({ mergeParams: true });

function clientOr404(clientId) {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!row) throw new HttpError(404, 'Cliente non trovato');
  return row;
}

router.get('/checklist', (req, res) => {
  res.json(checklistFor(clientOr404(req.params.clientId)));
});

router.put('/checklist/:itemId', (req, res) => {
  const client = clientOr404(req.params.clientId);
  const { done, note } = req.body ?? {};

  if (done === undefined && note === undefined) {
    throw new HttpError(400, 'Serve almeno "done" o "note"');
  }

  const updated = setItemState(client, req.params.itemId, { done, note });
  // Si restituisce anche il progresso: la UI aggiorna la barra senza un secondo giro.
  res.json({ ...updated, progress: checklistFor(client).progress });
});

router.post('/check', async (req, res) => {
  const client = clientOr404(req.params.clientId);
  const result = await runCheck(client);
  // Il cliente aggiornato serve alla UI per ridisegnare pallini e badge.
  res.json({ ...result, client: clientOr404(req.params.clientId) });
});

router.get('/checks', (req, res) => {
  clientOr404(req.params.clientId);
  res.json(checkHistory(req.params.clientId, 10));
});
