// TwoBee OS — dashboard (vanilla, nessun build step).
// Router a hash: #/clients  |  #/clients/:id

const view = document.getElementById('view');
const toastEl = document.getElementById('toast');
const dlgNew = document.getElementById('dlg-new');
const dlgVault = document.getElementById('dlg-vault');

let META = null;
let clients = [];
let qa = { items: [], withProblems: [], lastRun: null };
let filterText = '';
let vault = { initialized: false, unlocked: false, minPasswordLength: 8 };

/* ---------- accesso ---------- */

// Ad accesso libero il server non serve il markup del login: questo è null, e
// tutto ciò che lo usa deve tollerarlo.
const loginScreen = document.getElementById('login');
const dlgPassword = document.getElementById('dlg-password');
let currentUser = null;
// Iniettato dal server nell'HTML: noto prima di qualsiasi chiamata API, quindi
// la schermata di accesso non può comparire nemmeno se il server è irraggiungibile.
let authDisabled = window.__TWOBEE_AUTH === false;
let vaultSyncFailed = false;
let routerAttached = false;

let loginResolve = null;

/**
 * Aggancia il gestore dell'invio una volta sola, all'avvio.
 *
 * Stava dentro showLogin insieme al resto: se un elemento accessorio mancava
 * (per esempio il pulsante-occhio, con un HTML servito dalla cache del browser
 * più vecchio del JavaScript), l'errore avveniva prima dell'aggancio e il
 * pulsante "Entra" restava inerte, senza nessun messaggio. Qui il gestore è la
 * prima cosa che viene collegata e non dipende da niente di opzionale.
 */
function setupLoginForm() {
  // Ad accesso libero il markup non c'è: niente da agganciare.
  const form = loginScreen?.querySelector('[data-form="login"]');
  if (!form) return;

  const errorEl = form.querySelector('[data-error]');
  const submit = form.querySelector('[data-submit]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Verifico…'; // scrypt richiede ~300 ms
    }
    try {
      const response = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: form.email.value.trim(),
          // Gli spazi ai bordi arrivano quasi sempre da un incollamento e non
          // fanno parte della password: rimuoverli evita un fallimento muto.
          password: form.password.value.trim(),
        }),
      });

      storeSessionToken(response.token);

      // Controllo che la sessione tenga davvero *prima* di dichiarare l'accesso
      // riuscito: se il browser non conserva né cookie né token, qui si scopre
      // subito, invece di far comparire di nuovo il login senza spiegazioni.
      try {
        await api('/auth/me');
      } catch {
        throw Object.assign(
          new Error(
            'Accesso corretto, ma il browser non conserva la sessione. ' +
              'Sblocca i cookie per localhost, oppure prova in una finestra non anonima o senza estensioni.',
          ),
          { status: 0, sessionLost: true },
        );
      }

      currentUser = response.user;
      form.password.value = '';
      loginScreen.hidden = true;
      // Il vault si apre con la stessa password. Se non è stato possibile
      // (creato in passato con un'altra) va detto, non lasciato indovinare.
      vaultSyncFailed = response.vault?.state === 'locked';

      const resolve = loginResolve;
      loginResolve = null;
      if (resolve) resolve(response.user);
      else await startApp();
    } catch (err) {
      // Distinzione che conta: un server spento non è una password sbagliata.
      // Senza status HTTP la fetch non è mai arrivata a destinazione.
      if (errorEl) {
        errorEl.textContent =
          err.status || err.sessionLost
            ? err.message
            : 'Server non raggiungibile. Controlla che "npm run dev" sia in esecuzione nel terminale.';
        errorEl.hidden = false;
      }
      if (err.status) form.password.select();
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = 'Entra';
      }
    }
  });

  // Accessorio: se manca, il login deve funzionare comunque.
  const eye = form.querySelector('[data-action="toggle-password"]');
  if (eye) {
    eye.addEventListener('click', () => {
      const showing = form.password.type === 'text';
      form.password.type = showing ? 'password' : 'text';
      eye.textContent = showing ? '👁' : '🙈';
      eye.title = showing ? 'Mostra la password' : 'Nascondi la password';
    });
  }
}

/** Mostra il login e resta in attesa: risolve quando l'accesso è andato. */
function showLogin({ hasUsers = true } = {}) {
  // Ad accesso libero la schermata non deve comparire per nessun motivo.
  if (authDisabled) return Promise.resolve(null);

  const form = loginScreen.querySelector('[data-form="login"]');
  loginScreen.hidden = false;

  const noUsers = form?.querySelector('[data-no-users]');
  if (noUsers) noUsers.hidden = hasUsers;
  const submit = form?.querySelector('[data-submit]');
  if (submit) submit.disabled = !hasUsers;
  const errorEl = form?.querySelector('[data-error]');
  if (errorEl) errorEl.hidden = true;
  form?.email.focus();

  return new Promise((resolve) => {
    loginResolve = resolve;
  });
}

/**
 * Nessun errore silenzioso: qualunque eccezione non gestita finisce a schermo,
 * in una banda dedicata. Prima riusava la schermata di accesso, che ricompariva
 * a ogni errore facendo sembrare che servisse una password: sintomo fuorviante.
 */
function setupErrorSurface() {
  const banner = document.getElementById('fatal');

  const show = (message) => {
    if (!banner) return;
    banner.textContent = `Errore nell'interfaccia: ${message} — ricarica con Ctrl+Shift+R.`;
    banner.hidden = false;
  };

  window.addEventListener('error', (event) => show(event.message));
  window.addEventListener('unhandledrejection', (event) =>
    show(event.reason?.message ?? String(event.reason)),
  );
}

function paintAccount() {
  const account = document.querySelector('.account');
  // Ad accesso libero non c'è nessun utente da mostrare né da cui uscire.
  if (account) account.hidden = authDisabled;
  const email = document.querySelector('[data-account-email]');
  if (email) email.textContent = currentUser?.email ?? '';

  // Scritto in chiaro nell'intestazione: rende evidente quale modalità è attiva
  // senza dover leggere i log del server.
  const build = document.querySelector('.build');
  if (build) build.textContent = authDisabled ? 'v0.1 · accesso libero' : 'v0.1 · accesso protetto';
}

function setupAccountMenu() {
  const button = document.querySelector('[data-account-menu]');
  const pop = document.querySelector('[data-account-pop]');

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    pop.hidden = !pop.hidden;
  });
  document.addEventListener('click', () => (pop.hidden = true));

  pop.querySelector('[data-action="logout"]').addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // anche se la chiamata fallisce, la sessione lato client è finita
    }
    storeSessionToken(null);
    location.reload();
  });

  pop.querySelector('[data-action="change-password"]').addEventListener('click', () => {
    const form = dlgPassword.querySelector('[data-form="password"]');
    const errorEl = form.querySelector('[data-error]');
    form.reset();
    errorEl.hidden = true;
    dlgPassword.showModal();
    form.currentPassword.focus();

    form.querySelector('[data-action="cancel"]').onclick = () => dlgPassword.close();
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (form.newPassword.value !== form.confirm.value) {
        errorEl.textContent = 'Le due password non coincidono';
        errorEl.hidden = false;
        return;
      }
      try {
        const result = await api('/auth/password', {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: form.currentPassword.value,
            newPassword: form.newPassword.value,
          }),
        });
        dlgPassword.close();
        alert(result.message);
        location.reload();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    };
  });
}

/* ---------- tema ---------- */

// Lo stato iniziale è già applicato dallo script inline in index.html:
// qui si allinea solo lo switch e si gestisce il click.
function setupTheme() {
  const buttons = [...document.querySelectorAll('[data-theme-set]')];
  const systemPrefersLight = matchMedia('(prefers-color-scheme: light)');

  const paint = (theme) => {
    document.documentElement.dataset.theme = theme;
    for (const btn of buttons) {
      btn.setAttribute('aria-pressed', String(btn.dataset.themeSet === theme));
    }
  };

  paint(document.documentElement.dataset.theme ?? 'dark');

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      localStorage.setItem('twobee-theme', btn.dataset.themeSet);
      paint(btn.dataset.themeSet);
    });
  }

  // Finché non si sceglie a mano, si segue il tema di sistema.
  systemPrefersLight.addEventListener('change', (event) => {
    if (!localStorage.getItem('twobee-theme')) paint(event.matches ? 'light' : 'dark');
  });
}

/* ---------- helpers ---------- */

const TOKEN_KEY = 'twobee-session-token';

function sessionToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // sessionStorage negato dalle impostazioni del browser
  }
}

function storeSessionToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // resta il cookie come unico meccanismo
  }
}

