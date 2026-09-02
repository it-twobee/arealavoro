// Backup cifrato dell'intero twobee.db.
//
// Snapshot: db.serialize() invece di copiare il file, perché una copia grezza
// perderebbe le scritture ancora nel WAL (verificato: serialize le include).
// Cifratura: stessa chiave delle credenziali, quindi il file è inutile senza
// la master password. L'header contiene salt e parametri KDF, così il ripristino
// funziona anche se il DB originale non esiste più — vedi backup/decrypt.js.

import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT } from './db.js';
import { HttpError } from './http-error.js';
import { KDF, getSetting, requireKey, sealWithKey, setSetting, vaultSalt, isUnlocked } from './vault.js';

const MAGIC = Buffer.from('TBBK', 'ascii');
const FORMAT_VERSION = 1;
export const BACKUP_EXT = '.tbenc';
const KEEP_LAST = 30;

/** Cartelle tipiche di Google Drive for Desktop su Windows. */
function driveCandidates() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const named = ['Il mio Drive', 'My Drive'];
  const candidates = [];

  for (const letter of ['G', 'H', 'I', 'J', 'K']) {
    for (const name of named) candidates.push(`${letter}:\\${name}`);
  }
  if (home) {
    candidates.push(path.join(home, 'Google Drive'), path.join(home, 'My Drive'));
  }
  return candidates;
}

/** Cartella di default: Google Drive se presente, altrimenti locale. */
export function defaultBackupDir() {
  for (const candidate of driveCandidates()) {
    try {
      if (fs.statSync(candidate).isDirectory()) return path.join(candidate, 'TwoBee OS Backup');
    } catch {
      // percorso inesistente: si passa al prossimo
    }
  }
  return path.join(ROOT, 'backup', 'local');
}

export function getBackupDir() {
  return getSetting('backup_dir') ?? defaultBackupDir();
}

/** Il backup ha senso solo se la cartella è sincronizzata da qualcosa. */
export function looksCloudSynced(dir) {
  return /google drive|my drive|il mio drive|onedrive|dropbox|icloud/i.test(dir);
}

/**
 * Un backup dentro la cartella del progetto non è un backup: se si perde o si
 * corrompe quella cartella, sparisce insieme all'originale. Va segnalato anche
 * quando risulta "sincronizzato", perché lo è solo di riflesso.
 */
export function isInsideProject(dir) {
  const rel = path.relative(ROOT, path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function setBackupDir(dir) {
  const resolved = path.resolve(String(dir ?? '').trim());
  if (!resolved) throw new HttpError(400, 'Percorso mancante');

  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch (err) {
    throw new HttpError(400, `Cartella non utilizzabile: ${err.message}`);
  }

  setSetting('backup_dir', resolved);
  return getBackupDir();
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Header autodescrittivo:
 * magic(4) | version(1) | N(4 LE) | r(1) | p(1) | saltLen(1) | salt
 * seguito da iv(12) | authTag(16) | ciphertext.
 */
function buildHeader(salt) {
  const head = Buffer.alloc(11);
  MAGIC.copy(head, 0);
  head.writeUInt8(FORMAT_VERSION, 4);
  head.writeUInt32LE(KDF.N, 5);
  head.writeUInt8(KDF.r, 9);
  head.writeUInt8(KDF.p, 10);

  const saltLen = Buffer.from([salt.length]);
  return Buffer.concat([head, saltLen, salt]);
}

/** Esegue il backup. `reason` finisce solo nei log, non nel file. */
export function runBackup(reason = 'manuale') {
  const key = requireKey(); // 423 se bloccato: senza chiave non si cifra
  const dir = getBackupDir();
  fs.mkdirSync(dir, { recursive: true });

  const snapshot = db.serialize();
  const payload = Buffer.concat([buildHeader(vaultSalt()), sealWithKey(key, snapshot)]);

  const file = path.join(dir, `twobee-${timestamp()}${BACKUP_EXT}`);
  // Scrittura atomica: un file .tbenc troncato a metà sarebbe indistinguibile
  // da uno valido finché non si prova a decifrarlo.
  const temp = `${file}.part`;
  fs.writeFileSync(temp, payload);
  fs.renameSync(temp, file);

  setSetting('backup_last_at', new Date().toISOString());
  setSetting('backup_last_file', file);

  const removed = applyRetention(dir);
  console.log(`[backup] ${reason}: ${file} (${payload.length} byte, snapshot ${snapshot.length})`);

  return { file, bytes: payload.length, snapshotBytes: snapshot.length, removed, dir };
}

/** Tiene gli ultimi KEEP_LAST backup, elimina i più vecchi. */
function applyRetention(dir) {
  const files = listBackups(dir);
  const excess = files.slice(KEEP_LAST);
  for (const entry of excess) {
    try {
      fs.rmSync(entry.path);
    } catch {
      // se il file è lockato dalla sincronizzazione si riprova al giro dopo
    }
  }
  return excess.length;
}

/** Backup presenti, dal più recente. */
export function listBackups(dir = getBackupDir()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .filter((name) => name.endsWith(BACKUP_EXT))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { name, path: full, bytes: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

export function backupStatus() {
  const dir = getBackupDir();
  return {
    dir,
    dirExists: fs.existsSync(dir),
    cloudSynced: looksCloudSynced(dir),
    insideProject: isInsideProject(dir),
    isDefault: getSetting('backup_dir') === null,
    lastAt: getSetting('backup_last_at'),
    lastFile: getSetting('backup_last_file'),
    keepLast: KEEP_LAST,
    backups: listBackups(dir),
  };
}

/**
 * Backup automatico alla chiusura. Tre limiti, dichiarati perché non aggirabili:
 *  - se il vault è bloccato non c'è chiave, quindi si salta;
 *  - un kill forzato (Task Manager, `Stop-Process -Force`) non manda segnali:
 *    su Windows solo Ctrl+C nel terminale produce un vero SIGINT;
 *  - in modalità --watch si salta, per non riempire la cartella a ogni salvataggio.
 * runBackup è interamente sincrono, quindi funziona anche dentro 'exit'.
 */
export function installShutdownHooks() {
  const watchMode = process.execArgv.some((arg) => arg.startsWith('--watch'));
  let done = false;

  const onShutdown = (origin, { exit = true } = {}) => {
    if (done) return;
    done = true;

    if (watchMode) {
      console.log(`[backup] ${origin}: salto il backup automatico (modalità --watch)`);
    } else if (!isUnlocked()) {
      console.log(`[backup] ${origin}: vault bloccato, backup automatico saltato`);
    } else {
      try {
        runBackup(`automatico alla chiusura (${origin})`);
      } catch (err) {
        console.error(`[backup] fallito alla chiusura: ${err.message}`);
      }
    }
    if (exit) process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => onShutdown(signal));
  }
  // Uscita "naturale" del processo: nessun exit() forzato, si lascia finire.
  process.on('beforeExit', () => onShutdown('beforeExit', { exit: false }));

  return onShutdown;
}
