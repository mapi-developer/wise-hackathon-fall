/**
 * Unbound API client. Each function calls the FastAPI backend (see
 * backend/app/main.py) and adapts its snake_case shapes to the frontend types,
 * so pages never see backend field names. Every call is scoped to the signed-in
 * user by the bearer token http.ts attaches.
 */
import { translate } from '@/i18n/core'
import { ApiError, getBlob, request, streamEvents, upload } from './http'
import type {
  AppNotification,
  CaseDocument,
  ChatEvent,
  ChatMessage,
  ChatSessionInfo,
  ChatStep,
  DocumentAnalysis,
  DocumentCategory,
  FormField,
  PrefilledForm,
  GuidelineEntry,
  JourneyDetail,
  JourneyStatus,
  JourneySummary,
  PipelineRunInfo,
  NotificationKind,
  Payment,
  ProfilePatch,
  Settings,
  Task,
  TaskCategory,
  TravelProfile,
  TravelPurpose,
  User,
  VisaDecision,
  VisaMap,
  DestinationAlternatives,
  CountryVisaDetail,
  DataSource,
} from './types'

export { ApiError }

/* ------------------------------------------------------- backend shapes */

interface ApiUser {
  id: string
  email: string
  full_name: string
  first_name: string
  picture_url: string | null
  created_at: string
  citizenship: string
  passport: string
  address: string
  residence_status: string
  studies: string
  monthly_budget_eur: number
  savings_eur: number
  is_admin: boolean
  nationality_code: string
  residence_code: string
  travel_purpose: string
  notify_push: boolean
  notify_email: boolean
  notify_sms: boolean
}

interface ApiTask {
  id: string
  title: string
  category: string
  due_date: string | null
  done: boolean
  journey_id: string | null
}

interface ApiDocument {
  id: string
  title: string
  category: string
  file_name: string
  content_type: string
  size_bytes: number
  expires_on: string | null
  uploaded_at: string
  analysis: {
    status: DocumentAnalysis['status']
    document_kind: string | null
    summary: string | null
    fields: DocumentAnalysis['fields']
    issues: DocumentAnalysis['issues']
    error: string | null
    analyzed_at: string | null
  } | null
}


interface ApiForm {
  id: string
  form_key: string
  has_official_pdf: boolean
  journey_id: string | null
  title: string
  official_url: string | null
  fields: FormField[]
  created_at: string
}

interface ApiChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string | null
  events: ChatStep[]
}

interface ApiPayment {
  id: string
  title: string
  amount_eur: number
  status: string
  paid_on: string
}

interface ApiNotification {
  id: string
  kind: string
  title: string
  body: string
  href: string
  read: boolean
  created_at: string
}


/* -------------------------------------------------------------- adapters */

export type ServerSettings = Settings

const settingKeys: Record<keyof ServerSettings, keyof ApiUser> = {
  push: 'notify_push',
  email: 'notify_email',
  sms: 'notify_sms',
}

