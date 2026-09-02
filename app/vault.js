// Vault: master password -> chiave di cifratura -> credenziali cifrate.
//
// Regole non negoziabili di questo file:
//  - la master password non viene mai scritta da nessuna parte, nemmeno in log;
//  - la chiave derivata vive solo in `sessionKey`, una variabile di processo:
//    riavviando il server si torna bloccati e va reinserita la password;
//  - a DB finiscono solo salt, parametri KDF e un verificatore cifrato.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db.js';
import { HttpError } from './http-error.js';

// scrypt: ~130 MB di memoria e ~200 ms per derivazione su hardware desktop.
// Costoso per un attacco a dizionario, impercettibile per uno sblocco manuale.
export const KDF = { N: 131072, r: 8, p: 1, keyLen: 32, maxmem: 200 * 1024 * 1024 };

// Testo noto cifrato allo setup: se si decifra con la chiave derivata, la
// password è giusta. Serve a validare senza conservare la password.
const VERIFIER_PLAINTEXT = 'twobee-os-vault-v1';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const MIN_PASSWORD_LENGTH = 8;

/** Unica copia della chiave, solo in RAM. Mai serializzata, mai loggata. */
let sessionKey = null;

/* ---------- app_settings ---------- */

export function getSetting(key) {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}

/* ---------- derivazione e cifratura ---------- */

export function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, KDF.keyLen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: KDF.maxmem,
  });
}

/** Cifra con una chiave esplicita. Ritorna iv | authTag | ciphertext. */
export function sealWithKey(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Inverso di sealWithKey. Lancia se i dati sono corrotti o la chiave è errata. */
export function openWithKey(key, sealed) {
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/* ---------- stato ---------- */

export function isInitialized() {
  return Boolean(getSetting('vault_salt') && getSetting('vault_verifier'));
}

export function isUnlocked() {
  return sessionKey !== null;
}

export function status() {
  return { initialized: isInitialized(), unlocked: isUnlocked(), minPasswordLength: MIN_PASSWORD_LENGTH };
}

/** La chiave di sessione, per chi deve cifrare (credenziali, backup). */
export function requireKey() {
  if (!sessionKey) throw new HttpError(423, 'Vault bloccato: inserisci la master password');
  return sessionKey;
}

export function vaultSalt() {
  const hex = getSetting('vault_salt');
  if (!hex) throw new HttpError(409, 'Vault non inizializzato');
  return Buffer.from(hex, 'hex');
}

/* ---------- ciclo di vita ---------- */

function assertPasswordAcceptable(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `La master password deve essere di almeno ${MIN_PASSWORD_LENGTH} caratteri`);
  }
}

/** Primo avvio: fissa la master password e apre la sessione. */
export function setup(password) {
  if (isInitialized()) throw new HttpError(409, 'Master password già impostata');
  assertPasswordAcceptable(password);

  const salt = crypto.randomBytes(SALT_BYTES);
  const key = deriveKey(password, salt);

  setSetting('vault_salt', salt.toString('hex'));
  setSetting('vault_kdf', JSON.stringify({ algo: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p }));
  setSetting('vault_verifier', sealWithKey(key, Buffer.from(VERIFIER_PLAINTEXT, 'utf8')).toString('base64'));
  setSetting('vault_created_at', new Date().toISOString());

  sessionKey = key;
  return status();
}

export function unlock(password) {
  if (!isInitialized()) throw new HttpError(409, 'Master password non ancora impostata');
  if (typeof password !== 'string' || password === '') {
    throw new HttpError(400, 'Password mancante');
  }

  const key = deriveKey(password, vaultSalt());
  const verifier = Buffer.from(getSetting('vault_verifier'), 'base64');

  try {
    // L'authTag GCM fallisce se la chiave è sbagliata: nessun confronto manuale.
    if (openWithKey(key, verifier).toString('utf8') !== VERIFIER_PLAINTEXT) throw new Error();
  } catch {
    throw new HttpError(401, 'Master password errata');
  }

  sessionKey = key;
  return status();
}

export function lock() {
  sessionKey = null;
  return status();
}

/**
 * Reset senza recovery key: le credenziali cifrate con la vecchia chiave
 * diventano indecifrabili, quindi vanno cancellate. Si riparte da zero
 * (le chiavi API si recuperano dalle piattaforme originali).
 */