async function api(pathname, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body) headers['Content-Type'] = 'application/json';

  // Il cookie è il meccanismo principale; l'header è la riserva per i browser
  // che non lo conservano (vedi tokenFromRequest lato server).
  const token = sessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${pathname}`, { ...options, headers });
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error ?? `Errore ${res.status}`);
    error.status = res.status;
    error.payload = data;

    // Sessione scaduta o revocata durante l'uso: si torna al login. Niente
    // location.reload() qui: era la causa dei campi che si svuotavano senza
    // spiegazione, perché in caso di sessione non valida si ricaricava in anello.
    if (res.status === 401 && !pathname.startsWith('/auth/')) {
      currentUser = null;
      storeSessionToken(null);
      if (!loginResolve) showLogin().then(() => startApp());
    }
    throw error;
  }
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('err', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3200);
}

function statusMeta(value) {
  return META.statuses.find((s) => s.value === value) ?? META.statuses.at(-1);
}

function archetypeLabel(value) {
  return META.archetypes.find((a) => a.value === value)?.label ?? null;
}

function fromTemplate(id) {
  return document.getElementById(id).content.cloneNode(true);
}

/** Popola le select di vocabolario (archetipo, CMS) di un nodo. */
function fillVocab(root) {
  for (const select of root.querySelectorAll('[data-archetypes]')) {
    select.innerHTML =
      '<option value="">— da assegnare —</option>' +
      META.archetypes.map((a) => `<option value="${a.value}">${a.label}</option>`).join('');
  }
  for (const select of root.querySelectorAll('[data-cms-select]')) {
    select.innerHTML =
      '<option value="">— non specificato —</option>' +
      META.cmsSuggestions.map((c) => `<option value="${c}">${c}</option>`).join('');
  }
}

/**
 * Seleziona il CMS salvato. Se un cliente ha un valore fuori dall'elenco
 * (dati vecchi o inseriti via API) lo si aggiunge come opzione, altrimenti
 * la select lo scarterebbe silenziosamente al primo salvataggio.
 */
function setCmsValue(select, value) {
  if (value && ![...select.options].some((o) => o.value === value)) {
    select.add(new Option(value, value));
  }
  select.value = value ?? '';
}

function statusSelect(name, value) {
  const options = META.statuses
    .map(
      (s) =>
        `<option value="${s.value}"${s.value === value ? ' selected' : ''}>${s.dot} ${s.label}</option>`,
    )
    .join('');
  return `<select name="${name}">${options}</select>`;
}

function flashSaved(form) {
  const badge = form.querySelector('[data-saved]');
  if (!badge) return;
  badge.hidden = false;
  setTimeout(() => (badge.hidden = true), 2000);
}

/* ---------- vault ---------- */

function paintVaultPill() {
  const pill = document.querySelector('[data-vault-pill]');
  const icon = pill.querySelector('[data-vault-icon]');
  const text = pill.querySelector('[data-vault-text]');

  if (!vault.initialized) {
    pill.className = 'vault-pill setup';
    icon.textContent = '⚠';
    text.textContent = 'Vault da creare';
    pill.title = 'Imposta la master password';
  } else if (vault.unlocked) {
    pill.className = 'vault-pill unlocked';
    icon.textContent = '🔓';
    text.textContent = 'Sbloccato';
    pill.title = 'Clicca per bloccare il vault';
  } else {
    pill.className = 'vault-pill locked';
    icon.textContent = '🔒';
    text.textContent = 'Bloccato';
    pill.title = 'Clicca per sbloccare il vault';
  }
}

async function refreshVault() {
  vault = await api('/vault/status');
  paintVaultPill();
  return vault;
}

/**
 * Un solo dialog per tre operazioni: 'setup' (primo avvio), 'unlock' e
 * 'reset'. Cambia testi, campi e endpoint, non struttura.
 */
function openVaultDialog(mode) {
  const form = dlgVault.querySelector('[data-form="vault"]');
  const errorEl = form.querySelector('[data-error]');
  const warningEl = form.querySelector('[data-vault-warning]');
  const confirmWrap = form.querySelector('[data-vault-confirm-wrap]');
  const resetLink = form.querySelector('[data-action="vault-goto-reset"]');

  const copy = {
    setup: {
      title: 'Attiva la cifratura delle credenziali',
      blurb:
        'Normalmente avviene da sola al momento dell\'accesso, con la tua password. ' +
        'Usa la stessa, così non ne avrai due da ricordare.',
      label: 'La tua password di accesso',
      submit: 'Attiva',
      confirm: true,
      warning: null,
      endpoint: '/vault/setup',
    },
    unlock: {
      title: 'Sblocca le credenziali',
      blurb:
        'È la tua password di accesso. La chiave di cifratura resta in memoria fino ' +
        'al blocco o al riavvio del server, mai su disco.',
      label: 'Password di accesso',
      submit: 'Sblocca',
      confirm: false,
      warning: null,
      endpoint: '/vault/unlock',
    },
    reset: {
      title: 'Reimposta la cifratura',
      blurb:
        'Serve se le credenziali erano state cifrate con una password diversa da quella ' +
        'di accesso. Non esiste recovery key.',
      label: 'La tua password di accesso',
      submit: 'Reimposta e cancella',
      confirm: true,
      warning:
        'Le credenziali API già salvate verranno cancellate: sono cifrate con la vecchia ' +
        'chiave e nessuno può più decifrarle. Si reinseriscono dalle piattaforme originali.',
      endpoint: '/vault/reset',
    },
  }[mode];

  form.reset();
  errorEl.hidden = true;
  form.querySelector('[data-vault-title]').textContent = copy.title;
  form.querySelector('[data-vault-blurb]').textContent = copy.blurb;
  form.querySelector('[data-vault-label]').textContent = copy.label;
  form.querySelector('[data-vault-submit]').textContent = copy.submit;
  confirmWrap.hidden = !copy.confirm;
  warningEl.hidden = !copy.warning;
  if (copy.warning) warningEl.textContent = copy.warning;
  resetLink.hidden = mode !== 'unlock';

  dlgVault.showModal();
  form.password.focus();

  form.querySelector('[data-action="vault-cancel"]').onclick = () => dlgVault.close();
  resetLink.onclick = () => {
    dlgVault.close();
    openVaultDialog('reset');
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    const password = form.password.value;

    if (copy.confirm && password !== form.confirm.value) {
      errorEl.textContent = 'Le due password non coincidono';
      errorEl.hidden = false;
      return;
    }

    const submit = form.querySelector('[data-vault-submit]');
    submit.disabled = true;
    submit.textContent = 'Attendi…'; // scrypt richiede ~300 ms
    try {
      const result = await api(copy.endpoint, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      vault = result;
      paintVaultPill();
      dlgVault.close();
      toast(
        mode === 'reset'
          ? `Vault reimpostato · ${result.wipedCredentials} credenziali cancellate`
          : mode === 'setup'
            ? 'Vault creato e sbloccato'
            : 'Vault sbloccato',
      );
      route();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = copy.submit;
    }
  };
}

function setupVaultPill() {
  document.querySelector('[data-vault-pill]').addEventListener('click', async () => {
    if (!vault.initialized) return openVaultDialog('setup');
    if (!vault.unlocked) return openVaultDialog('unlock');
    try {
      vault = await api('/vault/lock', { method: 'POST' });
      paintVaultPill();
      toast('Vault bloccato');
      route();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------- vista: lista clienti ---------- */

/** Esito QA di un cliente, per riga della lista. */
function qaFor(clientId) {
  return qa.items?.find((i) => i.clientId === clientId) ?? { status: 'mai', problems: [] };
}

// 'indeterminato' → giallo: controllato, ma l'HTML non permette di concludere.
const QA_DOT = { ok: 'active', indeterminato: 'partial', problema: 'todo', mai: 'na' };

/** Avviso in cima alla lista: è il "quando apri l'app te ne accorgi". */
function renderQaAlert(container) {
  const problemi = qa.withProblems ?? [];
  const quando = qa.lastRun?.finished_at ? `Ultimo controllo: ${qa.lastRun.finished_at}` : 'Mai eseguito';

  if (problemi.length === 0) {
    container.innerHTML = `
      <div class="qa-bar ok">
        <span><i class="dot active"></i> Nessun problema di tracking rilevato</span>
        <span class="muted">${quando}</span>
        <button class="btn" type="button" data-action="qa-run">Controlla ora</button>
      </div>`;
  } else {
    const totale = problemi.reduce((n, p) => n + p.problems.length, 0);
    container.innerHTML = `
      <div class="qa-bar alert">
        <div>
          <strong>${totale} problem${totale === 1 ? 'a' : 'i'} su ${problemi.length} client${problemi.length === 1 ? 'e' : 'i'}</strong>
          <ul>
            ${problemi
              .map(
                (p) =>
                  `<li><a href="#/clients/${p.clientId}">${escapeHtml(p.name)}</a>: ${p.problems
                    .map((x) => escapeHtml(x.detail))
                    .join(' · ')}</li>`,
              )
              .join('')}
          </ul>
        </div>
        <div class="qa-bar-side">
          <span class="muted">${quando}</span>
          <button class="btn" type="button" data-action="qa-run">Controlla ora</button>
        </div>
      </div>`;
  }

  const button = container.querySelector('[data-action="qa-run"]');
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Controllo…';
    try {
      const esito = await api('/qa/run', { method: 'POST' });
      qa = await api('/qa');
      toast(`Controllo completato: ${esito.clients} clienti, ${esito.problems} problemi`);
      renderList();
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
      button.textContent = 'Controlla ora';
    }
  };
}

function renderList() {
  const node = fromTemplate('tpl-list');
  const tbody = node.querySelector('[data-rows]');
  const emptyEl = node.querySelector('[data-empty]');
  const countEl = node.querySelector('[data-count]');
  const filterEl = node.querySelector('#filter');

  const byBadge = clients.reduce((acc, c) => {
    acc[c.tracking_badge] = (acc[c.tracking_badge] ?? 0) + 1;
    return acc;
  }, {});
  countEl.textContent =
    `${clients.length} clienti · ` +
    `${byBadge.active ?? 0} attivi, ${byBadge.partial ?? 0} parziali, ${byBadge.todo ?? 0} da fare`;

  const needle = filterText.trim().toLowerCase();
  const rows = needle
    ? clients.filter((c) =>
        [c.name, c.cms, c.gtm_container_id, archetypeLabel(c.archetype)]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(needle)),
      )
    : clients;

  emptyEl.hidden = rows.length > 0;

  tbody.innerHTML = rows
    .map((c) => {
      const cell = (key) => `<td><i class="dot ${c[key]}" title="${statusMeta(c[key]).label}"></i></td>`;
      const archetype = archetypeLabel(c.archetype);
      return `
        <tr data-id="${c.id}">
          <td>
            <div class="client-cell">
              <i class="dot ${c.tracking_badge}"></i>
              <span>${escapeHtml(c.name)}</span>
            </div>
          </td>
          <td>${
            archetype
              ? `<span class="tag">${archetype}</span>`
              : '<span class="tag unset">da assegnare</span>'
          }</td>
          <td>${c.cms ? escapeHtml(c.cms) : '<span class="muted">—</span>'}</td>
          <td>
            <div class="client-cell">
              <i class="dot ${c.status_gtm}" title="${statusMeta(c.status_gtm).label}"></i>
              ${
                c.gtm_container_id
                  ? `<span class="gtm-id">${escapeHtml(c.gtm_container_id)}</span>`
                  : ''
              }
            </div>
          </td>
          ${cell('status_ga4')}
          ${cell('status_meta_pixel')}
          ${cell('status_klaviyo')}
          ${cell('status_gsc')}
          ${(() => {
            const esito = qaFor(c.id);
            const titolo =
              esito.status === 'problema'
                ? esito.problems.map((p) => p.detail).join(' · ')
                : esito.status === 'ok'
                  ? 'Controllo giornaliero superato'
                  : esito.checkedAt
                    ? 'Niente da verificare: mancano URL del sito, Property ID o Pixel ID'
                    : 'Mai controllato';
            return `<td><i class="dot ${QA_DOT[esito.status] ?? 'na'}" title="${escapeHtml(titolo)}"></i></td>`;
          })()}
          <td class="chev">›</td>
        </tr>`;
    })
    .join('');

  tbody.addEventListener('click', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (tr) location.hash = `#/clients/${tr.dataset.id}`;
  });

  filterEl.value = filterText;
  filterEl.addEventListener('input', () => {
    filterText = filterEl.value;
    renderList();
    document.getElementById('filter').focus();
  });

  node.querySelector('[data-action="new"]').addEventListener('click', openNewDialog);
  renderQaAlert(node.querySelector('[data-qa-alert]'));

  view.replaceChildren(node);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

