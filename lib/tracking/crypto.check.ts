/* Verifica della cifratura dei segreti. Esegui: npx tsx lib/tracking/crypto.check.ts */
import crypto from 'node:crypto'
import { seal, open, sealWithKey, openWithKey, getVaultKey, isVaultConfigured } from '@/lib/tracking/crypto'
import { isTrackingError } from '@/lib/tracking/errors'

let fail = 0
const is = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'OK ' : 'NO '} ${label.padEnd(58)} ${JSON.stringify(got)}${ok ? '' : `  atteso ${JSON.stringify(want)}`}`)
}
const throwsStatus = (fn: () => unknown): number | null => {
  try { fn(); return null } catch (e) { return isTrackingError(e) ? e.status : -1 }
}

const hex = crypto.randomBytes(32).toString('hex')

// chiave assente
delete process.env.VAULT_KEY
is('senza VAULT_KEY: non configurato', isVaultConfigured(), false)
is('senza VAULT_KEY: seal → 409', throwsStatus(() => seal('x')), 409)

// chiave corta
process.env.VAULT_KEY = 'abcd'
is('chiave corta → 409', throwsStatus(() => getVaultKey()), 409)

// chiave hex
process.env.VAULT_KEY = hex
is('hex: configurato', isVaultConfigured(), true)
is('hex: 32 byte', getVaultKey().length, 32)
const blob = seal('segreto con àccenti e 🔑')
is('blob è base64', /^[A-Za-z0-9+/]+=*$/.test(blob), true)
is('roundtrip', open(blob), 'segreto con àccenti e 🔑')
is('iv diverso a ogni scrittura', seal('a') === seal('a'), false)
is('stringa vuota', open(seal('')), '')

// chiave base64 equivalente
process.env.VAULT_KEY = Buffer.from(hex, 'hex').toString('base64')
is('base64: stessa chiave legge lo stesso blob', open(blob), 'segreto con àccenti e 🔑')

// chiave diversa
process.env.VAULT_KEY = crypto.randomBytes(32).toString('hex')
is('chiave diversa → 422', throwsStatus(() => open(blob)), 422)

// manomissione
process.env.VAULT_KEY = hex
const raw = Buffer.from(blob, 'base64')
raw[raw.length - 1] ^= 0xff
is('blob manomesso → 422', throwsStatus(() => open(raw.toString('base64'))), 422)
is('blob troppo corto → 422', throwsStatus(() => open('AAAA')), 422)

// primitive con chiave esplicita
const k = crypto.randomBytes(32)
is('sealWithKey/openWithKey', openWithKey(k, sealWithKey(k, Buffer.from('ciao'))).toString(), 'ciao')

console.log(fail ? `\n${fail} controlli falliti` : '\nTutti i controlli passano')
process.exit(fail ? 1 : 0)