const profileKeys: Record<keyof ProfilePatch, keyof ApiUser> = {
  fullName: 'full_name',
  citizenship: 'citizenship',
  passport: 'passport',
  address: 'address',
  residenceStatus: 'residence_status',
  studies: 'studies',
  monthlyBudget: 'monthly_budget_eur',
  savings: 'savings_eur',
  nationalityCode: 'nationality_code',
  residenceCode: 'residence_code',
  travelPurpose: 'travel_purpose',
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase()

const toUser = (u: ApiUser): User => ({
  id: u.id,
  email: u.email,
  firstName: u.first_name,
  fullName: u.full_name,
  initials: initialsOf(u.full_name) || '?',
  pictureUrl: u.picture_url ?? undefined,
  memberSince: u.created_at,
  citizenship: u.citizenship,
  passport: u.passport,
  address: u.address,
  residenceStatus: u.residence_status,
  studies: u.studies,
  monthlyBudget: u.monthly_budget_eur,
  savings: u.savings_eur,
  isAdmin: u.is_admin,
  nationalityCode: u.nationality_code,
  residenceCode: u.residence_code,
  travelPurpose: u.travel_purpose as TravelPurpose,
  settings: { push: u.notify_push, email: u.notify_email, sms: u.notify_sms },
})

const toTask = (t: ApiTask): Task => ({
  id: t.id,
  title: t.title,
  category: t.category as TaskCategory,
  due: t.due_date ?? undefined,
  done: t.done,
  journeyId: t.journey_id ?? undefined,
})

const toDocument = (d: ApiDocument): CaseDocument => ({
  id: d.id,
  title: d.title,
  category: d.category as DocumentCategory,
  fileName: d.file_name,
  contentType: d.content_type,
  size: d.size_bytes,
  expiresOn: d.expires_on ?? undefined,
  uploadedAt: d.uploaded_at,
  analysis: d.analysis
    ? {
        status: d.analysis.status,
        kind: d.analysis.document_kind ?? undefined,
        summary: d.analysis.summary ?? undefined,
        fields: d.analysis.fields ?? {},
        issues: d.analysis.issues ?? [],
        error: d.analysis.error ?? undefined,
        analyzedAt: d.analysis.analyzed_at ?? undefined,
      }
    : undefined,
})


const toForm = (f: ApiForm): PrefilledForm => ({
  id: f.id,
  formKey: f.form_key,
  hasOfficialPdf: f.has_official_pdf,
  journeyId: f.journey_id ?? undefined,
  title: f.title,
  officialUrl: f.official_url ?? undefined,
  fields: f.fields,
  createdAt: f.created_at,
})

const toPayment = (p: ApiPayment): Payment => ({
  id: p.id,
  date: p.paid_on,
  what: p.title,
  amount: p.amount_eur,
  status: p.status === 'paid' ? 'paid' : 'upcoming',
})

const toNotification = (n: ApiNotification): AppNotification => ({
  id: n.id,
  kind: n.kind as NotificationKind,
  title: n.title,
  body: n.body,
  createdAt: n.created_at,
  unread: !n.read,
  href: n.href,
})

/* ------------------------------------------------------------------ auth */

/** Exchanges a Google ID token for our own access token. */
export async function loginWithGoogle(credential: string) {
  const r = await request<{ access_token: string; user: ApiUser }>('/api/auth/google', { method: 'POST', body: { credential } })
  return { token: r.access_token, user: toUser(r.user) }
}

/* --------------------------------------------------------------- profile */

export const getMe = async () => toUser(await request<ApiUser>('/api/me'))

export async function updateMe(patch: ProfilePatch & Partial<ServerSettings>) {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    const key = profileKeys[k as keyof ProfilePatch] ?? settingKeys[k as keyof ServerSettings]
    if (key) body[key] = v
  }
  return toUser(await request<ApiUser>('/api/me', { method: 'PATCH', body }))
}

export const deleteMe = () => request<null>('/api/me', { method: 'DELETE' })

/* ----------------------------------------------------------------- tasks */

export const listTasks = async () => (await request<ApiTask[]>('/api/tasks')).map(toTask)

export const createTask = async (title: string, due?: string, category: TaskCategory = 'Personal') =>
  toTask(await request<ApiTask>('/api/tasks', { method: 'POST', body: { title, category, due_date: due || null } }))

export const setTaskDone = async (id: string, done: boolean) =>
  toTask(await request<ApiTask>(`/api/tasks/${id}`, { method: 'PATCH', body: { done } }))

export const deleteTask = (id: string) => request<null>(`/api/tasks/${id}`, { method: 'DELETE' })

/* ------------------------------------------------------------- documents */

export const MAX_UPLOAD_MB = 10
const ACCEPTED = ['application/pdf', 'image/jpeg', 'image/png']

export const listDocuments = async () => (await request<ApiDocument[]>('/api/documents')).map(toDocument)