/* ---------- vista: scheda cliente ---------- */

function renderDetail(client) {
  const node = fromTemplate('tpl-detail');
  fillVocab(node);

  node.querySelector('[data-title]').textContent = client.name;
  node.querySelector('[data-subtitle]').textContent =
    `${archetypeLabel(client.archetype) ?? 'archetipo da assegnare'} · ` +
    `tracking ${statusMeta(client.tracking_badge).label.toLowerCase()} · ` +
    `aggiornato ${client.updated_at}`;

  // --- tab tracking
  const trackingPanel = node.querySelector('[data-panel="tracking"]');
  const trackingForm = node.querySelector('[data-form="tracking"]');
  trackingForm.archetype.value = client.archetype ?? '';
  setCmsValue(trackingForm.cms, client.cms);
  trackingForm.gtm_container_id.value = client.gtm_container_id;
  trackingForm.website_url.value = client.website_url ?? '';
  trackingForm.meta_pixel_id.value = client.meta_pixel_id ?? '';

  const channels = [...META.channels, { key: 'gsc', label: 'Search Console' }];
  const statusesEl = node.querySelector('[data-statuses]');
  statusesEl.innerHTML = channels
    .map((ch) => {
      const name = `status_${ch.key}`;
      return `
        <div class="status-row" data-channel="${ch.key}">
          <i class="dot ${client[name]}"></i>
          <span class="status-label">${ch.label}</span>
          <label>${statusSelect(name, client[name])}</label>
          <span class="off-scope-hint">fuori archetipo</span>
        </div>`;
    })
    .join('');

  // Segnala i canali non pertinenti all'archetipo scelto (GSC vale sempre).
  const markPertinence = (archetype) => {
    const relevant = META.archetypes.find((a) => a.value === archetype)?.channels;
    for (const row of statusesEl.querySelectorAll('.status-row')) {
      const key = row.dataset.channel;
      const off = Boolean(relevant) && key !== 'gsc' && !relevant.includes(key);
      row.classList.toggle('off-scope', off);
    }
  };
  markPertinence(client.archetype);

  trackingForm.addEventListener('change', (event) => {
    // aggiorna il pallino accanto alla select modificata
    const row = event.target.closest('.status-row');
    if (row) row.querySelector('.dot').className = `dot ${event.target.value}`;
    if (event.target.name === 'archetype') markPertinence(event.target.value);
  });

  trackingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(trackingForm));
    const updated = await save(client.id, body, trackingForm);
    if (!updated) return;

    // Cambiando archetipo cambia la checklist, cambiando URL si abilita la
    // verifica: in entrambi i casi il pannello va ridisegnato.
    Object.assign(client, updated);
    trackingForm.website_url.value = updated.website_url;
    await renderTracking(client, trackingPanel).catch((err) => toast(err.message, true));
  });

  // --- tab note
  const noteForm = node.querySelector('[data-form="note"]');
  noteForm.notes.value = client.notes;
  noteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await save(client.id, { notes: noteForm.notes.value }, noteForm);
  });

  // --- elimina
  node.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!confirm(`Eliminare "${client.name}" e tutti i suoi dati?`)) return;
    try {
      await api(`/clients/${client.id}`, { method: 'DELETE' });
      toast(`${client.name} eliminato`);
      clients = await api('/clients');
      location.hash = '#/clients';
    } catch (err) {
      toast(err.message, true);
    }
  });

  // --- tabs
  const tabs = [...node.querySelectorAll('.tab')];
  const panels = [...node.querySelectorAll('.panel')];
  // Ogni scheda dinamica ha il suo pannello e la sua funzione di disegno. Si
  // ridisegnano all'apertura: stato della cifratura, checklist e report possono
  // essere cambiati da quando la scheda cliente è stata aperta.
  const dynamic = {
    chiavi: [node.querySelector('[data-panel="chiavi"]'), renderKeys],
    tracking: [trackingPanel, renderTracking],
    report: [node.querySelector('[data-panel="report"]'), renderReport],
    credenziali: [node.querySelector('[data-panel="credenziali"]'), renderAccounts],
  };

  const activate = (name) => {
    for (const tab of tabs) tab.classList.toggle('on', tab.dataset.tab === name);
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;

    const entry = dynamic[name];
    if (entry) entry[1](client, entry[0]).catch((err) => toast(err.message, true));
  };
  for (const tab of tabs) tab.addEventListener('click', () => activate(tab.dataset.tab));
  activate('tracking');

  view.replaceChildren(node);
}

/* ---------- tab tracking: verifica automatica + checklist ---------- */

/** Riallinea select e pallini dopo che la verifica ha cambiato degli stati. */
function applyStatusesToForm(panel, client) {
  for (const row of panel.querySelectorAll('.status-row')) {
    const field = `status_${row.dataset.channel}`;
    const select = row.querySelector('select');
    if (!select || client[field] === undefined) continue;
    select.value = client[field];
    row.querySelector('.dot').className = `dot ${client[field]}`;
  }
}

