import crypto from 'node:crypto';
import express from 'express';
import {
  clearCookie,
  login,
  revokeSession,
  sessionCookie,
  setPassword,
  tokenFromRequest,
  userCount,
  userFromToken,
} from '../auth.js';
import { HttpError } from '../http-error.js';
import { AUTH_ENABLED } from '../config.js';
import * as vault from '../vault.js';

export const router = express.Router();

/**
 * Una sola password: quella di accesso sblocca anche il vault delle credenziali.
 * Al primo accesso il vault viene creato con la stessa password, agli accessi
 * successivi viene sbloccato. Se il vault era stato creato con una password
 * diversa non si può sbloccare: si segnala e resta bloccato, senza impedire
 * l'accesso alla dashboard.
 */
function syncVault(password) {
  try {
    if (!vault.isInitialized()) {
      vault.setup(password);
      return { state: 'created' };
    }
    if (!vault.isUnlocked()) {
      vault.unlock(password);
      return { state: 'unlocked' };
    }
    return { state: 'already-unlocked' };
  } catch (err) {
    return { state: 'locked', error: err.message };
  }
}

/** Stato dell'accesso: la usa il frontend per decidere se mostrare il login. */
router.get('/me', (req, res) => {
  // Accesso libero: il frontend non deve mostrare nessuna schermata di accesso.
  if (!AUTH_ENABLED) return res.json({ user: null, authDisabled: true });

  const user = userFromToken(tokenFromRequest(req));
  if (!user) return res.status(401).json({ error: 'Accesso richiesto', hasUsers: userCount() > 0 });
  res.json({ user });
});

/**
 * Diagnostica dei tentativi di accesso. Non registra la password: solo la sua
 * lunghezza e i primi 8 caratteri dello SHA-256, che bastano a capire se il
 * browser sta inviando una stringa diversa da quella attesa (spazio incollato,
 * maiuscole, autocompletamento) senza scrivere il segreto nei log.
 */
function logAttempt(email, password, outcome) {
  const received = String(password ?? '');
  const impronta = crypto.createHash('sha256').update(received).digest('hex').slice(0, 8);
  console.log(
    `[auth] ${outcome} · email="${String(email ?? '')}" · ` +
      `lunghezza=${received.length} · impronta=${impronta}`,
  );
}

router.post('/login', (req, res) => {
  try {
    const { user, session } = login(req.body?.email, req.body?.password);
    const vaultState = syncVault(req.body?.password);
    logAttempt(req.body?.email, req.body?.password, `OK (vault: ${vaultState.state})`);
    res.setHeader('Set-Cookie', sessionCookie(session.token, session.expiresAt));
    // Il token viene restituito anche nel corpo: se il browser non conserva il
    // cookie, il frontend lo usa nell'header Authorization e l'accesso funziona
    // comunque. Siamo su localhost, il token non attraversa nessuna rete.
    res.json({ user, vault: vaultState, token: session.token, expiresAt: session.expiresAt });
  } catch (err) {
    logAttempt(req.body?.email, req.body?.password, `RIFIUTATO (${err.status ?? 500}: ${err.message})`);
    throw err;
  }
});

router.post('/logout', (req, res) => {
  revokeSession(tokenFromRequest(req));
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

/** Cambio password: richiede quella attuale e chiude le altre sessioni. */
router.post('/password', (req, res) => {
  const current = userFromToken(tokenFromRequest(req));
  if (!current) throw new HttpError(401, 'Accesso richiesto');

  const { currentPassword, newPassword } = req.body ?? {};
  // Verifica la password attuale riusando il login: se è sbagliata lancia 401.
  login(current.email, currentPassword);

  if (newPassword === currentPassword) {
    throw new HttpError(400, 'La nuova password è identica a quella attuale');
  }

  // La chiave del vault deriva dalla password: va ricifrato tutto *prima* di
  // cambiare la password di accesso, altrimenti le credenziali salvate
  // resterebbero cifrate con una chiave che non si può più ricostruire.
  let rekeyed = null;
  if (vault.isInitialized()) {
    if (!vault.isUnlocked()) vault.unlock(currentPassword);
    rekeyed = vault.rekey(newPassword).rekeyed;
  }

  const result = setPassword(current.email, newPassword);
  res.setHeader('Set-Cookie', clearCookie());
  res.json({
    ...result,
    rekeyed,
    message:
      'Password aggiornata' +
      (rekeyed !== null ? ` · ${rekeyed} credenziali ricifrate` : '') +
      ': rientra con la nuova password',
  });
});
