#!/usr/bin/env node
// Gestione degli account di accesso da riga di comando.
//
//   npm run user:list
//   npm run user:add -- g.saraiello@twobee.it
//   npm run user:password -- g.saraiello@twobee.it
//   npm run user:remove -- vecchio@twobee.it
//
// La password si digita al prompt e non viene mostrata: così non finisce né in
// un file del progetto né nella cronologia della shell. Per gli script non
// interattivi si può usare la variabile TWOBEE_NEW_PASSWORD.

import readline from 'node:readline';
import { createUser, deleteUser, listUsers, setPassword, assertPasswordAcceptable } from './auth.js';

function askHidden(prompt) {
  if (process.env.TWOBEE_NEW_PASSWORD) return Promise.resolve(process.env.TWOBEE_NEW_PASSWORD);
  if (!process.stdin.isTTY) {
    throw new Error(
      'Serve un terminale interattivo per digitare la password (oppure imposta TWOBEE_NEW_PASSWORD)',
    );
  }

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
    muted = true; // il prompt è già stampato: da qui non si eco più nulla
  });
}

async function askPasswordTwice() {
  const password = await askHidden('Password: ');
  assertPasswordAcceptable(password);

  if (!process.env.TWOBEE_NEW_PASSWORD) {
    const confirm = await askHidden('Ripeti la password: ');
    if (password !== confirm) throw new Error('Le due password non coincidono');
  }
  return password;
}

const [command, email] = process.argv.slice(2);

const commands = {
  async list() {
    const users = listUsers();
    if (users.length === 0) return console.log('Nessun account. Creane uno con: npm run user:add -- email@dominio');
    for (const u of users) {
      console.log(`  ${u.email.padEnd(32)} creato ${u.created_at} · ultimo accesso ${u.last_login_at ?? 'mai'}`);
    }
  },

  async add() {
    if (!email) throw new Error('Uso: npm run user:add -- email@dominio');
    const password = await askPasswordTwice();
    const user = createUser(email, password);
    console.log(`Account creato: ${user.email}`);
  },

  async password() {
    if (!email) throw new Error('Uso: npm run user:password -- email@dominio');
    const password = await askPasswordTwice();
    const result = setPassword(email, password);
    console.log(
      `Password aggiornata per ${result.email}` +
        (result.revokedSessions ? ` · ${result.revokedSessions} sessioni chiuse` : ''),
    );
  },

  async remove() {
    if (!email) throw new Error('Uso: npm run user:remove -- email@dominio');
    console.log(`Account rimosso: ${deleteUser(email).email}`);
  },
};

const run = commands[command];
if (!run) {
  console.error(`Comando non riconosciuto: ${command ?? '(nessuno)'}`);
  console.error('Disponibili: list, add, password, remove');
  process.exit(2);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Errore: ${err.message}`);
    process.exit(1);
  });
