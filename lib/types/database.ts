import type {
  TrackingStatus, Archetype, PlatformKey, AgencyPlatformKey, QaCheckKey, QaStatus, ReportSource,
} from '@/lib/tracking/vocab'

// ── §316 Tracking ────────────────────────────────────────────────────────────

export interface ClientTracking {
  client_id: string
  archetype: Archetype | null
  cms: string
  gtm_container_id: string
  meta_pixel_id: string
  ga4_property_id: string
  lead_event: string
  status_gtm: TrackingStatus
  status_ga4: TrackingStatus
  status_meta_pixel: TrackingStatus
  status_klaviyo: TrackingStatus
  status_gsc: TrackingStatus
  created_at: string
  updated_at: string
  updated_by: string | null
}

export interface TrackingChecklistState {
  client_id: string
  item_id: string
  done: boolean
  note: string
  updated_at: string
}

export interface TrackingChange {
  field: string
  from: string
  to: string
  reason: string
}

export interface TrackingCheck {
  id: string
  client_id: string
  checked_at: string
  url: string
  ok: boolean
  http_status: number | null
  error: string | null
  gtm_ids: string[]
  ga4_ids: string[]
  meta_ids: string[]
  klaviyo: boolean
  changes: TrackingChange[]
  bytes: number | null
  duration_ms: number | null
}

export interface TrackingQaResult {
  client_id: string
  check_key: QaCheckKey
  status: QaStatus
  detail: string
  checked_at: string
}

export interface TrackingQaRun {
  id: string
  started_at: string
  finished_at: string | null
  origin: 'cron' | 'manuale' | 'cliente'
  clients: number
  problems: number
  duration_ms: number | null
  error: string | null
}

export interface TrackingReportRun {
  id: string
  client_id: string
  source: ReportSource
  definition: Record<string, unknown>
  definition_ver: number | null
  period_start: string
  period_end: string
  compare_start: string | null
  compare_end: string | null
  ok: boolean
  error: string | null
  row_count: number
  duration_ms: number | null
  created_at: string
  created_by: string | null
}

export interface TrackingReportRow {
  id: number
  run_id: string
  period: 'current' | 'previous'
  scope: 'total' | 'breakdown'
  breakdown: string | null
  dimensions: Record<string, string>
  metrics: Record<string, number>
}

/** Stato di uno slot chiave: mai il valore, solo se c'è. */
export interface PlatformKeyStatus {
  platform: PlatformKey
  label: string
  hint: string
  hasValue: boolean
  updatedAt: string | null
}

export interface AgencyKeyStatus {
  platform: AgencyPlatformKey
  label: string
  hint: string
  kind: 'json' | 'text'
  implemented: boolean
  hasValue: boolean
  updatedAt: string | null
}

/** Accesso ad account umano, senza la password: solo `has_secret`. */
export interface ClientLoginRow {
  id: string
  client_id: string
  service: string
  label: string
  username: string
  url: string
  note: string
  has_secret: boolean
  sort: number
  created_at: string
  updated_at: string
}
