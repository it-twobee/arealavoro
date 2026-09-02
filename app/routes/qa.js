import express from 'express';
import { db } from '../db.js';
import { HttpError } from '../http-error.js';
import {
  QA_CHECKS,
  QA_STATUSES,
  lastRun,
  resultsFor,
  runQa,
  runQaForClient,
  summaryByClient,
} from '../qa.js';

export const router = express.Router();

/** Riepilogo per la vista clienti: quanti problemi e su quali clienti. */
router.get('/', (req, res) => {
  const summary = summaryByClient();
  const clients = db.prepare('SELECT id, name FROM clients ORDER BY name COLLATE NOCASE').all();

  const items = clients.map((c) => {
    const entry = summary.get(c.id);
    return {
      clientId: c.id,
      name: c.name,
      status: entry?.status ?? 'mai',
      problems: entry?.problems ?? [],
      checkedAt: entry?.checkedAt ?? null,
    };
  });

  res.json({
    checks: QA_CHECKS,
    statuses: QA_STATUSES,
    lastRun: lastRun(),
    withProblems: items.filter((i) => i.status === 'problema'),
    items,
  });
});

router.post('/run', async (req, res) => {
  res.json(await runQa({ origin: 'manuale dalla dashboard' }));
});

router.get('/clients/:clientId', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) throw new HttpError(404, 'Cliente non trovato');
  res.json({ checks: resultsFor(client.id) });
});

/** Ricontrolla un solo cliente, dal pulsante nella sua scheda. */
router.post('/clients/:clientId/run', async (req, res) => {
  const result = await runQaForClient(Number(req.params.clientId));
  // Il cliente aggiornato serve alla UI: il controllo può aver promosso uno stato.
  res.json({
    ...result,
    client: db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId),
  });
});
