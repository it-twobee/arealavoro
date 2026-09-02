// Verifica automatica del tracking scaricando l'HTML del sito cliente.
//
// Cosa si può concludere e cosa no, perché determina la politica di aggiornamento:
//  - lo snippet GTM sta SEMPRE nell'HTML: se il container è configurato e non
//    compare, è un'assenza reale -> lo stato GTM si aggiorna anche al ribasso;
//  - GA4, Meta Pixel e Klaviyo di solito vengono caricati DA GTM, quindi non
//    compaiono nell'HTML: non trovarli non dimostra niente. Questi stati si
//    portano a "attivo" solo quando il tag è visibile nel sorgente, mai al
//    ribasso. Le incoerenze vengono segnalate, non applicate.

import { db } from './db.js';
import { HttpError } from './http-error.js';

const TIMEOUT_MS = 15000;
// Le homepage e-commerce reali viaggiano intorno a 1,5 MB: con un tetto più
// basso si troncava il body e i tag in fondo alla pagina sparivano.
const MAX_BYTES = 4_000_000;
const USER_AGENT = 'TwoBeeOS-TrackingCheck/1.0 (+verifica interna tracking)';

/** Normalizza quello che scrive l'utente: "sito.it" -> "https://sito.it/". */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new HttpError(400, `URL non valido: ${raw}`);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new HttpError(400, 'Sono ammessi solo indirizzi http o https');
  }
  return url.toString();
}

/**
 * Blocca gli indirizzi interni. Il server fa una richiesta verso un URL scelto
 * dall'utente: anche in un'app locale è meglio non poterla puntare sulla rete
 * interna o su servizi in ascolto su localhost.
 */
function assertPublicHost(url) {
  const host = new URL(url).hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^0\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isPrivate) throw new HttpError(400, `Indirizzo interno non ammesso: ${host}`);
}

/** Legge il corpo con un tetto di byte: una homepage enorme non deve saturare la RAM. */
async function readCapped(response) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (received < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
  }
  await reader.cancel().catch(() => {});

  return new TextDecoder('utf-8', { fatal: false }).decode(
    Buffer.concat(chunks.map((c) => Buffer.from(c))),
  );
}

function unique(values) {
  return [...new Set(values)];
}

// Parole che assomigliano a un container ID ma non lo sono: arrivano da
// attributi HTML come id="gtm-noscript". Il match è già case-sensitive, questo
// copre i casi in cui l'attributo è scritto in maiuscolo.
const NOT_CONTAINER_IDS = new Set(['SCRIPT', 'NOSCRIPT', 'CONTAINER', 'IFRAME', 'DATALAYER']);

/** Estrae gli identificativi dei tag presenti nel sorgente. */
export function detectTags(html) {
  // Case-sensitive di proposito: nello snippet il container è sempre maiuscolo,
  // mentre gli attributi HTML che generavano falsi positivi sono minuscoli.
  const gtmIds = unique(
    (html.match(/GTM-[A-Z0-9]{5,}/g) ?? []).filter(
      (id) => !NOT_CONTAINER_IDS.has(id.slice(4)),
    ),
  );

  // Measurement ID GA4 e/o caricamento diretto di gtag.js
  const ga4Ids = unique(html.match(/\bG-[A-Z0-9]{7,}\b/g) ?? []);
  const gtagDirect = /googletagmanager\.com\/gtag\/js/i.test(html);

  // Meta: id passato a fbq('init', ...) oppure pixel in <img> di fallback
  const metaIds = unique([
    ...(html.match(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{8,})['"]/gi) ?? []).map(
      (s) => s.match(/(\d{8,})/)[1],
    ),
    ...(html.match(/facebook\.com\/tr\?id=(\d{8,})/gi) ?? []).map((s) => s.match(/(\d{8,})/)[1]),
  ]);
  const metaScript = /connect\.facebook\.net\/[^"']*\/fbevents\.js/i.test(html);

  const klaviyoId = html.match(/klaviyo\.js\?company_id=([A-Za-z0-9]+)/i)?.[1] ?? null;
  // Solo segnali di codice eseguibile: la parola "klaviyo" nel testo della
  // pagina (o in un footer "powered by") non prova che il tracking sia attivo.
  const klaviyoScript =
    /(static|a|fast)[\w.-]*\.klaviyo\.com/i.test(html) ||
    /klaviyo\.js/i.test(html) ||
    /_learnq/.test(html);

  return {
    gtmIds,
    ga4Ids,
    gtagDirect,
    metaIds,
    metaScript,
    klaviyoId,
    klaviyo: Boolean(klaviyoId) || klaviyoScript,
  };
}

/** Scarica la homepage. Non lancia sugli errori di rete: li restituisce. */
export async function fetchSite(url) {
  assertPublicHost(url);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-IT,it;q=0.9',
      },
    });

    const html = await readCapped(response);
    return {
      ok: response.ok,
      httpStatus: response.status,
      finalUrl: response.url,
      html,
      bytes: html.length,
      durationMs: Date.now() - startedAt,
      error: response.ok ? null : `Risposta HTTP ${response.status}`,
    };
  } catch (err) {
    const message =
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `Timeout dopo ${TIMEOUT_MS / 1000}s`
        : (err.cause?.code ?? err.message);
    return {
      ok: false,
      httpStatus: null,
      finalUrl: url,
      html: '',
      bytes: 0,
      durationMs: Date.now() - startedAt,
      error: `Sito non raggiungibile: ${message}`,
    };
  }
}

