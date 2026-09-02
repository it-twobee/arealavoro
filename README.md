# TwoBee OS

Sistema interno TwoBee: clienti, tracking, reporting e flussi email in un unico posto.
Gira **solo in locale**, nessun hosting esterno.

## Stack

| Pezzo    | Scelta                                                              |
| -------- | ------------------------------------------------------------------- |
| Backend  | Node 24 + Express 5                                                 |
| DB       | SQLite via `node:sqlite` (built-in, nessuna compilazione nativa)     |
| Frontend | HTML/CSS/JS vanilla, nessun build step, tema chiaro/scuro           |
| File DB  | `twobee.db` nella root, **non versionato**                          |

## Avvio

```bash
npm install
npm start        # per usarla
npm run dev      # per svilupparla (riparte a ogni modifica in app/)
```

**Usa `npm start`, non `npm run dev`.** `dev` osserva la cartella `app/` e riavvia
il server a ogni salvataggio, anche dei file del frontend: durante il riavvio la
pagina non carica per qualche secondo, e se una modifica è a metà si vede una
pagina bianca. `start` resta su e non si muove.

Se qualcosa non torna, <http://localhost:3000/controllo> è una pagina generata
dal server **senza JavaScript**: se si vede, server e dati sono a posto e il
problema è nel browser; se non si vede nemmeno quella, il server non è in ascolto.

Dashboard su <http://127.0.0.1:3000>. Il database si crea al primo avvio, vuoto.
Per partire con un elenco clienti già pronto, metti un `clients/seed.json` con
la stessa forma della tabella `clients`: viene caricato solo se la tabella è
vuota. Non è versionato, perché contiene nomi di clienti reali.

```bash
npm run db:reset   # cancella twobee.db e lo ricrea dal seed
```

`dev` usa `--watch-path=app` e non `--watch` per un motivo preciso: `--watch`
osserva anche `twobee.db`, quindi **ogni scrittura sul database riavviava il
server**, buttando via la chiave di cifratura tenuta in memoria e richiudendo il
vault a ogni salvataggio.

## Tema

Switch chiaro/scuro nell'header, scelta salvata in `localStorage`
(`twobee-theme`). Finché non si sceglie a mano, si segue il tema di sistema.
Lo scuro è nero pieno con titoli gialli e corpo bianco.

Il logo ufficiale sta in `app/public/img/`, in due varianti scambiate dal CSS
in base al tema (nessun JS): `logo-black.png` sul chiaro, `logo-white.png` sullo
scuro. Sono i file `logo twobee nero.png` / `logo twobee.png` ritagliati sul
contenuto — gli originali avevano margini trasparenti larghi che nell'header li
rimpicciolivano. Il giallo `#FFC501` dei token è campionato dal logo stesso.

I colori stanno tutti in variabili CSS in cima a `app/public/css/style.css`,
in due blocchi `:root[data-theme='dark']` / `[data-theme='light']`. Distinzione
utile: `--accent` per i riempimenti (bottoni, pallino brand), `--accent-text`
per il testo giallo — sul tema chiaro serve un oro più scuro, altrimenti è
illeggibile su bianco.

## Struttura

```
app/                    dashboard (backend + frontend)
  archetypes.js         vocabolario condiviso: archetipi, canali, stati, piattaforme
  db.js                 SQLite + migrazioni versionate + seed
  config.js             interruttori da ambiente (TWOBEE_AUTH)
  auth.js               accesso: utenti, password, sessioni
  doctor.js             diagnostica accesso e ambiente
  user-cli.js           gestione account da riga di comando
  vault.js              master password, derivazione chiave, cifratura
  checklist.js          caricamento template + avanzamento per cliente
  site-check.js         verifica tracking scaricando l'HTML del sito
  qa.js                 controllo giornaliero + pianificatore interno
  ga4.js                GA4 Data API: JWT RS256, token, runReport
  klaviyo.js            Klaviyo API: flussi live, metrica conversione, report
  meta.js               Meta Marketing API: insight, azioni, pixel
  reporting.js          definizioni, esecuzione, normalizzazione, CSV
  backup.js             snapshot cifrato + cartella + hook di chiusura
  routes/               clients, credentials, tracking, reporting, agency, vault, backup
  public/               frontend statico
    img/                logo nelle due varianti di tema
clients/seed.json       elenco clienti iniziale (non versionato)
reporting/
  definitions/          quali metriche/dimensioni chiedere, per archetipo
  extract/klaviyo.js    estrazione Klaviyo da riga di comando
  extract/meta.js       estrazione Meta Ads da riga di comando
  normalize/            unificazione in schema comune
  output/               report generati (non versionati)
tracking-templates/     checklist.json per archetipo
qa/daily-check.js       controllo QA da riga di comando
klaviyo-flows/          libreria flussi (contenuto, non solo codice)
backup/
  decrypt.js            ripristino di un .tbenc (autonomo, nessun import da app/)
  local/                backup generati, se non è configurata una cartella cloud
```

## Modello dati — `clients`

