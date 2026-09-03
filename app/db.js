// SQLite (node:sqlite, nessuna dipendenza nativa) + migrazioni versionate.
// I moduli successivi (credenziali, report, QA) aggiungono una voce a MIGRATIONS.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(APP_DIR, '..');
export const DB_PATH = process.env.TWOBEE_DB ?? path.join(ROOT, 'twobee.db');

const MIGRATIONS = [
  {
    version: 1,
    name: 'clients',
    up(db) {
      db.exec(`
        CREATE TABLE clients (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          name              TEXT    NOT NULL UNIQUE,
          archetype         TEXT,
          cms               TEXT    NOT NULL DEFAULT '',
          gtm_container_id  TEXT    NOT NULL DEFAULT '',
          status_gtm        TEXT    NOT NULL DEFAULT 'todo',
          status_ga4        TEXT    NOT NULL DEFAULT 'todo',
          status_meta_pixel TEXT    NOT NULL DEFAULT 'todo',
          status_klaviyo    TEXT    NOT NULL DEFAULT 'todo',
          status_gsc        TEXT    NOT NULL DEFAULT 'todo',
          notes             TEXT    NOT NULL DEFAULT '',
          created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_clients_name ON clients(name);
      `);
    },
  },
  {
    version: 2,
    name: 'vault + credenziali',
    up(db) {
      db.exec(`
        -- Config non segreta + parametri KDF e verificatore della master password.
        -- Qui NON finisce mai la password né la chiave di cifratura.
        CREATE TABLE app_settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        -- Una credenziale per cliente/piattaforma. La colonna blob contiene
        -- base64 di iv(12) | authTag(16) | ciphertext, cifrato AES-256-GCM.
        CREATE TABLE credentials (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id  INTEGER NOT NULL,
          platform   TEXT    NOT NULL,
          blob       TEXT    NOT NULL,
          updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE (client_id, platform),
          FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 3,
    name: 'tracking: url sito, checklist, verifiche',
    up(db) {
      db.exec(`
        -- Serve alla verifica automatica: l'unico dato richiesto oltre al container.
        ALTER TABLE clients ADD COLUMN website_url TEXT NOT NULL DEFAULT '';

        -- Stato di avanzamento della checklist, per cliente e per voce.
        -- Le voci NON stanno qui: vivono nei file lib/tracking/templates/, così la
        -- checklist si aggiorna senza migrazioni e resta versionabile.
        CREATE TABLE checklist_state (
          client_id  INTEGER NOT NULL,
          item_id    TEXT    NOT NULL,
          done       INTEGER NOT NULL DEFAULT 0,
          note       TEXT    NOT NULL DEFAULT '',
          updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (client_id, item_id),
          FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
        );

        -- Storico delle verifiche automatiche sul sito. Tenerlo permette di
        -- distinguere "non l'ho mai controllato" da "controllato e non trovato".
        CREATE TABLE tracking_checks (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id    INTEGER NOT NULL,
          checked_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          url          TEXT    NOT NULL,
          ok           INTEGER NOT NULL,
          http_status  INTEGER,
          error        TEXT,
          gtm_ids      TEXT    NOT NULL DEFAULT '[]',
          ga4_ids      TEXT    NOT NULL DEFAULT '[]',
          meta_ids     TEXT    NOT NULL DEFAULT '[]',
          klaviyo      INTEGER NOT NULL DEFAULT 0,
          changes      TEXT    NOT NULL DEFAULT '[]',
          bytes        INTEGER,
          duration_ms  INTEGER,
          FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_checks_client ON tracking_checks(client_id, checked_at DESC);
      `);
    },
  },
  {
    version: 4,
    name: 'reporting: credenziali agenzia, identificativi, report',
    up(db) {
      db.exec(`
        -- Segreti a livello agenzia (una copia per tutto il portafoglio):
        -- service account GA4, developer/refresh token Ads, system user token Meta.
        -- Cifrati come le credenziali per cliente, stessa chiave di sessione.
        CREATE TABLE agency_credentials (
          platform   TEXT PRIMARY KEY,
          blob       TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Identificativi per cliente: non sono segreti, stanno in chiaro.
        ALTER TABLE clients ADD COLUMN ga4_property_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE clients ADD COLUMN google_ads_customer_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE clients ADD COLUMN meta_ad_account_id TEXT NOT NULL DEFAULT '';

        -- Un'esecuzione di report. Il periodo viene congelato qui: rigenerando
        -- domani lo stesso report i numeri cambiano, e lo storico deve dire
        -- esattamente cosa era stato chiesto.
        CREATE TABLE report_runs (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id      INTEGER NOT NULL,
          source         TEXT    NOT NULL,
          definition     TEXT    NOT NULL,
          definition_ver INTEGER,
          period_start   TEXT    NOT NULL,
          period_end     TEXT    NOT NULL,
          compare_start  TEXT,
          compare_end    TEXT,
          ok             INTEGER NOT NULL,
          error          TEXT,
          row_count      INTEGER NOT NULL DEFAULT 0,
          duration_ms    INTEGER,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
        );

        -- Schema comune di normalizzazione: dimensioni e metriche come JSON,
        -- così Google Ads e Meta si innestano senza toccare lo schema.
        CREATE TABLE report_rows (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id     INTEGER NOT NULL,
          period     TEXT    NOT NULL,
          scope      TEXT    NOT NULL,
          breakdown  TEXT,
          dimensions TEXT    NOT NULL DEFAULT '{}',
          metrics    TEXT    NOT NULL,
          FOREIGN KEY (run_id) REFERENCES report_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_runs_client ON report_runs(client_id, created_at DESC);
        CREATE INDEX idx_rows_run ON report_rows(run_id);
      `);
    },
  },
  {
    version: 5,
    name: 'accesso: utenti e sessioni',
    up(db) {
      db.exec(`
        -- Della password si conserva solo l'hash scrypt con il suo salt.
        CREATE TABLE users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          email         TEXT    NOT NULL UNIQUE,
          password_hash TEXT    NOT NULL,
          password_salt TEXT    NOT NULL,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
          last_login_at TEXT
        );

        -- Sessioni a DB, così sopravvivono al riavvio del server. Del token si
        -- salva solo lo SHA-256: se il DB finisce in mano a qualcuno, i token
        -- non sono riutilizzabili.
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id    INTEGER NOT NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT    NOT NULL,
          last_seen  TEXT    NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_sessions_user ON sessions(user_id);
      `);
    },
  },
  {
    version: 6,
    name: 'accessi account per cliente',
    up(db) {
      db.exec(`
        -- Accessi ad account (Instagram, Gmail, registrar del dominio…): cosa
        -- diversa dalle chiavi API in 'credentials', perché serve la coppia
        -- utente + password, più indirizzo e note.
        -- Nessun vincolo di unicità sul servizio: un cliente può avere due
        -- profili Instagram o tre caselle di posta.
        CREATE TABLE client_accounts (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id  INTEGER NOT NULL,
          service    TEXT    NOT NULL,
          label      TEXT    NOT NULL DEFAULT '',
          username   TEXT    NOT NULL DEFAULT '',
          secret     TEXT    NOT NULL DEFAULT '',
          url        TEXT    NOT NULL DEFAULT '',
          note       TEXT    NOT NULL DEFAULT '',
          sort       INTEGER NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_accounts_client ON client_accounts(client_id, sort, id);
      `);
    },
  },
  {
    version: 7,
    name: 'QA giornaliero',
    up(db) {
      db.exec(`
        -- Il Pixel ID non è un segreto (sta nell'HTML di ogni pagina): va in
        -- chiaro accanto all'ID container GTM, che è il suo equivalente.
        ALTER TABLE clients ADD COLUMN meta_pixel_id TEXT NOT NULL DEFAULT '';

        -- Stato corrente di ogni controllo, uno per cliente e per tipo: è ciò
        -- che serve ai badge. Viene sovrascritto a ogni esecuzione.
        CREATE TABLE qa_results (
          client_id  INTEGER NOT NULL,
          check_key  TEXT    NOT NULL,
          status     TEXT    NOT NULL,
          detail     TEXT    NOT NULL DEFAULT '',
          checked_at TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (client_id, check_key),
          FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
        );

        -- Registro delle esecuzioni: serve a sapere se il controllo di oggi è
        -- già stato fatto, visto che il server si riavvia spesso.
        CREATE TABLE qa_runs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT,
          origin      TEXT    NOT NULL,
          clients     INTEGER NOT NULL DEFAULT 0,
          problems    INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER
        );
      `);
    },
  },
  {
    version: 8,
    name: 'evento chiave per cliente (funnel lead gen)',
    up(db) {
      db.exec(`
        -- Evento che segna il lead nel funnel B2B. Vuoto = 'generate_lead',
        -- che è la convenzione GA4; si personalizza per i clienti che hanno
        -- chiamato diversamente l'evento in GTM.
        ALTER TABLE clients ADD COLUMN lead_event TEXT NOT NULL DEFAULT '';
      `);
    },
  },
];

// Elenco clienti iniziale, caricato solo al primo avvio (tabella vuota).
// Sta in clients/seed.json, fuori dal repository: contiene nomi di clienti reali
// e container GTM, cioè dati d'esercizio che non vanno versionati. Se il file
// non c'è si parte semplicemente da zero.
function loadSeedClients() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'clients', 'seed.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const pending = MIGRATIONS.filter((m) => m.version > current);

  for (const m of pending) {
    db.exec('BEGIN');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      console.log(`[db] migrazione ${m.version} (${m.name}) applicata`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return pending.length;
}

function seed(db) {
  const SEED_CLIENTS = loadSeedClients();
  if (SEED_CLIENTS.length === 0) return 0;

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM clients').get();
  if (n > 0) return 0;

  const insert = db.prepare(`
    INSERT INTO clients (name, archetype, cms, gtm_container_id,
                         status_gtm, status_ga4, status_meta_pixel, status_klaviyo, status_gsc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of SEED_CLIENTS) {
    insert.run(
      c.name,
      c.archetype,
      c.cms ?? '',
      c.gtm_container_id ?? '',
      c.status_gtm ?? 'todo',
      c.status_ga4 ?? 'todo',
      c.status_meta_pixel ?? 'todo',
      c.status_klaviyo ?? 'todo',
      c.status_gsc ?? 'todo',
    );
  }
  console.log(`[db] seed: ${SEED_CLIENTS.length} clienti importati`);
  return SEED_CLIENTS.length;
}

export function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  seed(db);
  return db;
}

export const db = openDb();

// `npm run db:reset` — cancella il DB e lo ricrea con il seed.
if (process.argv.includes('--reset')) {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
  console.log(`[db] rimosso ${DB_PATH}`);
  openDb().close();
  console.log('[db] ricreato');
}