function renderVerifyResult(container, result, qaChecks = []) {
  if (!result.ok) {
    container.innerHTML = `<div class="notice danger">${escapeHtml(result.error)} — nessuno stato è stato modificato.</div>`;
    return;
  }

  const found = result.found;
  // Con GTM presente, l'assenza di un tag nell'HTML non dimostra nulla: GTM lo
  // inietta a runtime. Per GA4 esiste una prova migliore — i dati che arrivano
  // davvero — e si mostra quella al posto di un "non trovato" fuorviante.
  const gtmPresente = found.gtmIds.length > 0;
  const ga4Api = qaChecks.find((c) => c.key === 'ga4');

  const ga4InHtml = found.ga4Ids.length
    ? found.ga4Ids.join(', ')
    : found.gtagLoaded
      ? 'gtag.js diretto'
      : null;

  /** state: 'yes' trovato · 'no' assente · 'unknown' non deducibile dall'HTML */
  const chip = (label, value) => ({ label, value, state: value ? 'yes' : 'no' });

  let ga4Chip;
  if (ga4InHtml) {
    ga4Chip = chip('GA4', ga4InHtml);
  } else if (!gtmPresente) {
    // Senza GTM l'HTML è l'unica fonte: l'assenza è un'assenza vera.
    ga4Chip = chip('GA4', null);
  } else if (ga4Api?.status === 'ok') {
    ga4Chip = { label: 'GA4', value: `via GTM · ${ga4Api.detail}`, state: 'yes' };
  } else if (ga4Api?.status === 'problema') {
    ga4Chip = { label: 'GA4', value: `via GTM · ${ga4Api.detail}`, state: 'no' };
  } else {
    ga4Chip = {
      label: 'GA4',
      value: 'caricato da GTM: lancia il controllo giornaliero per saperlo',
      state: 'unknown',
    };
  }

  const rows = [
    chip('GTM', found.gtmIds.length ? found.gtmIds.join(', ') : null),
    ga4Chip,
    chip('Meta Pixel', found.metaIds.length ? found.metaIds.join(', ') : found.fbevents ? 'fbevents.js' : null),
    chip('Klaviyo', found.klaviyo ? 'script presente' : null),
  ];

  container.innerHTML = `
    <div class="verify-result">
      <p class="muted">
        ${escapeHtml(result.url)} · HTTP ${result.httpStatus} ·
        ${(result.bytes / 1024).toFixed(0)} KB letti in ${result.durationMs} ms
      </p>
      <div class="verify-found">
        ${rows
          .map(
            ({ label, value, state }) => `
          <span class="found-chip ${state}">
            ${state === 'yes' ? '✓' : state === 'unknown' ? '?' : '·'} ${label}${value ? `: ${escapeHtml(value)}` : ''}
          </span>`,
          )
          .join('')}
      </div>
      ${
        result.changes.length
          ? `<div class="notice">
               <strong>Stati aggiornati</strong>
               <ul>${result.changes
                 .map((c) => `<li>${c.field.replace('status_', '')}: ${c.from} → <strong>${c.to}</strong> — ${escapeHtml(c.reason)}</li>`)
                 .join('')}</ul>
             </div>`
          : '<p class="muted">Nessuno stato da aggiornare.</p>'
      }
      ${
        result.notes.length
          ? `<div class="notice"><ul>${result.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`
          : ''
      }
      <p class="muted">
        ${
          gtmPresente
            ? 'Il sito carica GTM, quindi gli altri tag possono essere iniettati a runtime e non comparire ' +
              'nel sorgente: per GA4 il verdetto qui sopra arriva dai dati reali della Data API, non dall\'HTML.'
            : 'Sul sito non c\'è GTM: qui l\'HTML è l\'unica fonte, quindi un tag assente è assente davvero.'
        }
        Solo il container GTM viene aggiornato in entrambe le direzioni; gli altri canali
        passano ad “attivo” quando c'è una prova, ma non vengono mai declassati.
      </p>
    </div>`;
}

function renderChecklist(container, titleEl, data) {
  titleEl.textContent = data.archetype
    ? `${data.title} · ${data.progress.done}/${data.progress.total} completate`
    : '';

  if (!data.archetype) {
    container.innerHTML =
      '<div class="notice">Assegna un archetipo per caricare la checklist di setup corrispondente.</div>';
    return;
  }

  container.innerHTML = `
    <div class="progress" title="${data.progress.percent}%">
      <div class="progress-fill" style="width:${data.progress.percent}%"></div>
    </div>
    ${data.sections
      .map(
        (section) => `
      <details class="check-section" ${section.done === section.total ? '' : 'open'}>
        <summary>
          <span>${escapeHtml(section.title)}</span>
          <span class="muted">${section.done}/${section.total}</span>
        </summary>
        ${section.items
          .map(
            (item) => `
          <div class="check-item ${item.done ? 'done' : ''}" data-item="${item.id}">
            <label class="check-line">
              <input type="checkbox" ${item.done ? 'checked' : ''} />
              <span class="check-title">${escapeHtml(item.title)}</span>
            </label>
            ${item.detail ? `<p class="check-detail">${escapeHtml(item.detail)}</p>` : ''}
            <input class="check-note" placeholder="nota…" value="${escapeHtml(item.note)}" />
          </div>`,
          )
          .join('')}
      </details>`,
      )
      .join('')}`;
}

/** Esito del controllo giornaliero, in cima alla scheda Tracking. */
async function renderQaBlock(client, panel) {
  const container = panel.querySelector('[data-qa-block]');
  if (!container) return;

  const { checks } = await api(`/qa/clients/${client.id}`);
  const problemi = checks.filter((c) => c.status === 'problema').length;
  const quando = checks.find((c) => c.checkedAt)?.checkedAt;

  container.innerHTML = `
    <div class="qa-detail ${problemi ? 'alert' : ''}">
      <div class="qa-detail-head">
        <strong>Controllo giornaliero</strong>
        <span class="qa-detail-side">
          <span class="muted">${quando ? `ultimo: ${quando}` : 'mai eseguito'}</span>
          <button class="btn" type="button" data-action="qa-recheck">Ricontrolla</button>
        </span>
      </div>
      ${checks
        .map(
          (c) => `
        <div class="qa-check">
          <i class="dot ${QA_DOT[c.status] ?? 'na'}"></i>
          <span class="qa-check-label">${escapeHtml(c.label)}</span>
          <span class="muted">${escapeHtml(c.detail)}</span>
        </div>`,
        )
        .join('')}
      <p class="muted qa-nota">
        Questo è l'esito dell'ultimo controllo, non una verifica dal vivo: dopo aver
        cambiato Property ID, container o Pixel usa <strong>Ricontrolla</strong>.
      </p>
    </div>`;

  container.querySelector('[data-action="qa-recheck"]').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Controllo…';
    try {
      const result = await api(`/qa/clients/${client.id}/run`, { method: 'POST' });
      // Il controllo può aver promosso uno stato: si riallinea la scheda.
      Object.assign(client, result.client);
      clients = clients.map((c) => (c.id === result.client.id ? { ...c, ...result.client } : c));
      applyStatusesToForm(panel, result.client);
      toast(result.problems ? `${result.problems} problemi rilevati` : 'Controllo superato');
      await renderQaBlock(client, panel);
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
      button.textContent = 'Ricontrolla';
    }
  };
}