| Campo                                                                   | Note                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| `name`                                                                  | univoco                                           |
| `archetype`                                                             | `ecommerce` \| `leadgen-b2b` \| `hospitality` \| null |
| `cms`                                                                   | select su elenco chiuso (`CMS_SUGGESTIONS`)       |
| `website_url`                                                           | normalizzato, usato dalla verifica automatica     |
| `gtm_container_id`                                                      | validato come `GTM-XXXXXXX`                       |
| `status_gtm`, `status_ga4`, `status_meta_pixel`, `status_klaviyo`        | stato per canale                                  |
| `status_gsc`                                                            | Search Console, tenuto separato dal tracking      |
| `meta_pixel_id`                                                         | numerico, usato dal QA giornaliero                |
| `ga4_property_id`                                                       | numerico, validato; non è un segreto              |
| `lead_event`                                                            | evento del funnel B2B; vuoto = `generate_lead`    |
| `google_ads_customer_id`, `meta_ad_account_id`                          | predisposti, connettori non ancora attivi         |
| `notes`                                                                 | testo libero                                      |

Stati: `active` 🟢 · `partial` 🟡 · `todo` 🔴 · `na` ⚪ (non applicabile).

Il **badge di sintesi** nella lista è derivato, non salvato: guarda solo i canali
pertinenti all'archetipo e ignora quelli `na`. Tutti attivi → 🟢, almeno uno
avviato → 🟡, nessuno → 🔴. GSC non entra nel badge (è SEO, non tracking).

## Accesso alla dashboard

**Attualmente l'accesso è libero: nessuna password.** La dashboard ascolta solo
su `127.0.0.1` ed è a uso di una persona sola. Il codice di autenticazione resta
completo e si riaccende senza modifiche:

```bash
set TWOBEE_AUTH=on && npm run dev     # Windows
TWOBEE_AUTH=on npm run dev            # bash
```

L'account resta nel database anche a interruttore spento: riaccendendolo si
rientra con le stesse credenziali. La modalità in corso è scritta nel log
all'avvio e in `npm run doctor`.

Il resto di questa sezione descrive il funzionamento a interruttore acceso.

Login con email e password. Della password si conserva **solo l'hash scrypt**
(N=131072, salt casuale per utente); il confronto è a tempo costante.

Se l'accesso non funziona, `npm run doctor` risponde alle tre domande che si
confondono facilmente: il server è in ascolto? l'account esiste? la password è
quella giusta? La verifica della password avviene in locale sul DB, senza HTTP e
senza browser — se lì risulta corretta ma la dashboard la rifiuta, il problema è
altrove (server spento, cache del browser, autocompletamento).

```bash
npm run doctor                                 # diagnostica accesso
npm run user:list                              # elenco account
npm run user:add -- nome@twobee.it             # nuovo account
npm run user:password -- nome@twobee.it        # cambia password
npm run user:remove -- nome@twobee.it          # rimuovi account
```

La password si digita al prompt e non viene mostrata: non finisce né in un file
del progetto né nella cronologia della shell. Si può cambiare anche dalla
dashboard, dal menu in alto a destra.

Sessioni in tabella `sessions`, cookie `twobee_session` **HttpOnly** e
`SameSite=Strict`, valido 30 giorni. Del token si salva solo lo SHA-256: chi
leggesse il DB non potrebbe riutilizzarlo. `Secure` è omesso di proposito —
la dashboard gira su `http://127.0.0.1` e con `Secure` il cookie non verrebbe
mai memorizzato.

**Via di riserva senza cookie.** Alcuni browser, con impostazioni restrittive
sulla privacy o certe estensioni, non conservano il cookie nemmeno per
`localhost`: l'accesso riusciva e la richiesta successiva risultava non
autenticata, generando un anello di login infinito. Per questo il token viene
restituito anche nel corpo della risposta di login, il frontend lo tiene in
`sessionStorage` e lo invia in `Authorization: Bearer`. Il server accetta
entrambi (`tokenFromRequest`), con il cookie come meccanismo principale.

Subito dopo il login il frontend **verifica** la sessione con una chiamata a
`/api/auth/me`: se non regge, lo dice esplicitamente invece di riproporre la
schermata di accesso senza spiegazioni.

Le sessioni **sopravvivono al riavvio** del server (stanno a DB), a differenza
della chiave del vault che vive solo in memoria: sono due cose diverse, vedi
sotto. Cambiare password chiude tutte le sessioni aperte.

Tutte le rotte sotto `/api` richiedono la sessione, tranne `/api/health` e
`/api/auth/*`. Il frontend statico resta servito senza autenticazione (HTML, CSS
e JS non contengono dati): senza sessione le API rispondono 401 e compare la
schermata di accesso.

Dopo 5 tentativi falliti l'email è bloccata per 15 minuti. Il contatore è in
memoria — un riavvio del server lo azzera, ed è accettabile: serve a rendere
inutile un ciclo di prove, non a resistere a un attacco mirato.

**Una sola password** (a interruttore acceso). L'accesso sblocca anche il vault
delle credenziali: al primo accesso il vault viene creato con quella password, ai
successivi viene sbloccato. Non c'è una seconda finestra da compilare.

Ad accesso libero non esiste una password da cui derivare la chiave: la cifratura
delle chiavi API va attivata a parte, dal tab Credenziali, e serve solo a quello.

Cambiare la password di accesso **ricifra** le credenziali salvate: si decifrano
con la chiave vecchia e si ricifrano con la nuova, in transazione. Senza questo
passaggio un cambio password renderebbe illeggibile tutto quello che c'è nel
vault, perché la chiave deriva dalla password.

Se il vault fosse stato creato in passato con una password diversa, l'accesso
riesce comunque ma le credenziali restano bloccate: la dashboard lo dice e si
reimposta dal lucchetto in alto (cancellando le credenziali, che vanno reinserite
dalle piattaforme).

Ogni tentativo di accesso lascia una riga nel log del server, utile quando
"non fa entrare":

