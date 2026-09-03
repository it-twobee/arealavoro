// Errore con status HTTP: il middleware in server.js lo traduce in JSON.
// È lo stesso TrackingError del nucleo condiviso (stessa firma `(status, message)`):
// così un errore lanciato da lib/tracking arriva al middleware già con lo status.
export { TrackingError as HttpError } from '../lib/tracking/errors.ts';
