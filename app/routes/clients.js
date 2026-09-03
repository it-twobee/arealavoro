import express from 'express';
import { db } from '../db.js';
import { CHANNEL_KEYS, archetypeByValue, trackingBadge } from '../archetypes.js';
import { HttpError } from '../http-error.js';
import {
  normalizeUrl,
  parseArchetype,
  parseGa4PropertyId,
  parseGtmContainerId,
  parseLeadEvent,
  parseMetaPixelId,
  parseStatus,
} from '../../lib/tracking/validate.ts';

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

  // I validatori vengono dal nucleo condiviso: stesse regole e stessi messaggi
  // del CRM. Lanciano un errore con status 400 se il valore non va bene.
  const parsers = {
    archetype: parseArchetype,
    gtm_container_id: parseGtmContainerId,
    website_url: normalizeUrl,
    lead_event: parseLeadEvent,
    meta_pixel_id: parseMetaPixelId,
    ga4_property_id: parseGa4PropertyId,
  };

  for (const field of WRITABLE) {
    if (!(field in body)) continue;
    const value = body[field];

    if (STATUS_COLUMNS.includes(field)) {
      out[field] = parseStatus(field, value);
    } else if (field in parsers) {
      out[field] = parsers[field](value);
    } else {
      out[field] = String(value ?? '').trim();
    }
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