```
[auth] OK (vault: unlocked) · email="..." · lunghezza=8 · impronta=115765fa
```

Non contiene la password: solo la sua lunghezza e i primi 8 caratteri dello
SHA-256. Basta a capire se il browser sta inviando una stringa diversa da quella
attesa — uno spazio incollato, il Caps Lock, un autocompletamento — senza
scrivere il segreto nei log.

## Visibilità dei segreti

I valori (chiavi API, password degli accessi, service account) sono **visibili in
chiaro** nell'interfaccia, senza dover cliccare per rivelarli: l'area di lavoro è
locale e monoutente, quindi mascherarli aggiungeva solo un clic.

La distinzione che conta: **cambia solo la visualizzazione**. A riposo nel
database restano cifrati AES-256-GCM esattamente come prima — verificato che nei
blob non compaia nulla di leggibile.

Ogni campo ha un pulsante **Nascondi** che lo copre al volo, per quando si
condivide lo schermo. Il JSON del service account sta in una textarea, che non
ha `type="password"`: si copre sfocandolo via CSS.

Un valore che non si riesce a decifrare (per esempio dopo un reset della chiave)
**non fa fallire l'intero elenco**: si segnala solo quella voce, con il motivo.

Effetto collaterale positivo: prima, nella scheda Chiavi, un clic su *Salva* con
il campo vuoto **cancellava** la chiave. Ora il campo è precompilato con il
valore reale, quindi salvare senza modifiche lo lascia identico.

## Vault e credenziali

La chiave di cifratura deriva dalla **password di accesso** (vedi sopra: sono la
stessa cosa) con **scrypt** (N=131072, r=8, p=1, salt casuale di 16 byte); le
credenziali sono cifrate in **AES-256-GCM**, IV nuovo per ogni scrittura.

Cosa finisce su disco e cosa no:

| Dato                          | Dove sta                                  |
| ----------------------------- | ----------------------------------------- |
| Master password               | **da nessuna parte**                      |
| Chiave derivata               | solo in RAM, variabile di processo         |
| Salt e parametri KDF          | `app_settings` (non segreti)               |
| Verificatore della password   | `app_settings`, cifrato                    |
| Chiavi API                    | `credentials.blob`, cifrate                |

Il verificatore è un testo noto cifrato allo setup: se si decifra, la password è
giusta. L'authTag GCM fa da controllo, quindi non serve confrontare hash a mano.

Riavviando il server il vault torna **bloccato**: è il prezzo di non scrivere mai
la chiave su disco. In pratica non si nota, perché il primo accesso successivo lo
risblocca. La lista clienti resta consultabile da bloccato; le credenziali no
(HTTP 423).

**Reset** (nessuna recovery key, per scelta): imposta una nuova password e
cancella le credenziali esistenti, che sarebbero comunque indecifrabili con la
chiave nuova. Le chiavi API si rigenerano dalle piattaforme originali.

## Le cinque schede di un cliente

| # | Scheda          | Cosa contiene                                                        |
| - | --------------- | -------------------------------------------------------------------- |
| 1 | **Chiavi**      | chiavi e token API per piattaforma (GA4, Google Ads, Meta, Klaviyo)   |
| 2 | **Tracking**    | archetipo, stato canali, checklist di setup, verifica automatica      |
| 3 | **Report**      | Property ID GA4, generazione report, storico, CSV                    |
| 4 | **Credenziali** | accessi ad account: utente + password di social, posta, dominio…     |
| 5 | **Note**        | testo libero                                                         |

All'apertura di una scheda cliente si posiziona su **Tracking**, che è la vista
più usata. Le schede dinamiche si ridisegnano ogni volta che le si apre, perché
stato della cifratura, checklist e report possono essere cambiati nel frattempo.

La distinzione fra le due schede di segreti è voluta: in **Chiavi** c'è un solo
valore per servizio e serve alle integrazioni; in **Credenziali** serve la coppia
utente + password di un account umano, e ce ne possono essere molti per servizio.

Attenzione a cosa va in **Chiavi** per Meta: il token di accesso è **uno solo per
tutta l'agenzia** e sta in Impostazioni; qui va l'**Ad Account ID** del singolo
cliente (`act_…`). Vale lo stesso per Google Ads: token e credenziali OAuth a
livello agenzia, Customer ID per cliente.

## Credenziali: accessi ad account

Utente e password dei profili del cliente — Instagram, Facebook, Gmail, webmail,
dominio/registrar, hosting, CMS, Shopify e altri.

Sono una cosa diversa dalle chiavi (`credentials`), perché serve la coppia
utente + password più indirizzo e note; stanno in `client_accounts` e un cliente
può averne quanti vuole per lo stesso servizio (due profili Instagram, tre
caselle di posta).

| Campo      | Cifrato | Perché                                                     |
| ---------- | ------- | ---------------------------------------------------------- |
| `secret`   | **sì**  | è la password                                              |
| `service`, `label`, `username`, `url`, `note` | no | servono a leggere e cercare l'elenco senza aprire il vault |