export async function uploadDocument(
  input: { file: File; title: string; category: DocumentCategory; expiresOn?: string },
  onProgress: (pct: number) => void,
) {
  // Checked here too, so a wrong file fails before the upload starts.
  if (!ACCEPTED.includes(input.file.type)) throw new ApiError(translate('error.fileType'))
  if (input.file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new ApiError(translate('error.fileTooBig', { mb: MAX_UPLOAD_MB }))
  const form = new FormData()
  form.append('file', input.file)
  form.append('title', input.title)
  form.append('category', input.category)
  if (input.expiresOn) form.append('expires_on', input.expiresOn)
  return toDocument(await upload<ApiDocument>('/api/documents', form, onProgress))
}

export const downloadDocument = (id: string) => getBlob(`/api/documents/${id}/file`)

export const deleteDocument = (id: string) => request<null>(`/api/documents/${id}`, { method: 'DELETE' })

/* -------------------------------------------------------------- payments */

export const listPayments = async () => (await request<ApiPayment[]>('/api/payments')).map(toPayment)

/** Simulated Wise payment: the server records it as paid. */
export const recordPayment = async (title: string, amount: number) =>
  toPayment(await request<ApiPayment>('/api/payments', { method: 'POST', body: { title, amount_eur: amount } }))

/* --------------------------------------------------------- notifications */

export const listNotifications = async () => (await request<ApiNotification[]>('/api/notifications')).map(toNotification)

export const markNotificationRead = (id: string) => request<ApiNotification>(`/api/notifications/${id}/read`, { method: 'POST' })

export const markAllNotificationsRead = () => request<null>('/api/notifications/mark-all-read', { method: 'POST' })

/* ------------------------------------------------------- analysis, forms */

export const reanalyzeDocument = async (id: string) => toDocument(await request<ApiDocument>(`/api/documents/${id}/analyze`, { method: 'POST' }))


export const listForms = async () => (await request<ApiForm[]>('/api/forms')).map(toForm)

export const getForm = async (id: string) => toForm(await request<ApiForm>(`/api/forms/${id}`))

export const deleteForm = (id: string) => request<null>(`/api/forms/${id}`, { method: 'DELETE' })

export const updateForm = async (id: string, values: Record<string, string | null>) =>
  toForm(await request<ApiForm>(`/api/forms/${id}`, { method: 'PATCH', body: { values } }))

/** The official form with the values written in (only when hasOfficialPdf). */
export const downloadOfficialForm = (id: string) => getBlob(`/api/forms/${id}/official.pdf`)

/** Every field with its value and source, for online forms. */
export const downloadFormDatasheet = (id: string) => getBlob(`/api/forms/${id}/datasheet.pdf`)

/* ------------------------------------------------------------- assistant */

interface ApiSession {
  id: string
  title: string
  journey_id: string | null
  updated_at: string
}

const toSession = (s: ApiSession): ChatSessionInfo => ({ id: s.id, title: s.title, journeyId: s.journey_id ?? undefined, updatedAt: s.updated_at })

export const listChats = async () => (await request<ApiSession[]>('/api/chat/sessions')).map(toSession)

export const createChat = async (journeyId?: string) =>
  toSession(await request<ApiSession>('/api/chat/sessions', { method: 'POST', body: { journey_id: journeyId ?? null } }))

/** Point a conversation at another journey, or none. */
export const setChatJourney = async (id: string, journeyId: string | null) =>
  toSession(await request<ApiSession>(`/api/chat/sessions/${id}`, { method: 'PATCH', body: { journey_id: journeyId } }))

export const deleteChat = (id: string) => request<null>(`/api/chat/sessions/${id}`, { method: 'DELETE' })

/** Rows from the server, with consecutive assistant rows (text, tool steps, more text) merged into one reply. */
export async function getChatMessages(id: string): Promise<ChatMessage[]> {
  const rows = await request<ApiChatMessage[]>(`/api/chat/sessions/${id}/messages`)
  const out: ChatMessage[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (r.role === 'assistant' && last?.role === 'assistant') {
      last.text = [last.text, r.text].filter(Boolean).join('\n\n')
      last.steps.push(...r.events)
    } else {
      out.push({ id: r.id, role: r.role, text: r.text ?? '', steps: [...r.events] })
    }
  }
  return out
}

export const sendChatMessage = (id: string, message: string, onEvent: (e: ChatEvent) => void, signal?: AbortSignal) =>
  streamEvents<ChatEvent>(`/api/chat/sessions/${id}/messages`, { message }, onEvent, signal)

/* -------------------------------------------------------------- journeys */

interface ApiJourneySummary {
  id: string
  title: string
  status: JourneyStatus
  destination_code: string
  destination_name: string
  purpose: string
  visa_type: string
  travel_date: string | null
  stay_days: number | null
  parent_id?: string | null
  progress: { done: number; total: number }
  next_step?: { title: string; due_date: string | null } | null
  updated_at: string
}

type ApiJourneyDetail = ApiJourneySummary & {
  summary: string | null
  origin_code: string
  trip_end: string | null
  created_at: string
  completed_at: string | null
  guideline: { status: JourneyDetail['guideline']['status']; reason: string; verified_at: string | null; summary: string | null; processing_days_max: number | null; max_stay_days: number | null; sources: { title: string; url: string }[] }
  steps: { id: string; title: string; description: string | null; kind: JourneyDetail['steps'][number]['kind']; category: string; due_date: string | null; done: boolean }[]
  requirements: JourneyDetail['requirements']
  finances: JourneyDetail['finances']
  automation: (Omit<JourneyDetail['automation'][number], 'formId'> & { form_id?: string | null })[]
  forms: { id: string; title: string; created_at: string; missing: number }[]
  chats: { id: string; title: string; updated_at: string; created_here?: boolean }[]
  parent: { id: string; title: string } | null
  continuations: JourneyDetail['continuations']
}

const toJourneySummary = (j: ApiJourneySummary): JourneySummary => ({
  id: j.id,
  title: j.title,
  status: j.status,
  destinationCode: j.destination_code,
  destinationName: j.destination_name,
  purpose: j.purpose,
  visaType: j.visa_type,
  travelDate: j.travel_date ?? undefined,
  stayDays: j.stay_days ?? undefined,
  parentId: j.parent_id ?? undefined,
  progress: j.progress,
  nextStep: j.next_step ? { title: j.next_step.title, dueDate: j.next_step.due_date ?? undefined } : undefined,
  updatedAt: j.updated_at,
})

const toJourney = (j: ApiJourneyDetail): JourneyDetail => ({
  ...toJourneySummary(j),
  parentId: j.parent?.id,
  summary: j.summary ?? undefined,
  originCode: j.origin_code,
  tripEnd: j.trip_end ?? undefined,
  createdAt: j.created_at,
  completedAt: j.completed_at ?? undefined,
  guideline: {
    status: j.guideline.status,
    reason: j.guideline.reason,
    verifiedAt: j.guideline.verified_at ?? undefined,
    summary: j.guideline.summary ?? undefined,
    processingDaysMax: j.guideline.processing_days_max ?? undefined,
    maxStayDays: j.guideline.max_stay_days ?? undefined,
    sources: j.guideline.sources ?? [],
  },
  steps: j.steps.map((s) => ({ id: s.id, title: s.title, description: s.description ?? undefined, kind: s.kind, category: s.category, dueDate: s.due_date ?? undefined, done: s.done })),
  requirements: j.requirements,
  finances: j.finances,
  automation: j.automation.map(({ form_id, ...a }) => ({ ...a, formId: form_id ?? undefined })),
  forms: j.forms.map((f) => ({ id: f.id, title: f.title, createdAt: f.created_at, missing: f.missing })),
  chats: j.chats.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at, createdHere: !!c.created_here })),
  parent: j.parent ?? undefined,
  continuations: j.continuations,
})

