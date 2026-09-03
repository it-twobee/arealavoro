# TwoBee OS — laboratorio del modulo Tracking

Questo repo è il **laboratorio** del modulo Tracking di TwoBee OS, il CRM di
produzione (Next.js + Supabase). Qui si sperimenta e si sviluppa in locale, con
SQLite e una UI vanilla; il CRM è il posto dove il lavoro finisce. Leggi prima
`README.md`: è la specifica funzionale ed è la fonte per le descrizioni della UI.

## Due strati, una regola

```
lib/tracking/*.ts     NUCLEO CONDIVISO — logica pura, identica byte per byte al CRM
app/**/*.js           HOST — SQLite, rotte Express, UI vanilla, CLI
```

**La logica nuova va in `lib/tracking/*.ts` come modulo puro** (niente DB,
niente rete di Supabase, niente segreti veri) **con un `*.check.ts` accanto**;
il file JS in `app/` la importa e la collega a SQLite e alla UI.

Il file JS è un adattatore: legge dal DB, chiama la funzione TS, scrive il
risultato. Se ti trovi a scrivere un `if` di dominio in `app/`, è nel posto
sbagliato: spostalo nel modulo TS e coprilo con un check.

## Cosa deve restare vero in `lib/tracking/`

- Copiabile 1:1 nel CRM: **nessun import fuori da `@/lib/tracking/*` e
  `@/lib/types/database`**. Niente `node:sqlite`, niente Express, niente
  percorsi di questo repo. `node:crypto` e `fetch` globale vanno bene.
- I JSON stanno in `lib/tracking/templates` (checklist) e
  `lib/tracking/definitions` (report) e si importano staticamente dai `.ts`
  (nel CRM la build è `standalone`: niente letture da disco a runtime).
- **Gli id delle voci di checklist e dei blocchi report sono chiavi a DB**:
  rinominarne uno fa perdere l'avanzamento salvato. Aggiungere è sempre sicuro.
- Gli errori si lanciano con `TrackingError(status, message)` da `errors.ts`:
  `app/http-error.js` lo riesporta come `HttpError` e il middleware di
  `server.js` legge `err.status`.
- Ogni modulo ha il suo `nome.check.ts`: uno script senza framework che stampa
  `OK`/`NO` per riga e termina con `process.exit(fail ? 1 : 0)`. Segui quella
  forma, non introdurre un test runner.
- `lib/types/database.ts` contiene solo il blocco `§316 Tracking` del CRM: se
  serve un tipo nuovo, aggiungilo lì con lo stesso stile, sarà copiato nel CRM.

## Come si lavora

```bash
npm start            # server (tsx: i .js importano i .ts senza build)
npm run dev          # riavvio automatico, ignora twobee.db* e backup/
npm run check        # tutti i lib/tracking/*.check.ts, in sequenza
npm run typecheck    # tsc --noEmit su lib/**/*.ts
```

Prima di dire "fatto": `npm run typecheck` pulito, `npm run check` tutto OK,
server avviato e la scheda toccata dalla modifica provata nel browser.

Il runtime è `tsx`, quindi i file `.js` in `app/` importano direttamente i
`.ts` (`import { x } from '../lib/tracking/x.ts'`). I `.ts` fra loro usano
`./x` o `@/lib/tracking/x` (alias in `tsconfig.json`). **Non convertire i
file JS dell'host in TypeScript**: restano JS di proposito.

## Come avviene l'integrazione nel CRM

1. Chi manutiene il CRM copia `lib/tracking/` (compresi i JSON) sopra la
   propria copia: i file devono essere identici, senza adattamenti.
2. Legge `README.md` e questo file per capire cosa è cambiato nella UI.
3. **La UI viene ricostruita sui componenti del CRM**, non copiata: per questo
   nel README la UI si descrive **a parole** (cosa mostra, quando, con quali
   stati e messaggi), non con markup. Se aggiungi un comportamento visibile,
   aggiorna il README nella sezione corrispondente.

Ne segue che un cambiamento utile al CRM è quasi sempre: un modulo TS (o una
funzione in un modulo esistente), il suo check, un paragrafo nel README.

## Convenzioni

- TypeScript `strict`, **niente `any`**: usa `unknown` e restringi con guardie.
- Export nominali, mai `export default`.
- Commenti solo per il *perché* non ovvio (una scelta, un caso reale che ha
  morso); niente commenti che ripetono il codice.
- Italiano ovunque: nomi delle colonne calcolate (`snake_case`), messaggi,
  commenti, commit.
- Le funzioni pure ricevono dati e restituiscono dati: la scrittura (DB, log,
  promozioni di stato) sta nell'host.
- Le chiamate esterne (GA4, Meta, Klaviyo) ricevono un contesto
  `{ account | token | apiKey, endpoints? }`: gli endpoint sono iniettabili
  per collaudare contro un server finto locale.

## Cosa NON fare

- Non toccare il formato di cifratura di `app/vault.js` (scrypt + AES-256-GCM,
  blob `iv | authTag | ciphertext`): i backup `.tbenc` e le credenziali salvate
  dipendono da quello. Il CRM usa `lib/tracking/crypto.ts` con `VAULT_KEY`;
  qui la chiave deriva dalla password o dal file `vault.key`, ed è voluto.
- Non rinominare gli id delle voci di checklist né dei blocchi report.
- Non aggiungere dipendenze a `lib/tracking/`: deve girare con Node e basta.
- Non usare credenziali reali di clienti nei check o negli esempi: chiavi
  finte, server finti, dati inventati.
- Non modificare a mano i file in `lib/tracking/` "per far funzionare l'app":
  se serve un adattamento, sta nel JS dell'host.
- Non versionare `twobee.db`, `clients/seed.json`, `.tbenc`: sono in
  `.gitignore` per un motivo.
