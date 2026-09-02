/** Errore con status HTTP: il middleware in server.js lo traduce in JSON. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
