// Client GA4 Data API, senza dipendenze esterne.
//
// Il flusso del service account è un JWT firmato RS256 scambiato per un access
// token ("two-legged OAuth"): non serve nessun consenso interattivo, che è
// esattamente il motivo per cui la spec sceglie il service account invece di un
// flusso OAuth utente. node:crypto firma il JWT, quindi zero librerie Google.
//
// Gli endpoint sono iniettabili per poter collaudare tutto contro un server
// finto locale, senza credenziali reali.

import crypto from 'node:crypto';
import { HttpError } from './http-error.js';

// Sovrascrivibili da ambiente: serve a collaudare il flusso contro un server
// finto locale e, se mai servisse, a passare da un proxy.
export const DEFAULT_ENDPOINTS = {
  token: process.env.TWOBEE_GA4_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
  dataApi: process.env.TWOBEE_GA4_DATA_URL ?? 'https://analyticsdata.googleapis.com/v1beta',
};

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_TTL_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 30000;

/** Access token in cache per chiave privata, finché non scade. */
const tokenCache = new Map();

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** Valida il JSON del service account e restituisce i campi che servono. */
export function parseServiceAccount(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new HttpError(400, 'Il service account non è un JSON valido');
  }

  const missing = ['client_email', 'private_key'].filter((field) => !parsed?.[field]);
  if (missing.length) {
    throw new HttpError(400, `JSON del service account incompleto: manca ${missing.join(', ')}`);
  }
  if (parsed.type && parsed.type !== 'service_account') {
    throw new HttpError(400, `Atteso un JSON di tipo service_account, ricevuto "${parsed.type}"`);
  }
  // Le chiavi copiate a mano perdono spesso gli a-capo, che diventano "\n" letterali.
  const privateKey = String(parsed.private_key).replace(/\\n/g, '\n');
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new HttpError(400, 'private_key non sembra una chiave PEM');
  }

  return {
    clientEmail: parsed.client_email,
    privateKey,
    projectId: parsed.project_id ?? null,
  };
}

/** Costruisce e firma il JWT di autorizzazione. */
export function buildAssertion(account, { audience, now = Math.floor(Date.now() / 1000) } = {}) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: SCOPE,
      aud: audience,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    }),
  );

  const signingInput = `${header}.${claims}`;
  let signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(account.privateKey);
  } catch (err) {
    throw new HttpError(400, `Chiave privata non utilizzabile: ${err.message}`);
  }

  return `${signingInput}.${signature.toString('base64url')}`;
}

/** Access token, dalla cache se ancora valido. */
export async function getAccessToken(account, endpoints = DEFAULT_ENDPOINTS) {
  const cacheKey = `${account.clientEmail}@${endpoints.token}`;
  const cached = tokenCache.get(cacheKey);
  // Margine di 60s: un token che scade durante la richiesta è un errore inutile.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const assertion = buildAssertion(account, { audience: endpoints.token });

  let response;
  try {
    response = await fetch(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HttpError(502, `Google non raggiungibile: ${err.cause?.code ?? err.message}`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Il campo error_description di Google è specifico: vale riportarlo così com'è.
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    throw new HttpError(
      response.status === 400 || response.status === 401 ? 401 : 502,
      `Autenticazione GA4 rifiutata: ${detail}`,
    );
  }

  const token = payload.access_token;
  if (!token) throw new HttpError(502, 'Risposta di Google senza access_token');

  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + (payload.expires_in ?? TOKEN_TTL_SECONDS) * 1000,
  });
  return token;
}

/** Svuota la cache dei token: serve quando si sostituisce il service account. */
export function clearTokenCache() {
  tokenCache.clear();
}

async function callDataApi(path, body, { account, endpoints = DEFAULT_ENDPOINTS }) {
  const token = await getAccessToken(account, endpoints);

  let response;
  try {
    response = await fetch(`${endpoints.dataApi}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HttpError(502, `GA4 Data API non raggiungibile: ${err.cause?.code ?? err.message}`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message ?? `HTTP ${response.status}`;
    // 403 su una property quasi sempre significa service account non autorizzato.
    const hint =
      response.status === 403
        ? ' — verifica di aver aggiunto il service account come utente con permesso di lettura sulla property'
        : '';
    throw new HttpError(response.status === 403 ? 403 : 502, `GA4: ${detail}${hint}`);
  }
  return payload;
}

/**
 * Esegue una query. `metrics` e `dimensions` sono nomi della Data API, gli stessi
 * che si scelgono in Esplora.
 */
export async function runReport(
  {
    propertyId,
    startDate,
    endDate,
    metrics,
    dimensions = [],
    orderBy = null,
    limit = 100,
    eventName = null,
  },
  context,
) {
  if (!propertyId) throw new HttpError(409, 'Property ID GA4 mancante per questo cliente');

  const body = {
    dateRanges: [{ startDate, endDate }],
    metrics: metrics.map((name) => ({ name })),
    dimensions: dimensions.map((name) => ({ name })),
    limit,
    // Le righe (other) aggregate falsano i totali di un breakdown: meglio senza.
    keepEmptyRows: false,
  };

  // Restringe la query a un singolo evento. Serve al secondo passaggio del
  // funnel: la Data API v1beta non ha un endpoint funnel (esiste solo in alpha),
  // quindi il funnel si costruisce con due query filtrate e un calcolo.
  if (eventName) {
    body.dimensionFilter = {
      filter: {
        fieldName: 'eventName',
        stringFilter: { matchType: 'EXACT', value: eventName },
      },
    };
  }

  if (orderBy) {
    body.orderBys = [{ metric: { metricName: orderBy }, desc: true }];
  }

  const payload = await callDataApi(`properties/${propertyId}:runReport`, body, context);

  const metricNames = (payload.metricHeaders ?? []).map((h) => h.name);
  const dimensionNames = (payload.dimensionHeaders ?? []).map((h) => h.name);

  const rows = (payload.rows ?? []).map((row) => {
    const dims = {};
    dimensionNames.forEach((name, i) => {
      dims[name] = row.dimensionValues?.[i]?.value ?? '';
    });

    const values = {};
    metricNames.forEach((name, i) => {
      const raw = row.metricValues?.[i]?.value;
      const num = Number(raw);
      values[name] = Number.isFinite(num) ? num : 0;
    });

    return { dimensions: dims, metrics: values };
  });

  return {
    rows,
    metricNames,
    dimensionNames,
    rowCount: payload.rowCount ?? rows.length,
    // GA4 campiona/aggrega: se lo dichiara, va mostrato invece che ignorato.
    sampled: Boolean(payload.metadata?.samplingMetadatas?.length),
  };
}

/** Metriche e dimensioni disponibili sulla property: aiuta a scrivere le definizioni. */
export async function fetchMetadata(propertyId, context) {
  if (!propertyId) throw new HttpError(409, 'Property ID GA4 mancante per questo cliente');
  const payload = await callDataApi(`properties/${propertyId}/metadata`, null, context);

  const map = (list) =>
    (list ?? []).map((entry) => ({
      apiName: entry.apiName,
      uiName: entry.uiName ?? entry.apiName,
      category: entry.category ?? '',
      custom: Boolean(entry.customDefinition),
    }));

  return { metrics: map(payload.metrics), dimensions: map(payload.dimensions) };
}
