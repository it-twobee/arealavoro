// Reporting per cliente. Montato su /api/clients/:clientId/reports.

import express from 'express';
import { db } from '../db.js';
import { HttpError } from '../http-error.js';
import * as vault from '../vault.js';
import {
  definitionFor,
  ga4Metadata,
  getReport,
  periodLast30,
  reportToCsv,
  runGa4Report,
  runKlaviyoReport,
  runMetaReport,
  runHistory,
} from '../reporting.js';

export const router = express.Router({ mergeParams: true });

function clientOr404(clientId) {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!row) throw new HttpError(404, 'Cliente non trovato');
  return row;
}

/** Stato del tab: cosa manca per poter generare, storico, periodo previsto. */
router.get('/', (req, res) => {
  const client = clientOr404(req.params.clientId);
  const hasAgencyCredential = Boolean(
    db.prepare("SELECT 1 FROM agency_credentials WHERE platform = 'ga4'").get(),
  );

  const blockers = [];
  if (!client.archetype) blockers.push('Assegna un archetipo al cliente (determina la definizione del report)');
  if (!client.ga4_property_id) blockers.push('Inserisci il Property ID GA4 di questo cliente');
  if (!hasAgencyCredential) blockers.push('Configura il service account GA4 in Impostazioni');
  if (!vault.isUnlocked()) blockers.push('Sblocca il vault: il service account è cifrato');

  // Klaviyo ha una catena di prerequisiti diversa: la chiave è per cliente.
  const hasKlaviyoKey = Boolean(
    db.prepare("SELECT 1 FROM credentials WHERE client_id = ? AND platform = 'klaviyo'").get(client.id),
  );
  const klaviyoBlockers = [];
  if (!hasKlaviyoKey) klaviyoBlockers.push('Inserisci la chiave API Klaviyo nella scheda Chiavi di questo cliente');
  if (!vault.isUnlocked()) klaviyoBlockers.push('Sblocca la cifratura: la chiave Klaviyo è cifrata');

  // Meta: token d'agenzia + Ad Account ID del cliente, due posti diversi.
  const hasMetaAccount = Boolean(
    db.prepare("SELECT 1 FROM credentials WHERE client_id = ? AND platform = 'meta'").get(client.id),
  );
  const hasMetaToken = Boolean(
    db.prepare("SELECT 1 FROM agency_credentials WHERE platform = 'meta'").get(),
  );
  const metaBlockers = [];
  if (!hasMetaAccount) metaBlockers.push("Inserisci l'Ad Account ID nella scheda Chiavi di questo cliente");
  if (!hasMetaToken) metaBlockers.push('Configura il token System User Meta in Impostazioni');
  if (!vault.isUnlocked()) metaBlockers.push('Sblocca la cifratura: le credenziali Meta sono cifrate');

  res.json({
    propertyId: client.ga4_property_id,
    archetype: client.archetype,
    definition: client.archetype ? definitionFor(client.archetype).title : null,
    period: periodLast30(),
    canRun: blockers.length === 0,
    blockers,
    klaviyo: { canRun: klaviyoBlockers.length === 0, blockers: klaviyoBlockers },
    meta: { canRun: metaBlockers.length === 0, blockers: metaBlockers },
    runs: runHistory(req.params.clientId),
  });
});

router.post('/', async (req, res) => {
  const client = clientOr404(req.params.clientId);
  res.json(await runGa4Report(client));
});

router.post('/klaviyo', async (req, res) => {
  const client = clientOr404(req.params.clientId);
  res.json(await runKlaviyoReport(client));
});

router.post('/meta', async (req, res) => {
  const client = clientOr404(req.params.clientId);
  res.json(await runMetaReport(client));
});

/** Metriche e dimensioni disponibili: serve a scrivere le definizioni. */
router.get('/metadata', async (req, res) => {
  const client = clientOr404(req.params.clientId);
  res.json(await ga4Metadata(client));
});

router.get('/:runId', (req, res) => {
  clientOr404(req.params.clientId);
  res.json(getReport(Number(req.params.clientId), Number(req.params.runId)));
});

router.get('/:runId/csv', (req, res) => {
  const client = clientOr404(req.params.clientId);
  const report = getReport(client.id, Number(req.params.runId));
  const slug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="twobee-${slug}-${report.period.start}_${report.period.end}.csv"`,
  );
  res.send(reportToCsv(client.name, report));
});
