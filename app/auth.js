// Accesso alla dashboard: utenti, password, sessioni.
//
// Distinzione importante rispetto al vault: qui si autentica *chi* usa la
// dashboard, il vault decide *se* le credenziali cifrate sono leggibili. Sono
// due password diverse e due meccanismi diversi — la sessione di accesso
// sopravvive al riavvio del server, la chiave di cifratura no (per scelta).

import crypto from 'node:crypto';
import { db } from './db.js';
import { HttpError } from './http-error.js';

const KDF = { N: 131072, r: 8, p: 1, keyLen: 32, maxmem: 200 * 1024 * 1024 };
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const SESSION_DAYS = 30;
const MIN_PASSWORD_LENGTH = 8;

export const COOKIE_NAME = 'twobee_session';

// Freno ai tentativi ripetuti. In memoria: è un'app locale monoutente, non
// serve persistenza, serve solo rendere inutile un ciclo di prove.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map();

/* ---------- password ---------- */

function derive(password, salt) {
  return crypto.scryptSync(password, salt, KDF.keyLen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: KDF.maxmem,
  });
}

export function assertPasswordAcceptable(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `La password deve essere di almeno ${MIN_PASSWORD_LENGTH} caratteri`);
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  return { hash: derive(password, salt).toString('hex'), salt: salt.toString('hex') };
}

function passwordMatches(password, user) {
  const expected = Buffer.from(user.password_hash, 'hex');
  const actual = derive(password, Buffer.from(user.password_salt, 'hex'));
  // Confronto a tempo costante: senza, la durata del confronto è un indizio.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError(400, `Email non valida: ${email}`);
  return value;
}

/* ---------- utenti ---------- */

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function findUser(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) ?? null;
}

export function listUsers() {
  return db
    .prepare('SELECT id, email, created_at, updated_at, last_login_at FROM users ORDER BY email')
    .all();
}

export function createUser(email, password) {
  const normalized = normalizeEmail(email);
  assertPasswordAcceptable(password);

  const { hash, salt } = hashPassword(password);
  try {
    return db
      .prepare(
        `INSERT INTO users (email, password_hash, password_salt) VALUES (?, ?, ?)
         RETURNING id, email, created_at`,
      )
      .get(normalized, hash, salt);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new HttpError(409, `Esiste già un account con l'email ${normalized}`);
    }
    throw err;
  }
}

/** Cambia la password e invalida tutte le sessioni di quell'utente. */
export function setPassword(email, password) {
  const user = findUser(email);
  if (!user) throw new HttpError(404, `Nessun account con l'email ${normalizeEmail(email)}`);
  assertPasswordAcceptable(password);

  const { hash, salt } = hashPassword(password);
  db.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(hash, salt, user.id);

  // Cambiare password deve far cadere le sessioni aperte, altrimenti chi era
  // già dentro con la vecchia password resta dentro.
  const { changes } = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  attempts.delete(user.email);
  return { email: user.email, revokedSessions: changes };
}

export function deleteUser(email) {
  const normalized = normalizeEmail(email);
  const { changes } = db.prepare('DELETE FROM users WHERE email = ?').run(normalized);
  if (changes === 0) throw new HttpError(404, `Nessun account con l'email ${normalized}`);
  return { email: normalized };
}

/* ---------- sessioni ---------- */

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(userId) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();

  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    tokenHash(token),
    userId,
    expiresAt,
  );
  return { token, expiresAt };
}

/** Utente della sessione, o null. Ripulisce le sessioni scadute strada facendo. */
export function userFromToken(token) {
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.id, u.email
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(tokenHash(token));
  if (!row) return null;

  if (new Date(row.expires_at) <= new Date()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }

  db.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE token_hash = ?").run(row.token_hash);
  return { id: row.id, email: row.email };
}

export function revokeSession(token) {
  if (!token) return false;
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)).changes > 0;
}

/* ---------- login ---------- */

function checkLockout(email) {
  const record = attempts.get(email);
  if (!record) return;

  if (Date.now() - record.firstAt > LOCKOUT_MS) {
    attempts.delete(email);
    return;
  }
  if (record.count >= MAX_ATTEMPTS) {
    const minutes = Math.ceil((LOCKOUT_MS - (Date.now() - record.firstAt)) / 60000);
    throw new HttpError(429, `Troppi tentativi falliti. Riprova tra ${minutes} minuti.`);
  }
}

function recordFailure(email) {
  const record = attempts.get(email);
  if (record && Date.now() - record.firstAt <= LOCKOUT_MS) record.count += 1;
  else attempts.set(email, { count: 1, firstAt: Date.now() });
}

export function login(email, password) {
  const normalized = normalizeEmail(email);
  checkLockout(normalized);

  const user = findUser(normalized);
  // Stesso messaggio per email inesistente e password errata: non si rivela
  // quali indirizzi esistono.
  if (!user || !passwordMatches(String(password ?? ''), user)) {
    recordFailure(normalized);
    throw new HttpError(401, 'Email o password non corretti');
  }

  attempts.delete(normalized);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);

  return { user: { id: user.id, email: user.email }, session: createSession(user.id) };
}

/* ---------- integrazione express ---------- */

/**
 * Token della richiesta: prima l'header Authorization, poi il cookie.
 *
 * Il cookie resta il meccanismo principale (HttpOnly, non leggibile da JS), ma
 * alcuni browser con impostazioni restrittive sui cookie non lo conservano
 * nemmeno per localhost: in quel caso l'accesso riusciva e la richiesta
 * successiva risultava non autenticata, con un anello di login infinito.
 * L'header è la via di riserva che rende l'accesso indipendente da quella
 * impostazione.
 */
export function tokenFromRequest(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  return readCookie(req, COOKIE_NAME);
}

/** Parsing minimo dei cookie: una sola voce da leggere, nessuna dipendenza. */
export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

export function sessionCookie(token, expiresAt) {
  // Secure omesso di proposito: la dashboard gira su http://127.0.0.1 e con
  // Secure il cookie non verrebbe mai memorizzato.
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ].join('; ');
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Middleware: popola req.user, e blocca se manca una sessione valida. */
export function requireAuth(req, res, next) {
  const user = userFromToken(tokenFromRequest(req));
  if (!user) {
    throw new HttpError(401, 'Accesso richiesto');
  }
  req.user = user;
  next();
}
