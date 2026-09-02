// Client Meta Marketing API (Graph API), senza dipendenze esterne.
//
// Le credenziali stanno su due livelli, come per GA4: il token del System User
// è uno solo per l'agenzia (Impostazioni), l'Ad Account ID cambia da cliente a
// cliente (scheda Chiavi). Il token viaggia nell'header Authorization e non
// nella query string, così non finisce nei log intermedi.

import { HttpError } from './http-error.js';

export const DEFAULT_ENDPOINTS = {
  base: process.env.TWOBEE_META_BASE ?? 'https://graph.facebook.com/v21.0',
};

const REQUEST_TIMEOUT_MS = 30000;

/**
 * Eventi che valgono come conversione. Non basta filtrare per prefisso:
 * `offsite_conversion.fb_pixel_view_content` è un evento del pixel ma non una
 * conversione, e sommarlo gonfia il dato di un ordine di grandezza.
 */
const CONVERSION_EVENTS = new Set([
  'lead',
  'purchase',
  'complete_registration',
  'submit_application',
  'subscribe',
  'start_trial',
  'contact',
  'schedule',
  'donate',
]);

/**
 * Nome dell'evento dietro un action_type, e quanto è specifica quella voce.
 * Meta riporta lo stesso evento su più livelli di aggregazione — il pixel
 * (`offsite_conversion.fb_pixel_lead`) e la forma normalizzata (`lead`) — e
 * sommarli entrambi conterebbe ogni conversione due volte.
 */
function classifyAction(actionType) {
  const pixel = actionType.match(/^offsite_conversion\.fb_pixel_(.+)$/);
  if (pixel) return { evento: pixel[1], specificita: 2 };

  const onsite = actionType.match(/^onsite_conversion\.(.+)$/);
  if (onsite) return { evento: onsite[1], specificita: 1 };

  return { evento: actionType, specificita: 0 };
}

export function isConversionAction(actionType) {
  return CONVERSION_EVENTS.has(classifyAction(actionType).evento);
}

/**
 * Sceglie una sola voce per evento di conversione, preferendo la più specifica.
 * Restituisce gli action_type effettivamente conteggiati, che il report mostra:
 * il numero deve essere sempre ispezionabile.
 */
export function selectConversions(azioni) {
  const perEvento = new Map();

  for (const [actionType, valore] of azioni) {
    const { evento, specificita } = classifyAction(actionType);
    if (!CONVERSION_EVENTS.has(evento)) continue;

    const attuale = perEvento.get(evento);
    if (!attuale || specificita > attuale.specificita) {
      perEvento.set(evento, { actionType, valore, specificita });
    }
  }

  const scelte = [...perEvento.values()];
  return {
    totale: scelte.reduce((somma, s) => somma + s.valore, 0),
    actionTypes: scelte.map((s) => s.actionType),
  };
}

/** Accetta 1234567890 o act_1234567890 e restituisce sempre act_1234567890. */
export function normalizeAdAccount(value) {
  const raw = String(value ?? '').trim().replace(/^act_/i, '');
  if (!/^\d{5,}$/.test(raw)) {
    throw new HttpError(400, `Ad Account ID non valido: "${value}" (attese solo cifre, es. act_1234567890)`);
  }
  return `act_${raw}`;
}

async function request(path, params, { token, endpoints = DEFAULT_ENDPOINTS }) {
  if (!token) throw new HttpError(409, 'Token System User Meta non configurato in Impostazioni');

  const url = new URL(`${endpoints.base}/${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HttpError(502, `Meta non raggiungibile: ${err.cause?.code ?? err.message}`);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.error) {
    const e = payload.error ?? {};
    // I codici di Meta sono specifici e vale la pena tradurli in indicazioni.
    const hint =
      e.code === 190
        ? ' — il token è scaduto o revocato: rigeneralo e aggiornalo in Impostazioni'
        : e.code === 200 || e.code === 10
          ? " — al System User mancano i permessi ads_read su questo ad account"
          : e.code === 100
            ? ' — parametro rifiutato: controlla che l\'Ad Account ID appartenga a questo token'
            : '';
    throw new HttpError(
      e.code === 190 || e.code === 200 || e.code === 10 ? 403 : 502,
      `Meta: ${e.error_user_msg ?? e.message ?? `HTTP ${response.status}`}${hint}`,
    );
  }
  return payload;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Elenco {action_type: valore} da una lista di Meta. */
function actionMap(list) {
  const map = new Map();
  for (const entry of list ?? []) map.set(entry.action_type, num(entry.value));
  return map;
}

/**
 * Insight a livello account per un intervallo di date.
 * Restituisce già le metriche normalizzate nei nomi usati dal report.
 */
export async function accountInsights({ adAccountId, since, until }, context) {
  const payload = await request(
    `${normalizeAdAccount(adAccountId)}/insights`,
    {
      level: 'account',
      time_range: JSON.stringify({ since, until }),
      fields: 'spend,impressions,clicks,ctr,cpc,reach,actions,cost_per_action_type',
    },
    context,
  );

  const row = payload.data?.[0];
  if (!row) {
    // Nessuna riga significa nessuna erogazione nel periodo, non un errore.
    return { metrics: zeroMetrics(), actions: [], vuoto: true, conversionActions: [] };
  }

  const azioni = actionMap(row.actions);
  const costi = actionMap(row.cost_per_action_type);

  const { totale: conversioni, actionTypes: conversionActions } = selectConversions(azioni);
  const spesa = num(row.spend);

  return {
    metrics: {
      spesa,
      impression: num(row.impressions),
      click: num(row.clicks),
      // Meta restituisce il CTR già in percentuale (1.23 = 1,23%): qui si porta
      // a frazione, come tutti gli altri tassi del sistema.
      tasso_click: num(row.ctr) / 100,
      conversioni,
      costo_per_conversione: conversioni ? spesa / conversioni : 0,
    },
    // Ogni azione con il suo costo: nulla resta nascosto dentro "conversioni".
    actions: [...azioni.entries()].map(([action_type, conteggio]) => ({
      action_type,
      conteggio,
      costo_per_azione: costi.get(action_type) ?? 0,
      conversione: isConversionAction(action_type),
    })),
    conversionActions,
    vuoto: false,
  };
}

function zeroMetrics() {
  return {
    spesa: 0,
    impression: 0,
    click: 0,
    tasso_click: 0,
    conversioni: 0,
    costo_per_conversione: 0,
  };
}

/**
 * Pixel dell'ad account con l'ultimo evento ricevuto. È la fonte di verità per
 * il controllo giornaliero: dice se il pixel *riceve dati*, non se il codice
 * compare nell'HTML.
 */
export async function accountPixels(adAccountId, context) {
  const payload = await request(
    `${normalizeAdAccount(adAccountId)}/adspixels`,
    { fields: 'id,name,last_fired_time' },
    context,
  );

  return (payload.data ?? []).map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    lastFiredTime: p.last_fired_time ?? null,
  }));
}