async function renderTracking(client, panel) {
  renderQaBlock(client, panel).catch((err) => toast(err.message, true));
  const verifyHint = panel.querySelector('[data-verify-hint]');
  const verifyResult = panel.querySelector('[data-verify-result]');
  const verifyBtn = panel.querySelector('[data-action="verify"]');
  const checklistEl = panel.querySelector('[data-checklist]');
  const checklistTitle = panel.querySelector('[data-checklist-title]');

  const [checklist, history] = await Promise.all([
    api(`/clients/${client.id}/tracking/checklist`),
    api(`/clients/${client.id}/tracking/checks`),
  ]);

  renderChecklist(checklistEl, checklistTitle, checklist);

  verifyBtn.disabled = !client.website_url;
  verifyHint.textContent = !client.website_url
    ? 'Aggiungi il sito web e salva per abilitare la verifica.'
    : history.length
      ? `Ultima verifica: ${history[0].checkedAt}${history[0].ok ? '' : ' (fallita)'}`
      : 'Mai eseguita.';

  verifyBtn.onclick = async () => {
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifico…';
    try {
      const result = await api(`/clients/${client.id}/tracking/check`, { method: 'POST' });
      // Gli esiti del controllo giornaliero servono a interpretare il risultato:
      // con GTM presente sono loro il segnale attendibile per GA4.
      const { checks } = await api(`/qa/clients/${client.id}`).catch(() => ({ checks: [] }));
      renderVerifyResult(verifyResult, result, checks);
      // La verifica può aver cambiato gli stati: riallinea form, elenco e badge.
      Object.assign(client, result.client);
      applyStatusesToForm(panel, result.client);
      clients = clients.map((c) => (c.id === result.client.id ? { ...c, ...result.client } : c));
      verifyHint.textContent = `Ultima verifica: adesso${result.ok ? '' : ' (fallita)'}`;
      toast(result.changes.length ? `${result.changes.length} stati aggiornati` : 'Verifica completata');
    } catch (err) {
      toast(err.message, true);
    } finally {
      verifyBtn.disabled = !client.website_url;
      verifyBtn.textContent = 'Verifica ora';
    }
  };

  // Spunte e note: un solo listener sul contenitore, i nodi vengono ridisegnati.
  const persist = async (itemId, body) => {
    try {
      const result = await api(`/clients/${client.id}/tracking/checklist/${itemId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      checklistTitle.textContent = `${checklist.title} · ${result.progress.done}/${result.progress.total} completate`;
      const fill = checklistEl.querySelector('.progress-fill');
      if (fill) fill.style.width = `${Math.round((result.progress.done / result.progress.total) * 100)}%`;
      return result;
    } catch (err) {
      toast(err.message, true);
      return null;
    }
  };

  checklistEl.onchange = async (event) => {
    const wrapper = event.target.closest('.check-item');
    if (!wrapper) return;
    const itemId = wrapper.dataset.item;

    if (event.target.type === 'checkbox') {
      const result = await persist(itemId, { done: event.target.checked });
      if (result) {
        wrapper.classList.toggle('done', result.done);
        // Aggiorna il contatore della sezione senza ricaricare tutto
        const section = wrapper.closest('.check-section');
        const items = section.querySelectorAll('.check-item');
        const done = section.querySelectorAll('.check-item.done').length;
        section.querySelector('summary .muted').textContent = `${done}/${items.length}`;
      } else {
        event.target.checked = !event.target.checked;
      }
    } else if (event.target.classList.contains('check-note')) {
      await persist(itemId, { note: event.target.value });
    }
  };
}

/* ---------- tab credenziali ---------- */

// `panel` è l'elemento del pannello, non il fragment: dopo replaceChildren il
// fragment è vuoto, mentre il riferimento all'elemento resta valido.
async function renderKeys(client, panel) {
  const lockedEl = panel.querySelector('[data-creds-locked]');
  const listEl = panel.querySelector('[data-creds-list]');
  const msgEl = panel.querySelector('[data-creds-locked-msg]');
  const unlockBtn = panel.querySelector('[data-action="unlock-from-panel"]');

  const showLocked = (message, buttonLabel) => {
    msgEl.textContent = message;
    unlockBtn.textContent = buttonLabel;
    lockedEl.hidden = false;
    listEl.hidden = true;
  };

  unlockBtn.onclick = () => openVaultDialog(vault.initialized ? 'unlock' : 'setup');

  if (!vault.initialized) {
    return showLocked(
      'Per salvare le chiavi serve una password che le cifri nel database. ' +
        'Non è una password di accesso: la dashboard resta libera, questa protegge solo i segreti.',
      'Imposta password di cifratura',
    );
  }
  if (!vault.unlocked) {
    return showLocked('Cifratura bloccata: sbloccala per vedere o modificare le chiavi.', 'Sblocca');
  }

  const { items } = await api(`/clients/${client.id}/credentials`);
  lockedEl.hidden = true;
  listEl.hidden = false;

  listEl.innerHTML =
    '<h3 style="margin-top:0">Chiavi per piattaforma</h3>' +
    items
      .map(
        (item) => `
        <div class="cred-row" data-platform="${item.platform}">
          <div class="cred-head">
            <span class="cred-label">${item.label}</span>
            <span class="cred-state ${item.hasValue ? 'set' : ''}">
              ${
                item.error
                  ? `non decifrabile: ${escapeHtml(item.error)}`
                  : item.hasValue
                    ? `impostata il ${item.updatedAt}`
                    : 'non impostata'
              }
            </span>
          </div>
          <div class="cred-controls">
            <input
              type="text"
              autocomplete="off"
              spellcheck="false"
              value="${escapeHtml(item.value ?? '')}"
              placeholder="${escapeHtml(item.hint)}"
            />
            <button class="btn" type="button" data-act="hide" ${item.hasValue ? '' : 'disabled'}>Nascondi</button>
            <button class="btn primary" type="button" data-act="save">Salva</button>
            <button class="btn danger-ghost" type="button" data-act="delete" ${item.hasValue ? '' : 'disabled'}>Elimina</button>
          </div>
        </div>`,
      )
      .join('') +
    `<p class="muted">
       I valori sono cifrati AES-256-GCM prima di toccare il DB. Salvare un campo vuoto
       equivale a eliminare la chiave.
     </p>`;

  listEl.onclick = async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;

    const row = button.closest('.cred-row');
    const platform = row.dataset.platform;
    const input = row.querySelector('input');
    const base = `/clients/${client.id}/credentials/${platform}`;

    try {
      // I valori sono già in chiaro: il pulsante serve solo a coprirli al volo,
      // per esempio durante una condivisione schermo.
      if (button.dataset.act === 'hide') {
        const coperto = input.type === 'password';
        input.type = coperto ? 'text' : 'password';
        button.textContent = coperto ? 'Nascondi' : 'Mostra';
        return;
      }

      if (button.dataset.act === 'save') {
        const value = input.value.trim();
        await api(base, { method: 'PUT', body: JSON.stringify({ value }) });
        toast(value === '' ? `${platform}: chiave eliminata` : `${platform}: chiave salvata`);
      } else {
        if (!confirm(`Eliminare la chiave ${platform} di ${client.name}?`)) return;
        await api(base, { method: 'DELETE' });
        toast(`${platform}: chiave eliminata`);
      }
      await renderKeys(client, panel);
    } catch (err) {
      toast(err.message, true);
      if (err.message.includes('bloccato')) await refreshVault();
    }
  };
}

/* ---------- tab report ---------- */

/**
 * Intestazione leggibile di una colonna. I nomi nativi di GA4 restano intatti
 * — sono quelli che si ritrovano in Esplora, e cambiarli confonderebbe — mentre
 * le colonne che calcoliamo noi (funnel, Klaviyo) usano snake_case italiano e
 * qui diventano testo normale.
 */
function metricLabel(name) {
  if (!name.includes('_')) return name;
  const testo = name.replace(/_/g, ' ');
  return testo.charAt(0).toUpperCase() + testo.slice(1);
}

/** Nome leggibile della fonte di un report. */
function sourceLabel(source) {
  return { ga4: 'GA4', klaviyo: 'Klaviyo', meta: 'Meta' }[source] ?? escapeHtml(String(source ?? ''));
}

function formatMetric(name, value) {
  // I nomi GA4 dicono già il tipo: le percentuali arrivano come frazione 0..1
  // e i tempi in secondi. Mostrarli grezzi renderebbe i numeri illeggibili.
  // Klaviyo e le colonne calcolate del funnel usano nomi italiani, con la
  // stessa convenzione: i tassi sono frazioni 0..1.
  if (/^(tasso_|percentuale_)/.test(name)) return `${(value * 100).toFixed(1)}%`;
  // Importi in euro: ricavi Klaviyo, spesa e costi Meta.
  if (/^(ricavi|spesa|costo_per_conversione|costo_per_azione)$/.test(name)) {
    return value.toLocaleString('it-IT', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: value < 100 ? 2 : 0,
    });
  }
  if (/Rate$/.test(name)) return `${(value * 100).toFixed(1)}%`;
  if (/^average.*Duration$/i.test(name) || /Duration$/.test(name)) {
    const total = Math.round(value);
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  }
  if (/Revenue$/.test(name)) {
    return value.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  }
  return value.toLocaleString('it-IT', { maximumFractionDigits: 1 });
}

function variationChip(variation) {
  if (variation === null || variation === undefined) return '<span class="delta none">n/d</span>';
  const cls = variation > 0 ? 'up' : variation < 0 ? 'down' : 'flat';
  const sign = variation > 0 ? '+' : '';
  return `<span class="delta ${cls}">${sign}${variation}%</span>`;
}

function renderReportView(container, report) {
  container.innerHTML = `
    <div class="report">
      <p class="muted">
        <span class="tag source-${escapeHtml(report.source)}">${sourceLabel(report.source)}</span>
        ${escapeHtml(report.definition)} · ${report.period.start} → ${report.period.end}
        · confronto ${report.period.compareStart} → ${report.period.compareEnd}
        ${report.sampled ? ' · <strong>dati campionati da GA4</strong>' : ''}
        ${report.conversionMetric ? ` · ricavi da "${escapeHtml(report.conversionMetric)}"` : ''}
        ${report.leadEvent ? ` · evento lead "${escapeHtml(report.leadEvent)}"` : ''}
      </p>
      ${
        report.skipped?.length
          ? `<div class="notice">
               <strong>Sezioni senza dati</strong> — dipendono dalla configurazione GTM di questo cliente:
               <ul>${report.skipped
                 .map((s) => `<li>${escapeHtml(s.title ?? s.id)}: ${escapeHtml(s.reason)}</li>`)
                 .join('')}</ul>
             </div>`
          : ''
      }

      <div class="kpis">
        ${report.totals
          .map(
            (t) => `
          <div class="kpi">
            <span class="kpi-name">${escapeHtml(metricLabel(t.metric))}</span>
            <span class="kpi-value">${formatMetric(t.metric, t.current)}</span>
            <span class="kpi-prev">${formatMetric(t.metric, t.previous)} ${variationChip(t.variation)}</span>
          </div>`,
          )
          .join('')}
      </div>

      ${report.breakdowns
        .map(
          (b) => `
        <h3>${escapeHtml(b.title)}</h3>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                ${b.dimensions.map((d) => `<th>${escapeHtml(metricLabel(d))}</th>`).join('')}
                ${b.metrics.map((m) => `<th>${escapeHtml(metricLabel(m))}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${b.rows
                .map(
                  (row) => `
                <tr>
                  ${b.dimensions.map((d) => `<td>${escapeHtml(row.dimensions[d] ?? '')}</td>`).join('')}
                  ${b.metrics
                    .map((m) => {
                      const current = row.metrics[m] ?? 0;
                      const previous = row.previous?.[m];
                      const delta =
                        previous === undefined || previous === 0
                          ? null
                          : Math.round(((current - previous) / previous) * 1000) / 10;
                      return `<td class="num">${formatMetric(m, current)} ${
                        previous === undefined ? '' : variationChip(delta)
                      }</td>`;
                    })
                    .join('')}
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>`,
        )
        .join('')}
    </div>`;
}

async function renderReport(client, panel) {
  const form = panel.querySelector('[data-form="report-config"]');
  const blockersEl = panel.querySelector('[data-report-blockers]');
  const periodEl = panel.querySelector('[data-report-period]');
  const runBtn = panel.querySelector('[data-action="run-report"]');
  const metaBtn = panel.querySelector('[data-action="ga4-metadata"]');
  const metadataEl = panel.querySelector('[data-report-metadata]');
  const viewEl = panel.querySelector('[data-report-view]');
  const historyEl = panel.querySelector('[data-report-history]');

  const state = await api(`/clients/${client.id}/reports`);
  form.ga4_property_id.value = state.propertyId;

  // L'evento del funnel riguarda solo il B2B: altrove sarebbe un campo inerte.
  const leadWrap = panel.querySelector('[data-lead-event]');
  if (leadWrap) {
    leadWrap.hidden = client.archetype !== 'leadgen-b2b';
    form.lead_event.value = client.lead_event ?? '';
  }

  blockersEl.innerHTML = state.canRun
    ? ''
    : `<div class="notice"><strong>Prima di generare il report GA4 serve:</strong>
         <ul>${state.blockers.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul></div>`;

  // Ogni fonte ha la sua catena di prerequisiti: elencarle insieme
  // nasconderebbe quale manca a quale connettore.
  const mostraBlocchi = (selettore, stato, nome) => {
    const el = panel.querySelector(selettore);
    if (!el) return;
    el.innerHTML = stato?.canRun
      ? ''
      : `<div class="notice"><strong>Prima di estrarre da ${nome} serve:</strong>
           <ul>${(stato?.blockers ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul></div>`;
  };
  mostraBlocchi('[data-klaviyo-blockers]', state.klaviyo, 'Klaviyo');
  mostraBlocchi('[data-meta-blockers]', state.meta, 'Meta');

  periodEl.textContent = `Periodo: ${state.period.start} → ${state.period.end} (confronto ${state.period.compareStart} → ${state.period.compareEnd})`;
  runBtn.disabled = !state.canRun;
  metaBtn.disabled = !state.canRun;

  /** Stessa meccanica per ogni fonte: estrai, mostra, ricarica lo storico. */
  const collegaEstrazione = (selettore, { stato, endpoint, etichetta, attesa, esito }) => {
    const btn = panel.querySelector(selettore);
    if (!btn) return;

    btn.disabled = !stato?.canRun;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = attesa;
      try {
        const report = await api(`/clients/${client.id}/reports/${endpoint}`, { method: 'POST' });
        renderReportView(viewEl, report);
        toast(esito(report));
        await renderReport(client, panel);
        renderReportView(panel.querySelector('[data-report-view]'), report);
      } catch (err) {
        toast(err.message, true);
        await renderReport(client, panel);
      } finally {
        btn.textContent = etichetta;
      }
    };
  };

  collegaEstrazione('[data-action="run-klaviyo"]', {
    stato: state.klaviyo,
    endpoint: 'klaviyo',
    etichetta: 'Estrai dati Klaviyo',
    attesa: 'Interrogo Klaviyo…',
    esito: (r) => `Klaviyo: ${r.flows} flussi attivi estratti`,
  });

  collegaEstrazione('[data-action="run-meta"]', {
    stato: state.meta,
    endpoint: 'meta',
    etichetta: 'Estrai dati Meta',
    attesa: 'Interrogo Meta…',
    esito: (r) =>
      r.vuoto ? 'Meta: nessuna erogazione nel periodo' : `Meta: dati estratti da ${r.adAccountId}`,
  });

  historyEl.innerHTML = state.runs.length
    ? `<div class="table-wrap"><table class="table">
         <thead><tr><th>Quando</th><th>Fonte</th><th>Definizione</th><th>Periodo</th><th>Esito</th><th></th></tr></thead>
         <tbody>${state.runs
           .map(
             (r) => `
           <tr data-run="${r.id}">
             <td>${r.createdAt}</td>
             <td><span class="tag source-${escapeHtml(r.source)}">${sourceLabel(r.source)}</span></td>
             <td>${escapeHtml(r.definition)}</td>
             <td>${r.period.start} → ${r.period.end}</td>
             <td>${
               r.ok
                 ? `<span class="tag">${r.rowCount} righe</span>`
                 : `<span class="tag unset" title="${escapeHtml(r.error ?? '')}">errore</span>`
             }</td>
             <td>${
               r.ok
                 ? `<button class="btn" type="button" data-act="open">Apri</button>
                    <a class="btn" href="/api/clients/${client.id}/reports/${r.id}/csv">CSV</a>`
                 : ''
             }</td>
           </tr>`,
           )
           .join('')}</tbody></table></div>`
    : '<p class="muted">Nessun report generato.</p>';

  historyEl.onclick = async (event) => {
    if (!event.target.closest('[data-act="open"]')) return;
    const runId = event.target.closest('tr[data-run]').dataset.run;
    try {
      renderReportView(viewEl, await api(`/clients/${client.id}/reports/${runId}`));
      viewEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (err) {
      toast(err.message, true);
    }
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    const body = { ga4_property_id: form.ga4_property_id.value };
    if (client.archetype === 'leadgen-b2b') body.lead_event = form.lead_event.value;

    const updated = await save(client.id, body, form);
    if (!updated) return;
    Object.assign(client, updated);
    await renderReport(client, panel);
  };

  runBtn.onclick = async () => {
    runBtn.disabled = true;
    runBtn.textContent = 'Interrogo GA4…';
    try {
      const report = await api(`/clients/${client.id}/reports`, { method: 'POST' });
      renderReportView(viewEl, report);
      toast('Report generato');
      // Ricarica lo storico ma tiene visibile il report appena prodotto.
      const fresh = await api(`/clients/${client.id}/reports`);
      state.runs = fresh.runs;
      await renderReport(client, panel);
      renderReportView(panel.querySelector('[data-report-view]'), report);
    } catch (err) {
      toast(err.message, true);
      if (err.message.includes('bloccato')) await refreshVault();
      await renderReport(client, panel);
    } finally {
      runBtn.textContent = 'Genera report';
    }
  };

  metaBtn.onclick = async () => {
    metaBtn.disabled = true;
    try {
      const meta = await api(`/clients/${client.id}/reports/metadata`);
      const list = (title, entries) => `
        <details class="check-section" open>
          <summary><span>${title}</span><span class="muted">${entries.length}</span></summary>
          <div class="meta-list">
            ${entries
              .map(
                (e) =>
                  `<div><code>${escapeHtml(e.apiName)}</code> <span class="muted">${escapeHtml(e.uiName)}${e.custom ? ' · personalizzata' : ''}</span></div>`,
              )
              .join('')}
          </div>
        </details>`;
      metadataEl.innerHTML = list('Metriche disponibili', meta.metrics) + list('Dimensioni disponibili', meta.dimensions);
    } catch (err) {
      toast(err.message, true);
    } finally {
      metaBtn.disabled = false;
    }
  };
}

/* ---------- vista: impostazioni ---------- */

async function renderSettings() {
  const node = fromTemplate('tpl-settings');
  const lockedEl = node.querySelector('[data-agency-locked]');
  const listEl = node.querySelector('[data-agency-list]');

  node.querySelector('[data-action="unlock-agency"]').onclick = () =>
    openVaultDialog(vault.initialized ? 'unlock' : 'setup');

  const [creds, definitions] = await Promise.all([
    api('/agency/credentials'),
    api('/agency/report-definitions'),
  ]);

  node.querySelector('[data-definitions]').innerHTML = definitions
    .map(
      (d) => `
      <details class="check-section">
        <summary>
          <span>${escapeHtml(d.title)}</span>
          <span class="muted">v${d.version} · ${d.totalsMetrics} metriche · ${d.breakdowns.length} blocchi</span>
        </summary>
        <div class="check-item">
          ${d.note ? `<p class="check-detail" style="margin-left:0">${escapeHtml(d.note)}</p>` : ''}
          ${d.breakdowns
            .map(
              (b) =>
                `<p class="check-detail" style="margin-left:0">
                   <strong>${escapeHtml(b.title)}</strong> —
                   dimensioni: <code>${b.dimensions.map(escapeHtml).join(', ')}</code> ·
                   metriche: <code>${b.metrics.map(escapeHtml).join(', ')}</code>
                 </p>`,
            )
            .join('')}
        </div>
      </details>`,
    )
    .join('');

  if (!creds.unlocked) {
    lockedEl.hidden = false;
    listEl.hidden = true;
  } else {
    lockedEl.hidden = true;
    listEl.hidden = false;
    listEl.innerHTML =
      creds.items
        .map(
          (item) => `
        <div class="cred-row" data-platform="${item.platform}">
          <div class="cred-head">
            <span class="cred-label">${escapeHtml(item.label)}</span>
            <span class="cred-state ${item.hasValue ? 'set' : ''}">
              ${item.hasValue ? `impostata il ${item.updatedAt}` : 'non impostata'}
            </span>
            ${item.implemented ? '' : '<span class="tag unset">connettore non ancora attivo</span>'}
          </div>
          <p class="check-detail" style="margin-left:0">
            ${escapeHtml(item.hint)} · identificativo per cliente: <strong>${escapeHtml(item.clientFieldLabel)}</strong>
          </p>
          <div class="cred-controls">
            ${
              item.kind === 'json'
                ? `<textarea rows="4" spellcheck="false" placeholder="${escapeHtml(item.hint)}">${escapeHtml(item.value ?? '')}</textarea>`
                : `<input type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(item.value ?? '')}" placeholder="${escapeHtml(item.hint)}" />`
            }
          </div>
          <div class="cred-controls" style="margin-top:8px">
            <button class="btn" type="button" data-act="hide" ${item.hasValue ? '' : 'disabled'}>Nascondi</button>
            <button class="btn primary" type="button" data-act="save">Salva</button>
            <button class="btn danger-ghost" type="button" data-act="delete" ${item.hasValue ? '' : 'disabled'}>Elimina</button>
          </div>
        </div>`,
        )
        .join('') +
      `<div class="notice">
         Il service account va aggiunto come utente con permesso di lettura su
         <strong>ogni property GA4</strong> dei clienti: senza quel passaggio manuale
         Google risponde 403 anche con la chiave corretta.
       </div>`;

    listEl.onclick = async (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const row = button.closest('.cred-row');
      const platform = row.dataset.platform;
      const field = row.querySelector('textarea, input');
      const base = `/agency/credentials/${platform}`;

      try {
        // Valore già in chiaro: si copre solo su richiesta. Il JSON del service
        // account sta in una textarea, che non ha type: si nasconde col CSS.
        if (button.dataset.act === 'hide') {
          const coperto = field.classList.toggle('coperto');
          if (field.tagName === 'INPUT') field.type = coperto ? 'password' : 'text';
          button.textContent = coperto ? 'Mostra' : 'Nascondi';
          return;
        }

        if (button.dataset.act === 'save') {
          const result = await api(base, { method: 'PUT', body: JSON.stringify({ value: field.value.trim() }) });
          toast(
            result.details?.clientEmail
              ? `Salvato · service account ${result.details.clientEmail}`
              : field.value.trim() === ''
                ? 'Credenziale eliminata'
                : 'Credenziale salvata',
          );
        } else {
          if (!confirm(`Eliminare la credenziale d'agenzia ${platform}?`)) return;
          await api(base, { method: 'PUT', body: JSON.stringify({ value: '' }) });
          toast('Credenziale eliminata');
        }
        await renderSettings();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  view.replaceChildren(node);
}

/* ---------- accessi ad account ---------- */

function serviceOptions(selected) {
  const known = META.accountServices ?? [];
  const extra = selected && !known.some((s) => s.key === selected) ? [{ key: selected, label: selected, icon: '🔑' }] : [];
  return [...known, ...extra]
    .map((s) => `<option value="${s.key}"${s.key === selected ? ' selected' : ''}>${s.icon} ${escapeHtml(s.label)}</option>`)
    .join('');
}

function accountCard(item) {
  const isNew = !item.id;
  return `
    <div class="account-card${isNew ? ' nuovo' : ''}" data-account="${item.id ?? ''}">
      <div class="account-top">
        <label>
          Servizio
          <select data-field="service">${serviceOptions(item.service)}</select>
        </label>
        <label>
          Etichetta
          <input data-field="label" value="${escapeHtml(item.label ?? '')}" placeholder="es. @nomeprofilo, casella principale" />
        </label>
      </div>
      <div class="account-top">
        <label>
          Utente / email
          <input data-field="username" value="${escapeHtml(item.username ?? '')}" autocomplete="off" spellcheck="false" />
        </label>
        <label>
          Password
          <span class="pw-field">
            <input
              data-field="secret"
              type="text"
              autocomplete="off"
              spellcheck="false"
              value="${escapeHtml(item.secret ?? '')}"
              placeholder="${item.error ? 'non decifrabile' : 'nessuna password salvata'}"
            />
            <button class="pw-eye" type="button" data-act="hide" title="Copri la password">🙈</button>
          </span>
        </label>
      </div>
      <div class="account-top">
        <label>
          Indirizzo
          <input data-field="url" value="${escapeHtml(item.url ?? '')}" placeholder="https://…" autocomplete="off" spellcheck="false" />
        </label>
        <label>
          Note
          <input data-field="note" value="${escapeHtml(item.note ?? '')}" placeholder="es. 2FA sul telefono di Luca" />
        </label>
      </div>
      <div class="account-actions">
        <button class="btn primary" type="button" data-act="save">${isNew ? 'Crea accesso' : 'Salva'}</button>
        <button class="btn danger-ghost" type="button" data-act="delete">${isNew ? 'Annulla' : 'Elimina'}</button>
        <span class="cred-state${item.hasSecret ? ' set' : ''}">
          ${isNew ? 'nuovo' : item.hasSecret ? `password salvata · aggiornato ${item.updatedAt}` : 'senza password'}
        </span>
      </div>
    </div>`;
}

async function renderAccounts(client, panel) {
  const container = panel.querySelector('[data-accounts]');
  if (!container) return;

  const { items, unlocked } = await api(`/clients/${client.id}/accounts`);
  container.innerHTML =
    // L'elenco si legge sempre; senza chiave non si possono vedere né salvare
    // le password, e va detto prima che l'utente ci provi.
    (unlocked
      ? ''
      : '<div class="notice">Cifratura bloccata: puoi leggere e modificare i dati, ma non vedere né salvare le password.</div>') +
    (items.length
      ? items.map(accountCard).join('')
      : '<p class="muted">Nessun accesso registrato per questo cliente.</p>');

  const addBtn = panel.querySelector('[data-action="add-account"]');
  if (addBtn) {
    addBtn.onclick = () => {
      if (container.querySelector('.account-card.nuovo')) return; // uno per volta
      const empty = container.querySelector('p.muted');
      if (empty) empty.remove();
      container.insertAdjacentHTML('beforeend', accountCard({ service: 'instagram' }));
      container.querySelector('.account-card.nuovo select')?.focus();
    };
  }

  // Segna il campo password come modificato: così si distingue "lasciato stare"
  // da "svuotato di proposito", e un salvataggio non cancella la password.
  container.oninput = (event) => {
    if (event.target.dataset.field === 'secret') event.target.dataset.dirty = '1';
  };

  container.onclick = async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;

    const card = button.closest('.account-card');
    const id = card.dataset.account;
    const value = (field) => card.querySelector(`[data-field="${field}"]`).value.trim();
    const secretInput = card.querySelector('[data-field="secret"]');

    try {
      // La password è già visibile: il pulsante la copre e la riscopre, senza
      // toccarne il valore (quindi senza marcarla come modificata).
      if (button.dataset.act === 'hide') {
        const coperta = secretInput.type === 'password';
        secretInput.type = coperta ? 'text' : 'password';
        button.textContent = coperta ? '🙈' : '👁';
        button.title = coperta ? 'Copri la password' : 'Mostra la password';
        return;
      }

      if (button.dataset.act === 'delete') {
        if (!id) return card.remove(); // era un nuovo accesso non salvato
        if (!confirm(`Eliminare l'accesso ${value('service')} di ${client.name}?`)) return;
        await api(`/clients/${client.id}/accounts/${id}`, { method: 'DELETE' });
        toast('Accesso eliminato');
        return renderAccounts(client, panel);
      }

      // salvataggio
      const body = {
        service: value('service'),
        label: value('label'),
        username: value('username'),
        url: value('url'),
        note: value('note'),
      };
      // La password si invia solo se il campo è stato toccato.
      if (secretInput.dataset.dirty === '1') body.secret = secretInput.value.trim();

      if (id) {
        await api(`/clients/${client.id}/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast('Accesso salvato');
      } else {
        await api(`/clients/${client.id}/accounts`, { method: 'POST', body: JSON.stringify(body) });
        toast('Accesso creato');
      }
      await renderAccounts(client, panel);
    } catch (err) {
      toast(err.message, true);
    }
  };
}

/* ---------- vista: backup ---------- */

async function renderBackup() {
  const node = fromTemplate('tpl-backup');
  const state = await api('/backup');

  const form = node.querySelector('[data-form="backup-dir"]');
  form.dir.value = state.dir;
  node.querySelector('[data-dir-hint]').textContent = state.isDefault
    ? `Cartella predefinita. Suggerita: ${state.suggestedDir}`
    : 'Cartella scelta manualmente.';

  const warnings = [];
  if (state.insideProject) {
    warnings.push(
      'I backup sono dentro la cartella del progetto: se la perdi, spariscono con l\'originale. ' +
        'Scegli una cartella fuori dal progetto, sincronizzata su Google Drive.',
    );
  } else if (!state.cloudSynced) {
    warnings.push('La cartella non sembra sincronizzata su un cloud: il backup resta solo su questo PC.');
  }
  if (!state.dirExists) warnings.push('La cartella non esiste ancora: verrà creata al primo backup.');

  const warnEl = node.querySelector('[data-dir-warning]');
  warnEl.hidden = warnings.length === 0;
  warnEl.textContent = warnings.join(' ');

  const summary = node.querySelector('[data-backup-summary]');
  summary.textContent = state.backups.length
    ? `${state.backups.length} backup · ultimo ${state.lastAt ?? state.backups[0].modified} · ` +
      `si conservano gli ultimi ${state.keepLast}`
    : 'Nessun backup ancora. Il backup automatico scatta anche alla chiusura del server.';

  const tableEl = node.querySelector('[data-backup-table]');
  tableEl.hidden = state.backups.length === 0;
  node.querySelector('[data-backup-rows]').innerHTML = state.backups
    .map(
      (b) => `
      <tr>
        <td><span class="gtm-id">${escapeHtml(b.name)}</span></td>
        <td>${new Date(b.modified).toLocaleString('it-IT')}</td>
        <td>${(b.bytes / 1024).toFixed(1)} KB</td>
      </tr>`,
    )
    .join('');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/backup/dir', { method: 'PUT', body: JSON.stringify({ dir: form.dir.value }) });
      flashSaved(form);
      toast('Cartella di backup aggiornata');
      renderBackup();
    } catch (err) {
      toast(err.message, true);
    }
  });

  const runBtn = node.querySelector('[data-action="backup-now"]');
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    try {
      const result = await api('/backup/now', { method: 'POST' });
      toast(`Backup creato · ${(result.bytes / 1024).toFixed(1)} KB`);
      renderBackup();
    } catch (err) {
      toast(err.message, true);
      if (err.message.includes('bloccato')) {
        await refreshVault();
        openVaultDialog(vault.initialized ? 'unlock' : 'setup');
      }
    } finally {
      runBtn.disabled = false;
    }
  });

  view.replaceChildren(node);
}

async function save(id, body, form) {
  try {
    const updated = await api(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    clients = clients.map((c) => (c.id === updated.id ? updated : c));
    flashSaved(form);
    toast('Modifiche salvate');
    return updated;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

/* ---------- nuovo cliente ---------- */

function openNewDialog() {
  const form = dlgNew.querySelector('[data-form="new"]');
  const errorEl = form.querySelector('[data-error]');
  fillVocab(dlgNew);
  form.reset();
  errorEl.hidden = true;
  dlgNew.showModal();
  form.name.focus();

  form.querySelector('[data-action="cancel"]').onclick = () => dlgNew.close();

  form.onsubmit = async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    try {
      const created = await api('/clients', { method: 'POST', body: JSON.stringify(body) });
      clients = await api('/clients');
      dlgNew.close();
      toast(`${created.name} creato`);
      location.hash = `#/clients/${created.id}`;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  };
}

/* ---------- router ---------- */

async function route() {
  const hash = location.hash || '#/clients';

  for (const link of document.querySelectorAll('.topnav a')) {
    link.classList.toggle('on', hash.startsWith(link.getAttribute('href')));
  }

  try {
    if (hash === '#/backup') return await renderBackup();
    if (hash === '#/impostazioni') return await renderSettings();

    const match = hash.match(/^#\/clients\/(\d+)$/);
    if (match) return renderDetail(await api(`/clients/${match[1]}`));

    if (hash !== '#/clients') {
      location.hash = '#/clients';
      return;
    }
    renderList();
  } catch (err) {
    toast(err.message, true);
    if (hash !== '#/clients') location.hash = '#/clients';
  }
}

async function boot() {
  // Per primi i pezzi da cui dipende l'accesso: se qualcosa più avanti fallisce,
  // il login deve restare comunque utilizzabile.
  setupErrorSurface();
  setupLoginForm();

  // Il resto è accessorio: se un pezzo non trova il suo elemento (HTML servito
  // dalla cache più vecchio del JavaScript) si annota e si va avanti, invece di
  // interrompere l'avvio e lasciare una schermata inerte.
  const safely = (label, fn) => {
    try {
      fn();
    } catch (err) {
      console.error(`[boot] ${label} non inizializzato: ${err.message}`);
    }
  };
  safely('tema', setupTheme);
  safely('indicatore vault', setupVaultPill);
  safely('menu account', setupAccountMenu);

  // Prima di tutto la sessione: senza accesso non si chiama nessun'altra API.
  try {
    const me = await api('/auth/me');
    authDisabled = Boolean(me.authDisabled);
    currentUser = me.user;
  } catch (err) {
    const hasUsers = err.payload?.hasUsers ?? true;
    if (err.status !== 401) {
      view.innerHTML = `<section class="page"><p class="error">Backend non raggiungibile: ${escapeHtml(err.message)}</p></section>`;
      return;
    }
    await showLogin({ hasUsers });
  }

  await startApp();
}

/** Carica i dati e disegna la vista. Separata da boot per poter ripartire dopo
 *  un nuovo accesso, senza ricaricare la pagina. */
async function startApp() {
  paintAccount();

  try {
    [META, clients, vault, qa] = await Promise.all([
      api('/meta'),
      api('/clients'),
      api('/vault/status'),
      api('/qa'),
    ]);
  } catch (err) {
    if (err.status === 401) return; // il login è già stato riproposto da api()
    view.innerHTML = `<section class="page"><p class="error">Backend non raggiungibile: ${escapeHtml(err.message)}</p></section>`;
    return;
  }

  paintVaultPill();
  if (!routerAttached) {
    // startApp può essere richiamata dopo un nuovo accesso: un solo listener.
    window.addEventListener('hashchange', route);
    routerAttached = true;
  }
  await route();

  // Nessuna seconda password da chiedere: il vault si è aperto con quella di
  // accesso. Si avvisa solo nel caso in cui non sia stato possibile, cioè se
  // era stato creato in passato con una password diversa. Ad accesso libero non
  // c'è nessuna password da cui derivare la chiave: niente avviso.
  if (!authDisabled && (vaultSyncFailed || (vault.initialized && !vault.unlocked))) {
    toast(
      'Le credenziali cifrate non si aprono con questa password: il vault era stato creato con un\'altra. Reimpostalo dal lucchetto in alto.',
      true,
    );
  }
}

boot();