export const listJourneys = async () => (await request<ApiJourneySummary[]>('/api/journeys')).map(toJourneySummary)

export const getJourney = async (id: string) => toJourney(await request<ApiJourneyDetail>(`/api/journeys/${id}`))

export const updateJourney = async (id: string, patch: { title?: string; status?: JourneyStatus; travel_date?: string | null; stay_days?: number | null }) =>
  toJourney(await request<ApiJourneyDetail>(`/api/journeys/${id}`, { method: 'PATCH', body: patch }))

export const deleteJourney = (id: string) => request<null>(`/api/journeys/${id}`, { method: 'DELETE' })

export const prefillJourneyForm = async (id: string, formKey: string) => toForm(await request<ApiForm>(`/api/journeys/${id}/forms/${formKey}`, { method: 'POST' }))

export const payJourneyFee = (id: string, feeKey: string) => request<unknown>(`/api/journeys/${id}/fees/${feeKey}/pay`, { method: 'POST' })

export const journeyCalendar = (id: string) => getBlob(`/api/journeys/${id}/calendar.ics`)

/* ----------------------------------------------------------------- admin */

export const getPipeline = () => request<{ runs: PipelineRunInfo[]; guidelines: GuidelineEntry[]; targets: string[] }>('/api/admin/pipeline')

export const queuePipelineRun = () => request<PipelineRunInfo>('/api/admin/pipeline/runs', { method: 'POST' })

/* --------------------------------------------------------------- explore */

interface ApiDecision {
  code: string
  status: VisaDecision['status']
  basis: VisaDecision['basis']
  stay_days: number | null
  notes: string[]
  has_guideline?: boolean
}

interface ApiProfile {
  origin: string | null
  origin_source: TravelProfile['originSource']
  residence: string | null
  purpose: TravelPurpose
  source: { title: string; url: string; as_of: string; licence: string }
}

interface ApiGuideline {
  status: 'current' | 'stale' | 'missing'
  reason: string
  visa_type: string
  verified_at: string | null
  summary?: string
  max_stay_days?: number | null
  processing_days_min?: number | null
  processing_days_max?: number | null
  requirements?: { title: string; description: string; mandatory: boolean }[]
  fees?: { title: string; amount: string | null; currency: string }[]
  official_links?: { title: string; url: string }[]
  sources?: { title: string; url: string }[]
}

