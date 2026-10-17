
export type CountryCode =
  | 'HU' | 'DE' | 'NL' | 'AT' | 'PL' | 'ES' | 'FR' | 'IT' | 'CZ' | 'KZ' | 'GB' | 'RU'

export interface User {
  id: string
  email: string
  firstName: string
  fullName: string
  initials: string
  pictureUrl?: string
  /** ISO timestamp */
  memberSince: string
  citizenship: string
  passport: string
  address: string
  residenceStatus: string
  studies: string
  monthlyBudget: number
  savings: number
  isAdmin: boolean
  /** ISO alpha-2, '' when not set. Used by the explore map. */
  nationalityCode: string
  residenceCode: string
  travelPurpose: TravelPurpose
  settings: Settings
}

export type ProfilePatch = Partial<
  Pick<
    User,
    | 'fullName'
    | 'citizenship'
    | 'passport'
    | 'address'
    | 'residenceStatus'
    | 'studies'
    | 'monthlyBudget'
    | 'savings'
    | 'nationalityCode'
    | 'residenceCode'
    | 'travelPurpose'
  >
>

export const documentCategories = ['Passport', 'Visa or permit', 'Insurance', 'Finances', 'Education', 'Housing', 'Other'] as const
export type DocumentCategory = (typeof documentCategories)[number]

