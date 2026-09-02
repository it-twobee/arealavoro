/**
 * Interruttori di configurazione, letti dall'ambiente.
 *
 * `AUTH_ENABLED` è spento per scelta: la dashboard ascolta solo su 127.0.0.1 ed
 * è a uso di una persona sola, quindi si entra senza password. Il codice di
 * autenticazione resta completo e si riaccende senza modifiche:
 *
 *   Windows:  set TWOBEE_AUTH=on && npm run dev
 *   bash:     TWOBEE_AUTH=on npm run dev
 *
 * L'account resta nel database anche a interruttore spento: riaccendendolo si
 * rientra con le stesse credenziali.
 */
export const AUTH_ENABLED = process.env.TWOBEE_AUTH === 'on';