L'elenco dei servizi in `ACCOUNT_SERVICES` è solo un comodo menu: il campo
accetta qualsiasi testo, quindi si aggiunge un servizio nuovo senza toccare il
codice (per averlo nel menu con la sua icona, basta una riga in quell'elenco).

Dettaglio di comportamento che conta: il campo password viene inviato **solo se
lo si modifica**. Correggere una nota o un indirizzo non tocca la password
salvata; svuotare il campo di proposito la cancella. L'occhio la mostra
recuperandola dal server, e richiudendolo il valore viene rimosso dalla pagina.

### Cifratura senza password, ad accesso libero

Con l'accesso libero non esiste una password da cui derivare la chiave, ma queste
sono password di account reali e il database vive dentro OneDrive — quindi una
copia finisce nel cloud. La chiave viene perciò generata in un file **fuori dalla
cartella sincronizzata**:

```
%LOCALAPPDATA%\TwoBeeOS\vault.key
```

Il vault si apre da sé all'avvio, senza chiedere niente. Cosa protegge e cosa no,
detto chiaramente:

- **protegge** se il `.db` sfugge da OneDrive (condivisione, account compromesso):
  senza il file della chiave è indecifrabile;
- **non protegge** da chi usa questo PC, perché la chiave è leggibile da qui. Per
  quello serve una password: `set TWOBEE_AUTH=on` e la chiave torna a derivare
  dalla password di accesso.

Quel file è l'unica copia della chiave: se si perde, le credenziali salvate non
sono più recuperabili. Va incluso in un backup a parte, e serve anche per
ripristinare un `.tbenc` (`npm run backup:decrypt` chiede una password: incolla
il contenuto di `vault.key`).

## Reporting Klaviyo

Performance dei **flussi attivi**, nella stessa vista Report della scheda cliente,
distinta dalla fonte GA4.

Differenza che determina tutto il resto: **la chiave Klaviyo è per cliente**, non
d'agenzia — ogni cliente ha il suo account. Sta quindi nella scheda **Chiavi** del
cliente (voce `klaviyo`, che esisteva già), cifrata come le altre.

Cosa estrae, per il periodo di 30 giorni con confronto sui 30 precedenti:

| Metrica          | Da Klaviyo          |
| ---------------- | ------------------- |
| flussi attivi    | conteggio dei flussi `live` |
| destinatari      | `recipients`        |
| aperture e tasso | `opens`, `open_rate` |
| click e tasso    | `clicks`, `click_rate` |
| ricavi           | `conversion_value`  |

Più il dettaglio **per singolo flusso** (welcome, carrello abbandonato,
post-acquisto, win-back…). Nessun dettaglio per singola email dentro il flusso:
è l'estensione futura indicata nella spec.

Klaviyo richiede una **metrica di conversione** per calcolare i ricavi: si cerca
`Placed Order`, poi `Ordered Product`, altrimenti la prima disponibile. Quale sia
stata usata è scritto sopra il report, perché cambia il significato del numero.

I **tassi complessivi** si ricalcolano sui totali, non facendo la media dei tassi
dei singoli flussi: quella darebbe lo stesso peso a un flusso da 10 invii e a uno
da 10.000.

Klaviyo versiona l'API con l'header `revision` (una data). Se una risposta cambia
forma si aggiorna `TWOBEE_KLAVIYO_REVISION` invece di inseguire modifiche
silenziose; l'errore lo dice esplicitamente.

Dal pulsante **Estrai dati Klaviyo** nella scheda Report, oppure:

```bash
npm run extract:klaviyo                    # tutti i clienti con una chiave
npm run extract:klaviyo -- "Nome cliente"  # un cliente solo
```

I risultati finiscono in `report_runs` / `report_rows` con `source = 'klaviyo'`,
lo stesso schema di GA4: storico, apertura e CSV funzionano identici, e la fonte
è etichettata in entrambe le viste.

## Reporting Meta Ads

Credenziali su due livelli, come GA4: **token System User** a livello agenzia
(Impostazioni) e **Ad Account ID** del singolo cliente (scheda Chiavi). Il token
viaggia nell'header `Authorization`, non nella query string, così non finisce nei
log intermedi.

Estrae per gli ultimi 30 giorni, con confronto sui 30 precedenti: spesa,
impression, click, CTR, conversioni e costo per conversione, più il dettaglio di
**tutte** le azioni registrate sull'account.

### Cosa conta come conversione

Il punto delicato. Meta restituisce in un unico elenco click, visualizzazioni,
interazioni e conversioni, **e riporta lo stesso evento su più livelli di
aggregazione**: `offsite_conversion.fb_pixel_lead` e `lead` sono la stessa cosa.
Sommare tutto porta a numeri assurdi — in collaudo il conteggio ingenuo dava
2074 conversioni a 0,60 € l'una, contro le 87 reali a 14,38 €.

Quindi: si contano solo gli eventi che sono davvero conversioni (`lead`,
`purchase`, `complete_registration`, `subscribe`, `start_trial`, `contact`,
`schedule`, `submit_application`, `donate`) e, per ciascuno, **una sola voce**,
preferendo la più specifica. Gli action_type effettivamente conteggiati sono
scritti nel report: il numero deve restare ispezionabile.

Controprova: il costo per conversione calcolato coincide con il
`cost_per_action_type` che Meta riporta per lo stesso evento.

### Il pixel nel controllo giornaliero

Quando il connettore è configurato, il controllo "Meta Pixel" smette di leggere
l'HTML e interroga `/act_<id>/adspixels`, guardando `last_fired_time`: dice se il
pixel **riceve dati**, non se il codice compare nel sorgente. Risolve il falso
negativo dei pixel dentro GTM.

| Situazione                                   | Esito |
| -------------------------------------------- | ----- |
| Pixel con eventi nelle ultime 48h            | 🟢 con data e nome del pixel |
| Pixel senza eventi recenti                   | 🔴 con la data dell'ultimo evento |
| Nessun pixel sull'ad account                 | 🔴 |
| Errore API (token scaduto, permessi)         | 🔴 con il messaggio di Meta |
| Connettore non configurato                   | si torna alla lettura dell'HTML (🟡 se c'è GTM) |