export interface DocumentIssue {
  field: string
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface DocumentAnalysis {
  status: 'pending' | 'done' | 'failed' | 'skipped'
  kind?: string
  summary?: string
  /** Normalised by the backend rules: dates are ISO, numbers exact. */
  fields: Record<string, string | boolean | null>
  issues: DocumentIssue[]
  error?: string
  analyzedAt?: string
}

export interface CaseDocument {
  analysis?: DocumentAnalysis
  id: string
  title: string
  category: DocumentCategory
  fileName: string
  contentType: string
  size: number
  /** ISO date */
  expiresOn?: string
  /** ISO timestamp */
  uploadedAt: string
}

export type TaskCategory = 'Documents' | 'Finances' | 'Journey' | 'Appointment' | 'Personal'

export interface Task {
  id: string
  title: string
  category: TaskCategory
  due?: string
  done: boolean
  /** Set for steps of a journey's pathway. */
  journeyId?: string
}

export type NotificationKind = 'deadline' | 'money' | 'document' | 'travel'

export interface AppNotification {
  id: string
  kind: NotificationKind
  title: string
  body: string
  /** ISO timestamp */
  createdAt: string
  unread: boolean
  href?: string
}

export interface Payment {
  id: string
  date: string
  what: string
  amount: number
  status: 'upcoming' | 'paid'
}

export interface ChatSessionInfo {
  id: string
  title: string
  journeyId?: string
  updatedAt: string
}

/** Something a tool created or opened, shown as a card under the reply. */
export interface ChatRef {
  kind: 'journey' | 'form'
  id: string
  title: string
}

export interface ChatStep {
  name: string
  label: string
  state: 'start' | 'done' | 'error'
  refs?: ChatRef[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  steps: ChatStep[]
  error?: string
  streaming?: boolean
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | ({ type: 'tool' } & ChatStep)
  | { type: 'done'; changed: string[] }
  | { type: 'error'; message: string }

export interface RequirementCheck {
  key: string
  title: string
  mandatory: boolean
  status: 'satisfied' | 'problem' | 'missing'
  matched_document: string | null
  problems: { document: string; problems: string[] }[]
}

export type JourneyStatus = 'planning' | 'active' | 'completed' | 'archived'

export interface JourneySummary {
  id: string
  title: string
  status: JourneyStatus
  destinationCode: string
  destinationName: string
  purpose: string
  visaType: string
  travelDate?: string
  stayDays?: number
  parentId?: string
  progress: { done: number; total: number }
  nextStep?: { title: string; dueDate?: string }
  updatedAt: string
}

export interface JourneyStep {
  id: string
  title: string
  description?: string
  kind: 'requirement' | 'step' | 'personal'
  category: string
  dueDate?: string
  done: boolean
}

export interface AutomationAction {
  kind: 'prefill' | 'pay' | 'calendar' | 'email' | 'upload'
  key: string
  title: string
  done: boolean
  formId?: string
  amount?: string
  currency?: string
  note?: string | null
  subject?: string
  body?: string
  category?: string
}

/** Every amount is a decimal string computed by the backend rules, per currency. */
export interface JourneyFinances {
  fees: { items: { title: string; amount: string | null; currency: string; mandatory: boolean; note?: string | null }[]; mandatory_totals: Record<string, string>; amounts_not_fixed: string[] }
  paid: Record<string, string>
  remaining: Record<string, string>
  proof_of_funds: { requirement: string; required: string; currency: string; savings_eur: string; covered: boolean | null; short_by: string | null } | null
  stay_months: number | null
  monthly_budget_eur: number
  living_budget_eur: string | null
}

export interface JourneyDetail extends JourneySummary {
  summary?: string
  originCode: string
  tripEnd?: string
  createdAt: string
  completedAt?: string
  guideline: {
    status: 'current' | 'stale' | 'missing'
    reason: string
    verifiedAt?: string
    summary?: string
    processingDaysMax?: number
    maxStayDays?: number
    sources: { title: string; url: string }[]
  }
  steps: JourneyStep[]
  requirements: (RequirementCheck & { source_url?: string | null; description?: string })[]
  finances: JourneyFinances
  automation: AutomationAction[]
  forms: { id: string; title: string; createdAt: string; missing: number }[]
  /** `createdHere`: the conversation this journey was planned in. */
  chats: { id: string; title: string; updatedAt: string; createdHere: boolean }[]
  parent?: { id: string; title: string }
  continuations: { id: string; title: string; status: JourneyStatus }[]
}

export interface PipelineRunInfo {
  id: string
  trigger: string
  status: 'queued' | 'running' | 'done' | 'failed'
  requested_by: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  results: {
    target: string
    status: 'published' | 'reverified' | 'held' | 'failed'
    reason?: string
    version?: number
    model?: string
    verified?: { requirements: number; fees: number; steps: number }
    dropped?: { item: string; reason: string }[]
    sources?: { url: string; title: string }[]
    fetch_errors?: { url: string; error: string }[]
    discovered?: string[]
    note?: string
  }[]
  log: string[]
}

export interface GuidelineEntry {
  id: string
  destination: string
  origin: string
  purpose: string
  visa_type: string
  managed_by: string
  version: number
  status: 'current' | 'stale' | 'missing'
  reason: string
  verified_at: string | null
  checked_at: string | null
  counts: { requirements: number; fees: number; steps: number }
  sources: { title: string; url: string }[]
}

export interface FormField {
  key: string
  label: string
  value: string | null
  status: 'filled' | 'missing'
  hint?: string | null
  /** Where the value came from, e.g. "passport.surname"; null if the user typed it. */
  source?: string | null
  edited?: boolean
}

export interface PrefilledForm {
  id: string
  formKey: string
  /** True when the official form is a printable PDF we can fill in. */
  hasOfficialPdf: boolean
  journeyId?: string
  title: string
  officialUrl?: string
  fields: FormField[]
  createdAt: string
}

/** Notification settings, saved on the server. The UI language is a device setting (see src/i18n). */
export interface Settings {
  push: boolean
  email: boolean
  sms: boolean
}

/* ---------------------------------------------------------------- explore */

export const travelPurposes = ['tourism', 'study', 'work', 'job_search', 'family'] as const
export type TravelPurpose = (typeof travelPurposes)[number]

export const visaStatuses = ['visa_free', 'visa_on_arrival', 'evisa', 'visa_required', 'unknown'] as const
/** `home` is the user's own country or the country of their residence permit. */
export type VisaStatus = (typeof visaStatuses)[number] | 'home'
/** What decided the status: see backend/app/explore.py. */
export type VisaBasis = 'home' | 'rule' | 'verified' | 'indicative' | 'none'

export interface VisaDecision {
  code: string
  status: VisaStatus
  basis: VisaBasis
  stayDays?: number
  /** Note keys, translated as explore.note.<key>. */
  notes: string[]
  hasGuideline: boolean
}

export interface DataSource {
  title: string
  url: string
  asOf: string
  licence: string
}

export interface TravelProfile {
  origin?: string
  originSource: 'chosen' | 'profile' | 'passport' | 'citizenship' | 'none'
  residence?: string
  purpose: TravelPurpose
}

export interface VisaMap extends TravelProfile {
  source: DataSource
  passports: string[]
  countries: VisaDecision[]
}

export interface CountryGuidelineDetail {
  status: 'current' | 'stale' | 'missing'
  reason: string
  visaType: string
  verifiedAt?: string
  summary?: string
  maxStayDays?: number
  processingDays?: [number | null, number | null]
  requirements: { title: string; description: string; mandatory: boolean }[]
  fees: { title: string; amount: string | null; currency: string }[]
  officialLinks: { title: string; url: string }[]
  sources: { title: string; url: string }[]
}

/** A destination that is easier to enter than the one the user can't go to (backend/app/explore.py). */
export interface DestinationAlternative {
  code: string
  status: VisaStatus
  basis: VisaBasis
  stayDays?: number
  hasGuideline: boolean
  lat?: number
  lng?: number
  distanceKm?: number
  sameSubregion: boolean
}

export interface DestinationAlternatives extends TravelProfile {
  /** The blocked destination, when looking for alternatives to one. */
  insteadOf?: VisaDecision
  alternatives: DestinationAlternative[]
  source: DataSource
}

export interface CountryVisaDetail extends TravelProfile {
  decision: VisaDecision
  guideline?: CountryGuidelineDetail
  indicative?: { category: string; stayDays?: number; raw: string }
  source: DataSource
  favorite: boolean
}