export function reset(newPassword) {
  assertPasswordAcceptable(newPassword);

  const wiped = db.prepare('DELETE FROM credentials').run().changes;
  for (const key of ['vault_salt', 'vault_kdf', 'vault_verifier', 'vault_created_at']) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }
  sessionKey = null;

  setup(newPassword);
  return { ...status(), wipedCredentials: wiped };
}

/* ---------- chiave su file (accesso libero) ---------- */

/**
 * Senza password di accesso non c'è nulla da cui derivare la chiave, ma le
 * credenziali dei clienti non possono stare in chiaro: il database vive dentro
 * OneDrive, quindi una copia finisce nel cloud.
 *
 * La chiave sta in un file **fuori** dalla cartella sincronizzata
 * (%LOCALAPPDATA%), quindi il .db da solo è inutilizzabile: chi ottenesse il
 * file sincronizzato non avrebbe la chiave. Contro chi usa questo PC non
 * protegge: per quello serve una password, e si riattiva con TWOBEE_AUTH=on.
 */
export function keyFilePath() {
  const base =
    process.env.LOCALAPPDATA ?? process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'TwoBeeOS', 'vault.key');
}

/** Legge la chiave, creandola al primo avvio. 64 caratteri esadecimali casuali. */
export function ensureKeyFile() {
  const file = keyFilePath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= MIN_PASSWORD_LENGTH) return existing;
  } catch {
    // non esiste ancora: si crea sotto
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  console.log(`[vault] chiave di cifratura creata in ${file}`);
  return secret;
}

/** Apre il vault con la chiave su file. Nessuna password richiesta all'utente. */
export function autoUnlock() {
  const secret = ensureKeyFile();
  try {
    if (!isInitialized()) {
      setup(secret);
      return { state: 'created', file: keyFilePath() };
    }
    unlock(secret);
    return { state: 'unlocked', file: keyFilePath() };
  } catch (err) {
    // Tipico se il vault era stato creato con una password: resta bloccato e si
    // reimposta dalla dashboard (le credenziali dentro non sono recuperabili).
    return { state: 'locked', error: err.message, file: keyFilePath() };
  }
}

/**
 * Cambia la chiave conservando le credenziali: le decifra con quella corrente e
 * le ricifra con quella nuova. Serve quando cambia la password di accesso, da
 * cui la chiave deriva. Senza questo un cambio password renderebbe illeggibili
 * tutte le credenziali già salvate.
 */
export function rekey(newPassword) {
  const oldKey = requireKey();
  assertPasswordAcceptable(newPassword);

  const readAll = (table, idColumn) =>
    db
      .prepare(`SELECT ${idColumn} AS id, blob FROM ${table}`)
      .all()
      .map((row) => ({
        id: row.id,
        value: openWithKey(oldKey, Buffer.from(row.blob, 'base64')),
      }));

  // Si decifra tutto prima di toccare il DB: se una credenziale non si apre,
  // meglio fallire senza aver cambiato niente.
  const clientCredentials = readAll('credentials', 'id');
  const agencyCredentials = readAll('agency_credentials', 'platform');

  const salt = crypto.randomBytes(SALT_BYTES);
  const newKey = deriveKey(newPassword, salt);

  db.exec('BEGIN');
  try {
    setSetting('vault_salt', salt.toString('hex'));
    setSetting('vault_verifier', sealWithKey(newKey, Buffer.from(VERIFIER_PLAINTEXT, 'utf8')).toString('base64'));

    const updateClient = db.prepare('UPDATE credentials SET blob = ? WHERE id = ?');
    for (const item of clientCredentials) {
      updateClient.run(sealWithKey(newKey, item.value).toString('base64'), item.id);
    }
    const updateAgency = db.prepare('UPDATE agency_credentials SET blob = ? WHERE platform = ?');
    for (const item of agencyCredentials) {
      updateAgency.run(sealWithKey(newKey, item.value).toString('base64'), item.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new HttpError(500, `Ricifratura non riuscita, nulla è stato modificato: ${err.message}`);
  }

  sessionKey = newKey;
  return { rekeyed: clientCredentials.length + agencyCredentials.length };
}

/* ---------- credenziali ---------- */

export function seal(plaintext) {
  return sealWithKey(requireKey(), Buffer.from(plaintext, 'utf8')).toString('base64');
}

export function open(blobBase64) {
  try {
    return openWithKey(requireKey(), Buffer.from(blobBase64, 'base64')).toString('utf8');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Tipico dopo un reset: dati cifrati con una chiave che non esiste più.
    throw new HttpError(422, 'Credenziale non decifrabile con la chiave corrente');
  }
}