/**
 * Traduce i tag trovati in aggiornamenti di stato, secondo la politica descritta
 * in cima al file. Non scrive: restituisce le modifiche proposte.
 */
export function evaluate(client, found) {
  const changes = [];
  const notes = [];

  const propose = (field, to, reason) => {
    const from = client[field];
    if (from === 'na') return; // canale non pertinente all'archetipo: non si tocca
    if (from === to) return;
    changes.push({ field, from, to, reason });
  };

  // --- GTM: segnale affidabile, aggiornabile in entrambe le direzioni
  const configured = (client.gtm_container_id ?? '').toUpperCase();

  if (found.gtmIds.length === 0) {
    propose('status_gtm', 'todo', 'Nessuno snippet GTM trovato nel sorgente della homepage');
  } else if (!configured) {
    propose(
      'status_gtm',
      'partial',
      `Trovato ${found.gtmIds.join(', ')} ma nessun container configurato in scheda`,
    );
    notes.push(`Container trovato sul sito: ${found.gtmIds.join(', ')}. Salvalo nel campo "ID container GTM".`);
  } else if (found.gtmIds.includes(configured)) {
    propose('status_gtm', 'active', `Container ${configured} presente sul sito`);
  } else {
    propose(
      'status_gtm',
      'partial',
      `Sul sito c'è ${found.gtmIds.join(', ')}, non il container configurato ${configured}`,
    );
    notes.push(`Disallineamento container: in scheda ${configured}, sul sito ${found.gtmIds.join(', ')}.`);
  }

  // --- Gli altri canali: solo promozione, mai declassamento
  const positives = [
    {
      field: 'status_ga4',
      label: 'GA4',
      hit: found.ga4Ids.length > 0 || found.gtagDirect,
      reason: found.ga4Ids.length
        ? `Measurement ID ${found.ga4Ids.join(', ')} nel sorgente`
        : 'gtag.js caricato direttamente nel sorgente',
      // Per GA4 esiste una prova migliore dell'HTML: i dati che arrivano davvero.
      viaApi: 'La prova reale è "Dati GA4 recenti", che interroga la Data API.',
    },
    {
      field: 'status_meta_pixel',
      label: 'Meta Pixel',
      hit: found.metaIds.length > 0 || found.metaScript,
      reason: found.metaIds.length
        ? `Pixel ${found.metaIds.join(', ')} nel sorgente`
        : 'fbevents.js caricato nel sorgente',
    },
    {
      field: 'status_klaviyo',
      label: 'Klaviyo',
      hit: found.klaviyo,
      reason: found.klaviyoId
        ? `Klaviyo company_id ${found.klaviyoId} nel sorgente`
        : 'Script Klaviyo nel sorgente',
    },
  ];

  // Con GTM presente la lettura dell'HTML non è più un segnale valido per gli
  // altri canali: GTM li inietta a runtime, quindi non compaiono mai nel
  // sorgente. Un "non trovato" in questo caso non dimostra niente.
  const gtmPresente = found.gtmIds.length > 0;

  for (const channel of positives) {
    // Un canale non pertinente all'archetipo non merita né promozioni né note.
    if (client[channel.field] === 'na') continue;

    if (channel.hit) {
      propose(channel.field, 'active', channel.reason);
    } else if (gtmPresente) {
      notes.push(
        `${channel.label} non compare nell'HTML, ma il sito carica GTM: è il caso normale quando è configurato lì dentro. ` +
          `${channel.viaApi ?? 'Il segnale attendibile è il controllo giornaliero, non il sorgente della pagina.'}`,
      );
    } else if (client[channel.field] === 'active') {
      // Nessun GTM: qui l'HTML è l'unica fonte, quindi l'assenza vale davvero.
      notes.push(
        `${channel.label} è segnato attivo ma non compare nell'HTML, e sul sito non c'è GTM che possa caricarlo: da controllare.`,
      );
    }
  }

  return { changes, notes, gtmPresente };
}

