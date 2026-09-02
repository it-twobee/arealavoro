#!/usr/bin/env node
// Diagnostica per quando "non mi fa accedere".
//
//   npm run doctor
//
// Risponde alle tre domande che si confondono facilmente:
//   1. il server è in ascolto?
//   2. l'account esiste?
//   3. la password è quella giusta?
// La verifica della password avviene in locale sul DB, senza passare da HTTP e
// senza browser: se qui risulta corretta e nella dashboard no, il problema è
// altrove (server spento, cache del browser, autocompletamento).

import readline from 'node:readline';
import { db } from './db.js';
import { listUsers, login } from './auth.js';
import { AUTH_ENABLED } from './config.js';
import { status as vaultStatus } from './vault.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

function askHidden(prompt) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (str) => {
      if (!muted) process.stdout.write(str);
    };
    rl.question(prompt, (answer) => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

console.log(`\nTwoBee OS — diagnostica\n${'─'.repeat(50)}`);

// 1. server in ascolto
let serverUp = false;
try {
  const res = await fetch(`http://${HOST}:${PORT}/api/health`, { signal: AbortSignal.timeout(4000) });
  serverUp = res.ok;
  console.log(`Server        ✓ in ascolto su http://${HOST}:${PORT}`);
} catch {
  console.log(`Server        ✗ NON in ascolto su http://${HOST}:${PORT}`);
  console.log('              → apri un terminale nella cartella e lancia: npm run dev');
  console.log('              → finché il server è spento, la schermata di accesso non può funzionare');
}

// 2. modalità di accesso e account
const users = listUsers();
if (!AUTH_ENABLED) {
  console.log('Accesso       LIBERO, nessuna password richiesta');
  console.log('              → per riattivarlo: set TWOBEE_AUTH=on && npm run dev');
  if (users.length) console.log(`              (${users.length} account in archivio, inutilizzati finché è spento)`);
} else if (users.length === 0) {
  console.log('Account       ✗ nessuno');
  console.log('              → creane uno: npm run user:add -- tua@email.it');
} else {
  console.log(`Account       ✓ ${users.length}`);
  for (const u of users) {
    console.log(`              ${u.email} · ultimo accesso ${u.last_login_at ?? 'mai'}`);
  }
}

// 3. sessioni e vault, per completezza
const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
const vault = vaultStatus();
console.log(`Sessioni      ${sessions} attive`);
console.log(
  `Vault         ${
    vault.initialized ? 'attivo' : 'non impostato'
  } · serve solo a cifrare le chiavi API, non all'accesso`,
);

// 4. verifica password, su richiesta (solo con accesso protetto)
if (AUTH_ENABLED && users.length > 0 && process.stdin.isTTY) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log('Verifica della password (invio a vuoto per saltare).');
  const email = (await askHidden(`Email [${users[0].email}]: `)) || users[0].email;
  const password = await askHidden('Password: ');

  if (!password) {
    console.log('Saltata.');
  } else {
    try {
      login(email, password);
      console.log('\n✓ La password è corretta per questo account.');
      if (!serverUp) {
        console.log('  Il problema è il server spento, non le credenziali: lancia npm run dev.');
      } else {
        console.log('  Credenziali e server sono a posto. Se la dashboard rifiuta comunque:');
        console.log('  · ricarica forzando la cache con Ctrl+Shift+R');
        console.log("  · controlla che il browser non stia autocompletando una password diversa");
        console.log('  · dopo 5 tentativi falliti l\'accesso è bloccato 15 minuti: riavvia il server per azzerarlo');
      }
    } catch (err) {
      console.log(`\n✗ ${err.message}`);
      if (err.status === 429) {
        console.log('  Il blocco è temporaneo e in memoria: riavviando il server si azzera subito.');
      } else {
        console.log('  Per reimpostarla: npm run user:password -- ' + email);
      }
    }
  }
}

console.log('');
process.exit(0);
