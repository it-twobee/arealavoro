/**
 * Errore con codice HTTP: le action lo rilanciano come messaggio, le route lo
 * traducono in status. 409 = prerequisito mancante, 422 = blob non decifrabile,
 * 404 = non trovato, 403 = permesso negato.
 */
export class TrackingError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'TrackingError'
    this.status = status
  }
}

export const isTrackingError = (e: unknown): e is TrackingError => e instanceof TrackingError

/** Messaggio leggibile da un errore qualsiasi, senza far trapelare stack. */
export function errorMessage(e: unknown, fallback = 'Errore inatteso'): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string' && e) return e
  return fallback
}