/** Esegue la verifica, applica le modifiche e registra l'esito nello storico. */
export async function runCheck(client) {
  if (!client.website_url) {
    throw new HttpError(409, 'Aggiungi l\'URL del sito prima di lanciare la verifica');
  }

  const url = normalizeUrl(client.website_url);
  const result = await fetchSite(url);
  const found = result.ok
    ? detectTags(result.html)
    : { gtmIds: [], ga4Ids: [], gtagDirect: false, metaIds: [], metaScript: false, klaviyoId: null, klaviyo: false };

  // Se la pagina non si è scaricata non si conclude nulla: nessuna modifica.
  const { changes, notes, gtmPresente } = result.ok
    ? evaluate(client, found)
    : { changes: [], notes: [], gtmPresente: false };

  if (changes.length > 0) {
    const assignments = changes.map((c) => `${c.field} = ?`).join(', ');
    db.prepare(
      `UPDATE clients SET ${assignments}, updated_at = datetime('now') WHERE id = ?`,
    ).run(...changes.map((c) => c.to), client.id);
  }

  db.prepare(
    `INSERT INTO tracking_checks
       (client_id, url, ok, http_status, error, gtm_ids, ga4_ids, meta_ids, klaviyo, changes, bytes, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    client.id,
    result.finalUrl,
    result.ok ? 1 : 0,
    result.httpStatus,
    result.error,
    JSON.stringify(found.gtmIds),
    JSON.stringify(found.ga4Ids),
    JSON.stringify(found.metaIds),
    found.klaviyo ? 1 : 0,
    JSON.stringify(changes),
    result.bytes,
    result.durationMs,
  );

  return {
    ok: result.ok,
    url: result.finalUrl,
    httpStatus: result.httpStatus,
    error: result.error,
    found,
    // Dice a chi legge se l'assenza di un tag nell'HTML sia concludente.
    gtmPresente,
    changes,
    notes,
    bytes: result.bytes,
    durationMs: result.durationMs,
  };
}

/** Ultime verifiche di un cliente, dalla più recente. */
export function checkHistory(clientId, limit = 10) {
  return db
    .prepare(
      `SELECT id, checked_at, url, ok, http_status, error, gtm_ids, ga4_ids, meta_ids,
              klaviyo, changes, duration_ms
         FROM tracking_checks WHERE client_id = ?
        ORDER BY checked_at DESC, id DESC LIMIT ?`,
    )
    .all(clientId, limit)
    .map((row) => ({
      id: row.id,
      checkedAt: row.checked_at,
      url: row.url,
      ok: Boolean(row.ok),
      httpStatus: row.http_status,
      error: row.error,
      gtmIds: JSON.parse(row.gtm_ids),
      ga4Ids: JSON.parse(row.ga4_ids),
      metaIds: JSON.parse(row.meta_ids),
      klaviyo: Boolean(row.klaviyo),
      changes: JSON.parse(row.changes),
      durationMs: row.duration_ms,
    }));
}
