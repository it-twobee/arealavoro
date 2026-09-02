// Credenziali a livello agenzia (una copia per tutto il portafoglio).
// Come per le credenziali per cliente, il valore in chiaro esce solo su /reveal.

import express from 'express';
import { AGENCY_CREDENTIALS, agencyCredentialByKey } from '../archetypes.js';
import { HttpError } from '../http-error.js';
import * as vault from '../vault.js';
import { agencyCredentialStatus, listDefinitions, readAgencyCredential, saveAgencyCredential } from '../reporting.js';
import { clearTokenCache, parseServiceAccount } from '../ga4.js';

export const router = express.Router();

function assertPlatform(key) {
  const meta = agencyCredentialByKey(key);
  if (!meta) throw new HttpError(400, `Piattaforma non gestita: ${key}`);
  return meta;
}

router.get('/credentials', (req, res) => {
  const saved = agencyCredentialStatus();
  const unlocked = vault.isUnlocked();

  res.json({
    unlocked,
    items: AGENCY_CREDENTIALS.map((c) => {
      // Valore in chiaro: stessa scelta fatta per le chiavi per cliente.
      let value = '';
      let error = null;

      if (saved.has(c.key) && unlocked) {
        try {
          value = readAgencyCredential(c.key) ?? '';
        } catch (err) {
          error = err.message;
        }
      }

      return {
        platform: c.key,
        label: c.label,
        kind: c.kind,
        hint: c.hint,
        clientField: c.clientField,
        clientFieldLabel: c.clientFieldLabel,
        implemented: c.implemented,
        hasValue: saved.has(c.key),
        value,
        error,
        updatedAt: saved.get(c.key) ?? null,
      };
    }),
  });
});

router.put('/credentials/:platform', (req, res) => {
  const meta = assertPlatform(req.params.platform);
  vault.requireKey();

  const value = String(req.body?.value ?? '').trim();

  // Il JSON del service account si valida subito: scoprire a fine mese che la
  // chiave era incollata male sarebbe il momento peggiore.
  let details = null;
  if (value && meta.key === 'ga4') {
    const account = parseServiceAccount(value);
    details = { clientEmail: account.clientEmail, projectId: account.projectId };
  }

  const result = saveAgencyCredential(meta.key, value);
  clearTokenCache(); // il service account può essere cambiato
  res.json({ ...result, details });
});

router.get('/credentials/:platform/reveal', (req, res) => {
  const meta = assertPlatform(req.params.platform);
  vault.requireKey();

  const value = readAgencyCredential(meta.key);
  if (value === null) throw new HttpError(404, 'Credenziale non configurata');
  res.json({ platform: meta.key, value });
});

/** Riepilogo delle definizioni report, per la vista Impostazioni. */
router.get('/report-definitions', (req, res) => {
  res.json(listDefinitions());
});
