// Client GA4 Data API: è lib/tracking/ga4.ts, condiviso col CRM.
// Gli endpoint si ottengono con `defaultEndpoints()` (letti a ogni chiamata,
// così le variabili d'ambiente di collaudo funzionano); il contesto delle
// chiamate è `{ account, endpoints? }`.
export * from '../lib/tracking/ga4.ts';
