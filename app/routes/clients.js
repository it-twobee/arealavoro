import express from 'express';
import { db } from '../db.js';
import {
  ARCHETYPE_VALUES,
  CHANNEL_KEYS,
  STATUS_VALUES,
  archetypeByValue,
  trackingBadge,
} from '../archetypes.js';

import { HttpError } from '../http-error.js';
import { normalizeUrl } from '../site-check.js';

export const router = express.Router();

const STATUS_COLUMNS = [...CHANNEL_KEYS.map((k) => `status_${k}`), 'status_gsc'];
const WRITABLE = [
  'name',
  'archetype',
  'cms',
  'gtm_container_id',
  'website_url',
  'meta_pixel_id',
  'ga4_property_id',
  'lead_event',
  'google_ads_customer_id',
  'meta_ad_account_id',
  'notes',
  ...STATUS_COLUMNS,
];

/** Aggiunge il badge derivato: non è persistito, si ricalcola dagli stati. */
function decorate(row) {
  return { ...row, tracking_badge: trackingBadge(row) };
}

function findOr404(id) {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Cliente non trovato');
  return row;
}

/**
 * Valida e normalizza i campi in arrivo. In POST i campi mancanti prendono
 * il default; in PATCH vengono semplicemente omessi dall'UPDATE.
 */
function sanitize(body, { partial }) {
  const out = {};

  for (const field of WRITABLE) {
    if (!(field in body)) continue;
    let value = body[field];

    if (field === 'archetype') {
      value = value === '' || value === null || value === undefined ? null : String(value).trim();
      if (value !== null && !ARCHETYPE_VALUES.includes(value)) {
        throw new HttpError(400, `Archetipo non valido: ${value}`);
      }
    } else if (STATUS_COLUMNS.includes(field)) {
      value = String(value ?? '').trim();
      if (!STATUS_VALUES.includes(value)) {
        throw new HttpError(400, `Stato non valido per ${field}: ${value}`);
      }
    } else {
      value = String(value ?? '').trim();
      if (field === 'gtm_container_id' && value) {
        if (!/^GTM-[A-Z0-9]{6,}$/i.test(value)) {
          throw new HttpError(400, 'ID container GTM non valido (formato atteso: GTM-XXXXXXX)');
        }
        value = value.toUpperCase();
      }
      // Normalizza "sito.it" in "https://sito.it/": la verifica automatica ha
      // bisogno di un URL assoluto, e così il confronto resta stabile.
      if (field === 'website_url' && value) value = normalizeUrl(value);

      // Nome di un evento GA4: niente spazi, altrimenti il filtro non troverà
      // mai nulla e il funnel risulterebbe vuoto senza spiegazione.
      if (field === 'lead_event' && value && !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value)) {
        throw new HttpError(
          400,
          'Nome evento non valido: lettere, numeri e underscore, senza spazi (es. generate_lead)',
        );
      }

      // Il Pixel ID è numerico: capita di incollarci dentro spazi o l'intero
      // frammento di codice, e un valore sbagliato farebbe fallire il QA ogni giorno.
      if (field === 'meta_pixel_id' && value) {
        value = value.replace(/\s+/g, '');
        if (!/^\d{8,20}$/.test(value)) {
          throw new HttpError(400, 'Pixel ID Meta non valido: sono solo cifre (es. 1234567890123456)');
        }
      }

      // Il Property ID GA4 è solo numerico: si copia spesso come "properties/123"
      // o "G-XXXX" (che è il Measurement ID, non la property).
      if (field === 'ga4_property_id' && value) {
        value = value.replace(/^properties\//, '').trim();
        if (!/^\d{6,}$/.test(value)) {
          throw new HttpError(
            400,
            'Property ID GA4 non valido: serve il numero della property (es. 123456789), non il Measurement ID G-XXXX',
          );
        }
      }
    }
    out[field] = value;
  }

  if (!partial) {
    if (!out.name) throw new HttpError(400, 'Il nome del cliente è obbligatorio');
  } else if ('name' in out && !out.name) {
    throw new HttpError(400, 'Il nome del cliente non può essere vuoto');
  }

  return out;
}

/** Alla creazione, i canali non pertinenti all'archetipo partono da 'na'. */
function applyArchetypeDefaults(fields) {
  const archetype = archetypeByValue(fields.archetype ?? null);
  if (!archetype) return fields;

  for (const key of CHANNEL_KEYS) {
    const col = `status_${key}`;
    if (col in fields) continue;
    fields[col] = archetype.channels.includes(key) ? 'todo' : 'na';
  }
  return fields;
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM clients ORDER BY name COLLATE NOCASE').all();
  res.json(rows.map(decorate));
});

router.get('/:id', (req, res) => {
  res.json(decorate(findOr404(req.params.id)));
});

router.post('/', (req, res) => {
  const fields = applyArchetypeDefaults(sanitize(req.body ?? {}, { partial: false }));
  const columns = Object.keys(fields);
  const stmt = db.prepare(
    `INSERT INTO clients (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})
     RETURNING *`,
  );

  try {
    res.status(201).json(decorate(stmt.get(...columns.map((c) => fields[c]))));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new HttpError(409, `Esiste già un cliente chiamato "${fields.name}"`);
    }
    throw err;
  }
});

router.patch('/:id', (req, res) => {
  findOr404(req.params.id);
  const fields = sanitize(req.body ?? {}, { partial: true });
  const columns = Object.keys(fields);

  if (columns.length === 0) throw new HttpError(400, 'Nessun campo da aggiornare');

  const stmt = db.prepare(
    `UPDATE clients
        SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now')
      WHERE id = ?
     RETURNING *`,
  );

  try {
    res.json(decorate(stmt.get(...columns.map((c) => fields[c]), req.params.id)));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new HttpError(409, `Esiste già un cliente chiamato "${fields.name}"`);
    }
    throw err;
  }
});

router.delete('/:id', (req, res) => {
  findOr404(req.params.id);
  // Le credenziali cifrate cadono per ON DELETE CASCADE (foreign_keys = ON).
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.status(204).end();
});
