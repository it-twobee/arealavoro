#!/usr/bin/env node
// Ripristina un backup .tbenc in un file twobee.db utilizzabile.
//
//   npm run backup:decrypt -- "percorso\backup.tbenc" [output.db]
//
// Volutamente autonomo: non importa nulla da app/ perché è lo strumento che
// deve funzionare anche quando l'applicazione è rotta o assente. Tutto ciò
// che serve per decifrare (salt e parametri scrypt) sta nell'header del file:
// bastano questo script, Node e la master password.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const MAGIC = 'TBBK';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function parseHeader(raw) {
  if (raw.length < 12 || raw.subarray(0, 4).toString('ascii') !== MAGIC) {
    throw new Error('Non è un backup TwoBee (magic number assente)');
  }

  const version = raw.readUInt8(4);
  if (version !== 1) throw new Error(`Versione di formato non supportata: ${version}`);

  const kdf = { N: raw.readUInt32LE(5), r: raw.readUInt8(9), p: raw.readUInt8(10) };
  const saltLen = raw.readUInt8(11);
  const salt = raw.subarray(12, 12 + saltLen);
  const sealed = raw.subarray(12 + saltLen);

  if (sealed.length <= IV_BYTES + TAG_BYTES) throw new Error('File troncato');
  return { version, kdf, salt, sealed };
}

function askPassword(prompt) {
  if (process.env.TWOBEE_MASTER_PASSWORD) {
    return Promise.resolve(process.env.TWOBEE_MASTER_PASSWORD);
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      'Serve un terminale interattivo per digitare la password ' +
        '(oppure impostare la variabile TWOBEE_MASTER_PASSWORD)',
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
    muted = true; // il prompt è già stato stampato: da qui non si eco più nulla
  });
}

async function main() {
  const [input, outputArg] = process.argv.slice(2);

  if (!input) {
    console.error('Uso: node backup/decrypt.js <file.tbenc> [output.db]');
    process.exit(2);
  }
  if (!fs.existsSync(input)) {
    console.error(`File non trovato: ${input}`);
    process.exit(2);
  }

  const raw = fs.readFileSync(input);
  const { kdf, salt, sealed } = parseHeader(raw);
  console.log(`Backup valido · scrypt N=${kdf.N} r=${kdf.r} p=${kdf.p} · ${raw.length} byte`);

  const password = await askPassword('Master password: ');
  const key = crypto.scryptSync(password, salt, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * 1024 * 1024,
  });

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    plaintext = Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    // GCM non distingue password errata da file manomesso: sono lo stesso errore.
    console.error('\nDecifratura fallita: master password errata oppure file corrotto.');
    process.exit(1);
  }

  if (plaintext.subarray(0, 15).toString('ascii') !== 'SQLite format 3') {
    console.error('Decifrato, ma il contenuto non è un database SQLite.');
    process.exit(1);
  }

  const output = outputArg ?? path.join(process.cwd(), `twobee-restored-${Date.now()}.db`);
  fs.writeFileSync(output, plaintext);

  // Prova d'apertura: un ripristino che non si apre non è un ripristino.
  const db = new DatabaseSync(output);
  const clients = db.prepare('SELECT COUNT(*) AS n FROM clients').get().n;
  const credentials = db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n;
  db.close();

  console.log(`\nRipristinato in ${output}`);
  console.log(`Contenuto: ${clients} clienti, ${credentials} credenziali cifrate`);
  console.log('Le credenziali restano cifrate con questa stessa master password.');
}

main().catch((err) => {
  console.error(`Errore: ${err.message}`);
  process.exit(1);
});