Dal pulsante **Estrai dati Meta** nella scheda Report, oppure:

```bash
npm run extract:meta                 # tutti i clienti con un Ad Account ID
npm run extract:meta -- "Nome cliente"     # un cliente solo
```

## QA giornaliero

Tre controlli per cliente, una volta al giorno, senza notifiche: il risultato si
vede aprendo la dashboard.

| Controllo         | Come funziona                                                        | Serve                    |
| ----------------- | -------------------------------------------------------------------- | ------------------------ |
| GTM sul sito      | scarica la homepage e cerca il container configurato                 | URL sito + ID container  |
| Dati GA4 recenti  | interroga la Data API su `2daysAgo → today`: sessioni o eventi > 0    | Property ID + service account |
| Meta Pixel        | cerca il Pixel ID nell'HTML della stessa pagina                       | URL sito + Pixel ID      |

Riusa i moduli esistenti invece di duplicarli: `site-check.js` per il fetch e il
riconoscimento dei tag, `ga4.js` per la connessione. **Una sola richiesta HTTP per
cliente** serve sia al controllo GTM sia a quello del Pixel, e il service account
viene preparato una volta per tutta la tornata.

Il **Pixel ID** è un campo nuovo, accanto all'ID container GTM nella scheda
Tracking: non è un segreto (sta nell'HTML di ogni pagina), quindi non ha senso
cifrarlo insieme ai token. È validato come sole cifre, perché un valore sbagliato
farebbe fallire il controllo ogni giorno.

### Stati

| Stato           | | Significato                                                     |
| --------------- |-| --------------------------------------------------------------- |
| `ok`            | 🟢 | verificato                                                    |
| `indeterminato` | 🟡 | controllato, ma il segnale non conclude (vedi sotto)           |
| `problema`      | 🔴 | assenza reale o errore                                        |
| `na`            | ⚪ | manca il dato per controllare: niente URL, Property ID o Pixel ID |

Le distinzioni contano tutte. Un cliente su cui **nessun** controllo è stato
possibile non è verde, perché sarebbe un "tutto a posto" mai verificato: verde
solo se almeno un controllo è passato davvero e nessuno è fallito. E
`indeterminato` non conta come problema, quindi non fa scattare l'avviso rosso
in cima alla lista.

### Il limite dell'HTML quando c'è GTM

Il controllo del **Meta Pixel** legge il sorgente della pagina, ma se il Pixel è
configurato dentro GTM viene iniettato a runtime e non compare mai nell'HTML: un
"non trovato" sarebbe un falso negativo permanente. Quindi:

- Pixel trovato nell'HTML → 🟢
- Un Pixel **diverso** da quello in scheda → 🔴, perché è un dato concreto
- Nessun Pixel ma il sito carica GTM → 🟡 *non deducibile*
- Nessun Pixel e **nessun GTM** → 🔴, perché lì l'HTML è l'unica fonte e l'assenza vale

Si guarda la presenza di *un qualsiasi* container, non solo quello configurato:
anche un GTM diverso da quello atteso è comunque in grado di caricare il Pixel.

La prova certa richiederà la **Meta Marketing API** (system user token), che
arriverà col connettore Meta. Fino ad allora il giallo dice onestamente "non lo
so", invece di un rosso che sarebbe sbagliato.

### Quando gira

Pianificatore interno, nessun cron di sistema da configurare: ogni giorno alle
07:00 (`TWOBEE_QA_HOUR` per cambiare ora). Il server si riavvia spesso, quindi
all'avvio **recupera** l'esecuzione del giorno se non è ancora stata fatta,
invece di aspettare l'ora esatta.

**Il blocco nella scheda mostra l'ultimo esito, non una verifica dal vivo.** Dopo
aver cambiato Property ID, container o Pixel serve rilanciarlo, altrimenti resta
fermo al risultato precedente — è il motivo per cui un controllo poteva sembrare
rotto quando invece era solo vecchio. Da qui il pulsante **Ricontrolla** nel
blocco stesso, che rifà i tre controlli su quel solo cliente.

Da non confondere con **Verifica ora** nella stessa scheda: quello cerca i tag
nell'HTML del sito (modulo 3), non interroga GA4 e non aggiorna il QA.

Quando un controllo **passa**, il canale corrispondente nella scheda viene
promosso ad "attivo": dati reali sono la prova più forte che il canale funziona,
più affidabile della ricerca del tag nell'HTML. Solo promozione, mai
declassamento, come nel modulo 3.

Ogni controllo fallito lascia il motivo esatto anche nel log del server
(`[qa] <cliente> · <controllo>: <dettaglio>`), e gli errori di Google vengono
riportati interi invece che riassunti.

A mano: pulsante **Controlla ora** in cima alla lista clienti, **Ricontrolla**
nella scheda del singolo cliente, oppure

```bash
npm run qa
```

che stampa l'esito cliente per cliente. Utile anche per pianificarlo con
l'Utilità di pianificazione di Windows, se si preferisce non tenere il server acceso.

### Dove si vede

- **Lista clienti**: colonna `QA` con lo stesso stile dei badge di tracking, più
  una barra in cima che compare solo se ci sono problemi, con il dettaglio e il
  collegamento diretto al cliente;
- **Scheda cliente**: blocco in cima al tab Tracking con i tre controlli, il loro
  esito e la descrizione del problema.

## Backup

`Backup ora` nella vista Backup, oppure automatico alla chiusura del server.

Lo snapshot usa `db.serialize()` invece di copiare il file: una copia grezza
perderebbe le scritture ancora nel WAL. Il risultato è cifrato con la stessa
chiave delle credenziali e salvato come `twobee-AAAAMMGG-HHMMSS.tbenc`.

Il file è autodescrittivo — header `TBBK`, versione, parametri scrypt e salt in
chiaro, poi `iv | authTag | ciphertext` — quindi si ripristina anche se il DB
originale non esiste più:

```bash
npm run backup:decrypt -- "percorso\del\backup.tbenc"
```

Lo script è volutamente autonomo (non importa nulla da `app/`): deve funzionare
anche quando l'applicazione è rotta. Chiede la password, riscrive un `.db` e lo
riapre per confermare che sia valido. Password errata e file manomesso danno lo
stesso errore e **non** producono un file spazzatura.

Si conservano gli ultimi 30 backup. La cartella è configurabile: di default si
cerca Google Drive for Desktop, altrimenti si ricade su `backup/local/` e la UI
avverte che i backup sono dentro il progetto (quindi non sono un vero backup).

Limiti del backup automatico alla chiusura, non aggirabili:

- se il vault è bloccato non c'è chiave da usare, quindi si salta;
- su Windows solo **Ctrl+C** nel terminale genera un vero SIGINT; un kill forzato
  da Task Manager non lascia eseguire nulla;
- in modalità `--watch` è disattivato, per non creare un backup a ogni salvataggio.

## Tracking: checklist e verifica automatica

### Checklist per archetipo

Le voci stanno nei file `tracking-templates/<archetipo>/checklist.json`, non a
DB: si modificano con un editor, restano versionabili e non serve una migrazione
per aggiungere un controllo. La cache si invalida sull'mtime, quindi basta
salvare il file — nessun riavvio. A DB va solo l'avanzamento per cliente
(`checklist_state`: fatto/non fatto + nota).

Contenuto attuale: e-commerce 27 voci, lead gen B2B 25, hospitality 22, divise
per sezioni (configurazione, variabili, eventi, canali, collaudo).

Gli **id delle voci sono chiavi a DB**: rinominarne uno fa perdere l'avanzamento
di quella voce. Aggiungerne di nuovi è sempre sicuro. All'avvio i template
vengono caricati e validati (id duplicati compresi): un JSON rotto si scopre nel
log del server, non aprendo la scheda di un cliente.

### Verifica automatica

`Verifica ora` nel tab Tracking scarica la homepage del cliente (serve solo
l'URL, nessuna credenziale) e cerca gli snippet nel sorgente.

Cosa si può concludere, e perché la politica di aggiornamento è asimmetrica:

| Canale      | Rilevabile nell'HTML                    | Effetto sullo stato                    |
| ----------- | --------------------------------------- | -------------------------------------- |
| GTM         | sì, lo snippet è sempre nella pagina    | aggiornato in **entrambe** le direzioni |
| GA4         | solo se gtag è caricato direttamente    | solo promozione ad "attivo"             |
| Meta Pixel  | solo se il pixel non passa da GTM       | solo promozione ad "attivo"             |
| Klaviyo     | solo se lo script è nel sorgente        | solo promozione ad "attivo"             |

Un GA4 configurato **dentro** GTM non compare nell'HTML: declassarlo sarebbe un
falso negativo. I canali marcati "non applicabile" non vengono mai toccati, e se
la pagina non si scarica non si modifica nulla.

### Quando il sito carica GTM, l'HTML non è più una prova

Se sul sito c'è GTM, gli altri tag possono essere iniettati a runtime: cercarli
nel sorgente dà un "non trovato" che non significa nulla, e per un GA4 dentro GTM
è un **falso negativo permanente**. La verifica quindi cambia lettura:

| Situazione                        | Cosa mostra per GA4                                    |
| --------------------------------- | ------------------------------------------------------ |
| GA4 visibile nell'HTML            | 🟢 trovato, con il Measurement ID                       |
| GTM presente, QA con dati         | 🟢 *via GTM* + sessioni ed eventi dalla Data API        |
| GTM presente, QA senza dati       | 🔴 con il motivo restituito da GA4                      |
| GTM presente, QA mai eseguito     | 🟡 non deducibile: lancia il controllo giornaliero      |
| **Nessun GTM** sul sito           | come prima: l'HTML è l'unica fonte, l'assenza vale      |

In breve: con GTM presente il verdetto su GA4 arriva dai **dati reali** della
Data API, non dal sorgente della pagina; senza GTM resta il controllo statico,
perché è l'unico segnale disponibile.

Dettagli di implementazione che sono costati un giro di correzioni:

- il match dei container è **case-sensitive**: `/GTM-[A-Z0-9]+/i` catturava
  `gtm-script` e `gtm-noscript` dagli attributi HTML e li spacciava per container;
- il tetto di lettura è 4 MB: a 1,5 MB una homepage e-commerce reale veniva
  troncata (misurate 1,7 MB su un caso vero) e i tag in fondo al body sparivano;
- Klaviyo si riconosce solo da script eseguibili (`klaviyo.js`, `_learnq`,
  `*.klaviyo.com`): cercare la parola "klaviyo" prendeva anche i "powered by";
- gli indirizzi interni (localhost, IP privati) sono rifiutati: il server fa una
  richiesta verso un URL scelto dall'utente e non deve poter sondare la rete locale.

Ogni esecuzione finisce in `tracking_checks`, così si distingue "mai
controllato" da "controllato e non trovato".

## Reporting (GA4)

Connessione via API reale, senza flusso OAuth interattivo: un **service account**
a livello agenzia più il **Property ID** di ogni cliente.

Le credenziali stanno su due livelli, e la distinzione è voluta:

| Livello  | Cosa                                          | Dove                                   |
| -------- | --------------------------------------------- | -------------------------------------- |
| Agenzia  | service account GA4 (JSON completo)           | `agency_credentials`, cifrato          |
| Cliente  | Property ID GA4                                | colonna `clients.ga4_property_id`, in chiaro |

Il Property ID non è un segreto, quindi non viene cifrato. Il service account sì,
con la stessa chiave di sessione delle credenziali per cliente: generare report
richiede il vault sbloccato.

**Passaggio manuale inevitabile**: il service account va aggiunto come utente con
permesso di lettura su *ogni* property GA4. Senza quel passaggio Google risponde
403 anche con la chiave corretta — l'errore in dashboard lo dice esplicitamente.

Nessuna libreria Google: il flusso è un JWT firmato RS256 con `node:crypto` e
scambiato per un access token, che viene tenuto in cache finché non scade.

### Definizioni report

`reporting/definitions/<archetipo>.json`, uno per e-commerce / leadgen / hospitality.
Metriche e dimensioni si scrivono con i **nomi della GA4 Data API**, gli stessi che
si scelgono in Esplora. Modificare il file basta: la cache si invalida sull'mtime.

Attenzione: le esplorazioni salvate in GA4 **non sono leggibili via API**. La Data
API esegue query che le si passano; non esiste un modo per aprire un'esplorazione
costruita nell'interfaccia. Questi file servono a replicarne la definizione.

Il pulsante **Metriche disponibili** nel tab Report interroga la property e elenca
metriche e dimensioni realmente disponibili, comprese quelle personalizzate: è il
modo più rapido per trovare il nome esatto da scrivere nella definizione.

La validazione locale intercetta gli errori prima di chiamare Google (breakdown
senza dimensioni, id duplicati, `orderBy` su una metrica non richiesta — che GA4
rifiuterebbe con un errore poco chiaro).

### Lead gen B2B: quattro sezioni dedicate

L'archetipo `leadgen-b2b` ha una definizione propria (v2). Gli altri due
archetipi restano sulle metriche generiche.

| # | Sezione | Come è costruita |
| - | ------- | ---------------- |
| 1 | Funnel di conversione | **due query**: utenti attivi per canale, e utenti attivi filtrati sull'evento di lead. Completamento, abbandoni e tasso li calcola TwoBee |
| 2 | Traffico per sorgente | canale + sorgente/mezzo + campagna, top 10 per sessioni |
| 3 | Eventi personalizzati | per `eventName`, più una sezione per ogni parametro custom configurato |
| 4 | Pagine più visitate | `unifiedPagePathScreen`, top 10 per visualizzazioni |

**Il funnel è calcolato, non nativo**: la Data API v1beta non espone un endpoint
funnel (esiste solo in alpha), quindi si eseguono due query — la seconda filtrata
sull'evento di lead — e si derivano le colonne. Il risultato è lo stesso, e resta
sulla versione stabile dell'API.

**L'evento di lead è per cliente**: campo nella scheda Report, vuoto significa
`generate_lead`. Serve ai clienti che in GTM l'hanno chiamato diversamente; il
nome usato è scritto in testa al report, così non si legge un funnel a zero
chiedendosi perché.

**I parametri custom degradano da soli.** Dimensioni come
`customEvent:piano_selezionato` esistono solo se registrate come dimensioni
personalizzate su quella property: se mancano, GA4 risponde con un errore che
farebbe fallire l'intero report. Quelle sezioni sono quindi eseguite a parte e,
se falliscono, vengono **saltate con il motivo scritto in chiaro** sopra il
report, senza compromettere le altre. È il caso previsto dalla spec: un cliente
B2B con GTM diverso da quello di TwoBee vedrà quelle sezioni vuote, non un errore.

Le colonne calcolate (funnel, Klaviyo) hanno nomi italiani in `snake_case` e
compaiono in chiaro nelle intestazioni; i nomi nativi GA4 restano intatti, perché
sono quelli che si ritrovano in Esplora.

### Periodo e schema

Ultimi 30 giorni con confronto sui 30 precedenti e variazione percentuale. La
finestra **chiude ieri**: includere il giorno in corso, incompleto in GA4, farebbe
sembrare ogni report in calo.

I risultati vanno in uno schema comune (`report_rows`: dimensioni e metriche come
JSON, più periodo e blocco), così Google Ads e Meta si innestano senza toccare lo
schema. La definizione usata viene **congelata dentro il run**: i file sono
modificabili, e un report di due mesi fa deve restare leggibile con le colonne e i
titoli che aveva allora.

Output solo in dashboard, come da spec, più un download **CSV dei dati grezzi**
per uso interno (un foglio unico, separatore `;`, BOM per gli accenti in Excel).
Nessun documento impaginato per i clienti in questa fase.

Si conservano gli ultimi 30 run per cliente. Anche i run **falliti** finiscono in
storico con il loro errore: serve a distinguere "non l'ho mai generato" da "ho
provato e GA4 ha risposto male".

Google Ads e Meta sono dichiarati in `AGENCY_CREDENTIALS` con
`implemented: false`: compaiono in Impostazioni segnati come non attivi, invece di
fingere di funzionare.

## API

| Metodo   | Rotta                | Cosa fa                                        |
| -------- | -------------------- | ---------------------------------------------- |
| `GET`    | `/api/health`        | ping + percorso DB                             |
| `GET`    | `/api/meta`          | archetipi, canali, stati, suggerimenti CMS     |
| `GET`    | `/api/clients`       | lista con `tracking_badge` derivato            |
| `POST`   | `/api/clients`       | crea (precompila i canali `na` per archetipo)  |
| `GET`    | `/api/clients/:id`   | dettaglio                                      |
| `PATCH`  | `/api/clients/:id`   | aggiorna i soli campi inviati                  |
| `DELETE` | `/api/clients/:id`   | elimina (con le credenziali, in cascata)       |

Vault e credenziali:

| Metodo   | Rotta                                              | Cosa fa                              |
| -------- | -------------------------------------------------- | ------------------------------------ |
| `GET`    | `/api/auth/me`                                     | utente della sessione (401 se assente) |
| `POST`   | `/api/auth/login`                                  | 401 su credenziali errate, 429 se bloccato |
| `POST`   | `/api/auth/logout`                                 | revoca la sessione                    |
| `POST`   | `/api/auth/password`                               | cambia password, chiude le sessioni   |
| `GET`    | `/api/vault/status`                                | `initialized` / `unlocked`            |
| `POST`   | `/api/vault/setup`                                 | primo avvio (409 se già fatto)        |
| `POST`   | `/api/vault/unlock`                                | 401 se password errata                |
| `POST`   | `/api/vault/lock`                                  | scarta la chiave dalla memoria        |
| `POST`   | `/api/vault/reset`                                 | nuova password, cancella le credenziali |
| `GET`    | `/api/clients/:id/accounts`                         | accessi del cliente, password comprese  |
| `POST`   | `/api/clients/:id/accounts`                         | nuovo accesso                         |
| `PATCH`  | `/api/clients/:id/accounts/:accountId`              | aggiorna; `secret` assente = non tocca la password |
| `GET`    | `/api/clients/:id/accounts/:accountId/reveal`        | password in chiaro (423 se bloccato)  |
| `DELETE` | `/api/clients/:id/accounts/:accountId`              | elimina                               |
| `GET`    | `/api/clients/:id/credentials`                      | stato e valori in chiaro (se sbloccato) |
| `GET`    | `/api/clients/:id/credentials/:platform/reveal`     | valore in chiaro (423 se bloccato)    |
| `PUT`    | `/api/clients/:id/credentials/:platform`            | cifra e salva; valore vuoto = elimina |
| `DELETE` | `/api/clients/:id/credentials/:platform`            | elimina                               |
| `GET`    | `/api/backup`                                       | cartella, avvisi, elenco backup       |
| `POST`   | `/api/backup/now`                                   | backup immediato (423 se bloccato)    |
| `PUT`    | `/api/backup/dir`                                   | cambia cartella di destinazione       |

Tracking:

| Metodo | Rotta                                              | Cosa fa                                   |
| ------ | -------------------------------------------------- | ----------------------------------------- |
| `GET`  | `/api/clients/:id/tracking/checklist`               | template + avanzamento + progresso        |
| `PUT`  | `/api/clients/:id/tracking/checklist/:itemId`       | spunta e/o nota di una voce               |
| `POST` | `/api/clients/:id/tracking/check`                   | verifica il sito e aggiorna gli stati     |
| `GET`  | `/api/clients/:id/tracking/checks`                  | ultime 10 verifiche                       |

Reporting:

| Metodo | Rotta                                      | Cosa fa                                    |
| ------ | ------------------------------------------ | ------------------------------------------ |
| `GET`  | `/api/clients/:id/reports`                 | stato, blocchi, periodo, storico           |
| `POST` | `/api/clients/:id/reports`                 | genera il report GA4                       |
| `POST` | `/api/clients/:id/reports/klaviyo`         | estrae le performance dei flussi Klaviyo   |
| `POST` | `/api/clients/:id/reports/meta`            | estrae le performance Meta Ads             |
| `POST` | `/api/qa/clients/:id/run`                  | ricontrolla un solo cliente                |
| `GET`  | `/api/clients/:id/reports/metadata`        | metriche/dimensioni della property         |
| `GET`  | `/api/clients/:id/reports/:runId`          | report completo                            |
| `GET`  | `/api/clients/:id/reports/:runId/csv`      | dati grezzi in CSV                         |
| `GET`  | `/api/agency/credentials`                  | stato credenziali agenzia                  |
| `PUT`  | `/api/agency/credentials/:platform`        | salva (valida il JSON del service account) |
| `GET`  | `/api/agency/credentials/:platform/reveal` | valore in chiaro (423 se bloccato)         |
| `GET`  | `/api/agency/report-definitions`           | riepilogo definizioni                      |

## Roadmap moduli

1. ✅ Scheletro dashboard + DB + CRUD clienti
2. ✅ Tab Credenziali con cifratura + backup integrato (manuale e alla chiusura)
3. ✅ Tab Tracking: checklist per archetipo + verifica automatica GTM
4. 🟡 Reporting: GA4 Data API fatto · Google Ads e Meta da aggiungere
5. ✅ QA check giornaliero: GTM, dati GA4, Meta Pixel
6. ✅ Metriche performance Klaviyo (flussi attivi)
7. ⬜ Libreria flussi Klaviyo (contenuto)
