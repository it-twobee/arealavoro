import crypto from 'node:crypto'
import { TrackingError } from './errors'

/**
 * §316 — Cifratura dei segreti del modulo Tracking.
 *
 * AES-256-GCM con la chiave in `VAULT_KEY` (env di Coolify, 32 byte in hex o
 * base64). Il blob salvato è base64 di iv(12) | authTag(16) | ciphertext, lo
 * stesso formato di «arealavoro»: chi legge la tabella senza la chiave legge
 * rumore, e il tag GCM fa da controllo d'integrità.
 *
 * La chiave si legge a chiamata, mai all'import: `next build` valuta route e
 * action e non deve richiedere il segreto per compilare.
 */

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export function isVaultConfigured(): boolean {
  try { getVaultKey(); return true } catch { return false }
}

export function getVaultKey(): Buffer {
  const raw = (process.env.VAULT_KEY ?? '').trim()
  if (!raw) throw new TrackingError(409, 'VAULT_KEY non configurata: i segreti non si possono cifrare né leggere')
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  const b64 = Buffer.from(raw, 'base64')
  if (b64.length === KEY_BYTES) return b64
  throw new TrackingError(409, 'VAULT_KEY non valida: servono 32 byte (64 caratteri hex o base64)')
}

/** Cifra con una chiave esplicita. Ritorna iv | authTag | ciphertext. */
export function sealWithKey(key: Buffer, plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

/** Inverso di sealWithKey. Lancia se i dati sono corrotti o la chiave è un'altra. */
export function openWithKey(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('blob troppo corto')
  const iv = sealed.subarray(0, IV_BYTES)
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()])
}

/** Testo → blob base64 pronto per la colonna. */
export function seal(plaintext: string): string {
  return sealWithKey(getVaultKey(), Buffer.from(plaintext, 'utf8')).toString('base64')
}

/** Blob base64 → testo. 422 se la chiave non è quella con cui è stato scritto. */
export function open(blob: string): string {
  const key = getVaultKey()
  try {
    return openWithKey(key, Buffer.from(blob, 'base64')).toString('utf8')
  } catch {
    throw new TrackingError(422, 'Credenziale non decifrabile con la chiave corrente: va reinserita')
  }
}