const toDecision = (d: ApiDecision): VisaDecision => ({
  code: d.code,
  status: d.status,
  basis: d.basis,
  stayDays: d.stay_days ?? undefined,
  notes: d.notes,
  hasGuideline: !!d.has_guideline,
})

const toSource = (s: ApiProfile['source']): DataSource => ({ title: s.title, url: s.url, asOf: s.as_of, licence: s.licence })

const toTravelProfile = (p: ApiProfile): TravelProfile => ({
  origin: p.origin ?? undefined,
  originSource: p.origin_source,
  residence: p.residence ?? undefined,
  purpose: p.purpose,
})

/** Overrides for the map; anything left out comes from the profile. `residence: ''` means no permit. */
export interface ExploreQuery {
  origin?: string
  residence?: string
  purpose?: TravelPurpose
}

const exploreQuery = (q: ExploreQuery) => {
  const params = new URLSearchParams()
  if (q.origin) params.set('origin', q.origin)
  if (q.residence !== undefined) params.set('residence', q.residence)
  if (q.purpose) params.set('purpose', q.purpose)
  const s = params.toString()
  return s ? `?${s}` : ''
}

export async function getVisaMap(q: ExploreQuery = {}): Promise<VisaMap> {
  const r = await request<ApiProfile & { passports: string[]; countries: ApiDecision[] }>(`/api/explore/map${exploreQuery(q)}`)
  return { ...toTravelProfile(r), source: toSource(r.source), passports: r.passports, countries: r.countries.map(toDecision) }
}

export async function getCountryVisa(code: string, q: ExploreQuery = {}): Promise<CountryVisaDetail> {
  const r = await request<
    ApiProfile & { decision: ApiDecision; guideline: ApiGuideline | null; indicative: { category: string; stay_days: number | null; raw: string } | null; favorite: boolean }
  >(`/api/explore/countries/${code}${exploreQuery(q)}`)
  const g = r.guideline
  return {
    ...toTravelProfile(r),
    decision: toDecision({ ...r.decision, has_guideline: g?.status === 'current' }),
    guideline: g
      ? {
          status: g.status,
          reason: g.reason,
          visaType: g.visa_type,
          verifiedAt: g.verified_at ?? undefined,
          summary: g.summary,
          maxStayDays: g.max_stay_days ?? undefined,
          processingDays: g.processing_days_min != null || g.processing_days_max != null ? [g.processing_days_min ?? null, g.processing_days_max ?? null] : undefined,
          requirements: g.requirements ?? [],
          fees: g.fees ?? [],
          officialLinks: g.official_links ?? [],
          sources: g.sources ?? [],
        }
      : undefined,
    indicative: r.indicative ? { category: r.indicative.category, stayDays: r.indicative.stay_days ?? undefined, raw: r.indicative.raw } : undefined,
    source: toSource(r.source),
    favorite: r.favorite,
  }
}

interface ApiAlternative {
  code: string
  status: VisaDecision['status']
  basis: VisaDecision['basis']
  stay_days: number | null
  has_guideline: boolean
  lat: number | null
  lng: number | null
  distance_km: number | null
  same_subregion: boolean
}

/** Easier destinations than `insteadOf` (visa-free first, then nearest), or the easiest overall. */
export async function getAlternatives(q: ExploreQuery, insteadOf?: string, region?: string): Promise<DestinationAlternatives> {
  const params = new URLSearchParams(exploreQuery(q).slice(1))
  if (insteadOf) params.set('instead_of', insteadOf)
  if (region) params.set('region', region)
  const r = await request<ApiProfile & { instead_of: ApiDecision | null; alternatives: ApiAlternative[] }>(`/api/explore/alternatives?${params}`)
  return {
    ...toTravelProfile(r),
    insteadOf: r.instead_of ? toDecision(r.instead_of) : undefined,
    alternatives: r.alternatives.map((a) => ({
      code: a.code,
      status: a.status,
      basis: a.basis,
      stayDays: a.stay_days ?? undefined,
      hasGuideline: a.has_guideline,
      lat: a.lat ?? undefined,
      lng: a.lng ?? undefined,
      distanceKm: a.distance_km ?? undefined,
      sameSubregion: a.same_subregion,
    })),
    source: toSource(r.source),
  }
}

export const listFavorites = () => request<string[]>('/api/explore/favorites')

export const addFavorite = (code: string) => request<null>('/api/explore/favorites', { method: 'POST', body: { country_code: code } })

export const removeFavorite = (code: string) => request<null>(`/api/explore/favorites/${code}`, { method: 'DELETE' })
