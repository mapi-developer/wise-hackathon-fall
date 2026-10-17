import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowRight, Check, ChevronDown, CircleAlert, ExternalLink, FileText, History, Loader2, Map as MapIcon, Plus, Route, Square, Trash2 } from 'lucide-react'
import { LogoMark } from '@/components/brand/Logo'
import { Card, Progress } from '@/components/ui/primitives'
import { useI18n } from '@/i18n'
import * as api from '@/lib/api'
import { suggestedQuestions } from '@/lib/mock-data'
import { cn, timeAgo, uid } from '@/lib/format'
import { statusMeta } from '@/components/case/journey-meta'
import type { ChatMessage, ChatRef, ChatSessionInfo, ChatStep, JourneySummary } from '@/lib/types'
import { usePersistentState } from '@/store/persist'
import { useAuth, useCase, useToast } from '@/store/context'

function Spark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={cn('size-[18px] shrink-0 text-brick-600', className)} aria-hidden>
      <path d="M10 1.5C10.6 6.6 13 9.2 18.5 10C13 10.8 10.6 13.4 10 18.5C9.4 13.4 7 10.8 1.5 10C7 9.2 9.4 6.6 10 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

/** Agent replies are Markdown; app links (/app/...) stay inside the app. */
const markdown: Components = {
  p: (p) => <p className="my-2 first:mt-0 last:mb-0" {...p} />,
  ul: (p) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
  ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
  strong: (p) => <strong className="font-semibold text-forest-950" {...p} />,
  h1: (p) => <h3 className="mt-3 mb-1 font-semibold" {...p} />,
  h2: (p) => <h3 className="mt-3 mb-1 font-semibold" {...p} />,
  h3: (p) => <h3 className="mt-3 mb-1 font-semibold" {...p} />,
  code: (p) => <code className="rounded bg-rose-100 px-1 py-0.5 text-[13px]" {...p} />,
  table: (p) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full text-left text-sm" {...p} />
    </div>
  ),
  th: (p) => <th className="border-b border-rose-200 py-1.5 pr-3 font-semibold" {...p} />,
  td: (p) => <td className="border-b border-rose-200/60 py-1.5 pr-3 align-top" {...p} />,
  a: ({ href = '', children }) =>
    href.startsWith('/app') ? (
      <Link to={href} className="font-semibold text-brick-700 underline underline-offset-2">
        {children}
      </Link>
    ) : (
      <a href={href} target="_blank" rel="noreferrer" className="font-semibold text-brick-700 underline underline-offset-2">
        {children}
      </a>
    ),
}

function Steps({ steps }: { steps: ChatStep[] }) {
  const { t, tOr } = useI18n()
  if (!steps.length) return null
  return (
    <ul className="mb-2 flex flex-wrap gap-1.5" aria-label={t('chat.stepsAria')}>
      {steps.map((s, i) => (
        <li
          key={i}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
            s.state === 'error' ? 'bg-rose-100 text-brick-700' : 'bg-white text-muted',
          )}
        >
          {s.state === 'start' ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : s.state === 'error' ? (
            <CircleAlert className="size-3" aria-hidden />
          ) : (
            <Check className="size-3 text-ok-700" aria-hidden />
          )}
          {tOr(`tool.${s.name}`, s.label)}
        </li>
      ))}
    </ul>
  )
}

/** Cards for the journeys and forms the assistant created or opened in this reply. */
function RefCards({
  steps,
  journeys,
  current,
  busy,
  onSwitch,
}: {
  steps: ChatStep[]
  journeys: JourneySummary[]
  current?: string
  busy: boolean
  onSwitch: (id: string) => void
}) {
  const { t } = useI18n()
  const seen = new Set<string>()
  const refs = steps.flatMap((s) => s.refs ?? []).filter((r: ChatRef) => !seen.has(`${r.kind}:${r.id}`) && !!seen.add(`${r.kind}:${r.id}`))
  if (!refs.length) return null
  return (
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
      {refs.map((r) => {
        if (r.kind === 'form')
          return (
            <li key={`form:${r.id}`}>
              <Link to={`/app/forms/${r.id}`} className="flex items-center gap-3 rounded-xl border border-rose-200 bg-white px-3.5 py-3 hover:border-brick-600">
                <FileText className="size-5 shrink-0 text-brick-600" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{r.title}</span>
                  <span className="text-xs text-muted">{t('chat.card.openForm')}</span>
                </span>
              </Link>
            </li>
          )
        // Live data when the journey is loaded (it may have been renamed or progressed since).
        const j = journeys.find((x) => x.id === r.id)
        if (!j) return null // deleted since
        const pct = j.progress.total ? (j.progress.done / j.progress.total) * 100 : 0
        const isCurrent = j.id === current
        return (
          <li key={`journey:${r.id}`} className={cn('rounded-xl border bg-white px-3.5 py-3', isCurrent ? 'border-forest-950' : 'border-rose-200')}>
            <div className="flex items-start gap-2">
              <Route className="mt-0.5 size-4 shrink-0 text-brick-600" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{j.title}</p>
                <p className="truncate text-xs text-muted">
                  {t(statusMeta[j.status].label)} · {t('journeys.stepsDone', { done: j.progress.done, total: j.progress.total })}
                </p>
              </div>
            </div>
            <Progress value={pct} className="mt-2" label={t('journeys.progressOf', { title: j.title })} />
            <div className="mt-2.5 flex items-center gap-3 text-[13px] font-semibold">
              <Link to={`/app/journeys/${j.id}`} className="text-brick-700 underline underline-offset-2">
                {t('chat.card.openPlan')}
              </Link>
              {isCurrent ? (
                <span className="flex items-center gap-1 text-xs font-medium text-muted">
                  <Check className="size-3.5 text-ok-700" aria-hidden /> {t('chat.card.current')}
                </span>
              ) : (
                <button type="button" disabled={busy} onClick={() => onSwitch(j.id)} className="underline underline-offset-2 disabled:opacity-50">
                  {t('chat.card.workOnThis')}
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** Which journey the conversation works on; the assistant can switch it too (switch_journey). */
function JourneySwitcher({
  journeys,
  value,
  disabled,
  onPick,
  onNew,
}: {
  journeys: JourneySummary[]
  value?: JourneySummary
  disabled: boolean
  onPick: (id: string | null) => void
  onNew: () => void
}) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const pick = (id: string | null) => {
    setOpen(false)
    if (id !== (value?.id ?? null)) onPick(id)
  }
  const listed = journeys.filter((j) => j.status !== 'archived' || j.id === value?.id)
  return (
    <div ref={wrap} className="relative flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        aria-expanded={open}
        aria-label={t('chat.journey.label')}
        className={cn(
          'flex min-w-0 items-center gap-1 truncate text-left text-[13px] disabled:opacity-60',
          value ? 'font-semibold text-brick-700' : 'text-muted hover:text-forest-950',
        )}
      >
        <span className="truncate">{value ? t('chat.about', { title: value.title }) : t('chat.journey.none')}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </button>
      {value && (
        <Link to={`/app/journeys/${value.id}`} aria-label={t('chat.journey.open')} className="shrink-0 text-muted hover:text-brick-700">
          <ExternalLink className="size-3.5" />
        </Link>
      )}
      {open && (
        <ul className="animate-pop-in absolute top-[calc(100%+6px)] left-0 z-30 max-h-80 w-72 overflow-y-auto rounded-2xl border border-rose-200 bg-white py-1.5 shadow-[0_24px_60px_-20px_rgb(3_16_10/0.35)]">
          {listed.map((j) => (
            <li key={j.id}>
              <button type="button" onClick={() => pick(j.id)} className={cn('flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-blush', j.id === value?.id && 'bg-rose-100')}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{j.title}</span>
                  <span className="text-xs text-muted">
                    {t(statusMeta[j.status].label)} · {t('journeys.stepsDone', { done: j.progress.done, total: j.progress.total })}
                  </span>
                </span>
                {j.id === value?.id && <Check className="size-4 shrink-0 text-ok-700" aria-hidden />}
              </button>
            </li>
          ))}
          <li className={cn(listed.length > 0 && 'mt-1 border-t border-rose-200 pt-1')}>
            <button type="button" onClick={() => pick(null)} className={cn('flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-blush', !value && 'bg-rose-100')}>
              <span className="flex-1">{t('chat.journey.general')}</span>
              {!value && <Check className="size-4 shrink-0 text-ok-700" aria-hidden />}
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onNew()
              }}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-semibold text-brick-700 hover:bg-blush"
            >
              <Plus className="size-4" aria-hidden /> {t('chat.journey.new')}
            </button>
          </li>
        </ul>
      )}
    </div>
  )
}

function History_({
  sessions,
  journeyTitles,
  current,
  onPick,
  onDelete,
}: {
  sessions: ChatSessionInfo[]
  journeyTitles: Record<string, string>
  current: string | null
  onPick: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  if (!sessions.length) return null
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-muted hover:bg-rose-100 hover:text-forest-950"
      >
        <History className="size-4" aria-hidden /> <span className="hidden sm:inline">{t('chat.history')}</span>
        <ChevronDown className="size-3.5" aria-hidden />
      </button>
      {open && (
        <ul className="animate-pop-in absolute top-[calc(100%+6px)] right-0 z-30 max-h-80 w-72 overflow-y-auto rounded-2xl border border-rose-200 bg-white py-1.5 shadow-[0_24px_60px_-20px_rgb(3_16_10/0.35)]">
          {sessions.map((s) => (
            <li key={s.id} className="group flex items-center">
              <button
                type="button"
                onClick={() => {
                  onPick(s.id)
                  setOpen(false)
                }}
                className={cn('min-w-0 flex-1 px-4 py-2 text-left hover:bg-blush', s.id === current && 'bg-rose-100')}
              >
                <span className="block truncate text-sm font-medium">{s.title}</span>
                <span className="block truncate text-xs text-muted">
                  {s.journeyId && journeyTitles[s.journeyId] && `${journeyTitles[s.journeyId]} · `}
                  {timeAgo(s.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(s.id)}
                aria-label={t('chat.deleteConversation', { title: s.title })}
                className="mr-2 grid size-8 shrink-0 place-items-center rounded-full text-muted opacity-0 group-hover:opacity-100 hover:bg-rose-100 hover:text-brick-600 focus:opacity-100"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * `journeyId`: start new conversations about this journey. `openChatId`: open this saved
 * conversation. `initialPrompt`: put this text in the box. All come from the URL.
 */
export function Chat({
  journeyId,
  openChatId,
  initialPrompt,
  fresh = false,
  onJourneyChange,
}: {
  journeyId?: string
  openChatId?: string
  initialPrompt?: string
  fresh?: boolean
  /** Tells the page which journey the open conversation is about (it can change mid-conversation). */
  onJourneyChange?: (journeyId?: string) => void
} = {}) {
  const { user } = useAuth()
  const { refresh, journeys } = useCase()
  const { toast } = useToast()
  const { t, locale } = useI18n()
  const [current, setCurrent] = usePersistentState<string | null>('chat-current', null)
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([])
  // Messages are tagged with the conversation they belong to, so switching shows nothing stale.
  const [loaded, setLoaded] = useState<{ for: string | null; list: ChatMessage[] }>({ for: null, list: [] })
  const loadedFor = useRef<string | null>(null)
  const show = useCallback((chatId: string, list: ChatMessage[]) => {
    loadedFor.current = chatId
    setLoaded({ for: chatId, list })
  }, [])
  const messages = useMemo(() => (loaded.for === current ? loaded.list : []), [loaded, current])
  const loading = !!current && loaded.for !== current
  const setMessages = (fn: (ms: ChatMessage[]) => ChatMessage[]) => setLoaded((l) => ({ ...l, list: fn(l.list) }))
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(initialPrompt ?? '')
  // The journey new conversations are bound to (from the URL).
  const [boundJourney, setBoundJourney] = useState<string | undefined>(journeyId)
  const [params, setParams] = useState({ journeyId, openChatId, initialPrompt })
  if (params.journeyId !== journeyId || params.openChatId !== openChatId || params.initialPrompt !== initialPrompt) {
    // The URL changed while mounted (e.g. "Ask about this journey"): adjust during render.
    setParams({ journeyId, openChatId, initialPrompt })
    setBoundJourney(journeyId)
    if (initialPrompt) setDraft(initialPrompt)
    openFromUrl(openChatId, journeyId, fresh)
  }
  const [urlApplied, setUrlApplied] = useState(false)
  if (!urlApplied) {
    setUrlApplied(true)
    openFromUrl(openChatId, journeyId, fresh)
  }
  const currentSession = sessions.find((s) => s.id === current)
  const chatJourneyId = current ? currentSession?.journeyId : boundJourney
  const chatJourney = journeys.find((j) => j.id === chatJourneyId)
  useEffect(() => {
    onJourneyChange?.(chatJourney?.id)
  }, [chatJourney?.id, onJourneyChange])
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const abort = useRef<AbortController | null>(null)

  function openFromUrl(chatId?: string, journey?: string, startNew = false) {
    if (chatId) setCurrent(chatId)
    else if (journey || startNew) setCurrent(null) // a fresh conversation (about that journey, if given)
  }

  const loadSessions = useCallback(() => api.listChats().then(setSessions, () => {}), [])
  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    // Skip when this conversation is already in memory (e.g. just created by ask()).
    if (!current || loadedFor.current === current) return
    let cancelled = false
    api.getChatMessages(current).then(
      (list) => !cancelled && show(current, list),
      // The conversation was deleted elsewhere: start fresh.
      () => !cancelled && setCurrent(null),
    )
    return () => {
      cancelled = true
    }
  }, [current, setCurrent, show])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const updateLast = (fn: (m: ChatMessage) => ChatMessage) => setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)))

  const ask = async (q: string) => {
    const text = q.trim()
    if (!text || busy) return
    setDraft('')
    setBusy(true)
    let chatId = current
    try {
      if (!chatId) {
        chatId = (await api.createChat(boundJourney)).id
        show(chatId, [])
        setCurrent(chatId)
      }
      setMessages((ms) => [
        ...ms,
        { id: uid('u'), role: 'user', text, steps: [] },
        { id: uid('a'), role: 'assistant', text: '', steps: [], streaming: true },
      ])
      const controller = new AbortController()
      abort.current = controller
      await api.sendChatMessage(
        chatId,
        text,
        (e) => {
          if (e.type === 'text') updateLast((m) => ({ ...m, text: m.text + e.text }))
          else if (e.type === 'tool')
            updateLast((m) => {
              const steps = [...m.steps]
              const i = e.state === 'start' ? -1 : steps.findLastIndex((s) => s.name === e.name && s.state === 'start')
              const step = { name: e.name, label: e.label, state: e.state, refs: e.refs }
              if (i >= 0) steps[i] = step
              else steps.push(step)
              return { ...m, steps }
            })
          else if (e.type === 'error') updateLast((m) => ({ ...m, error: e.message }))
          else if (e.type === 'done') refresh(e.changed)
        },
        controller.signal,
      )
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const message = err instanceof Error ? err.message : t('chat.noAnswer')
        setMessages((ms) => (ms.length && ms[ms.length - 1].role === 'assistant' ? ms : [...ms, { id: uid('a'), role: 'assistant', text: '', steps: [] }]))
        updateLast((m) => ({ ...m, error: message }))
      }
    } finally {
      updateLast((m) => ({ ...m, streaming: false }))
      abort.current = null
      setBusy(false)
      loadSessions()
    }
  }

  const switchJourney = async (journey: string | null) => {
    if (!current) {
      setBoundJourney(journey ?? undefined)
      return
    }
    try {
      const updated = await api.setChatJourney(current, journey)
      setSessions((ss) => ss.map((s) => (s.id === updated.id ? updated : s)))
    } catch (e) {
      toast(e instanceof Error ? e.message : t('chat.journey.switchFailed'), 'error')
    }
  }

  const startNewJourney = () => {
    setDraft(t('chat.journey.newPrompt'))
    input.current?.focus()
  }

  const today = new Date().toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <Card className="flex min-h-[560px] flex-col overflow-hidden lg:h-[calc(100svh-76px-4rem)]">
      <div className="flex items-center gap-3 border-b border-rose-200 px-5 py-4 sm:px-6">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-forest-950">
          <LogoMark className="size-8" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{t('chat.title')}</p>
          <JourneySwitcher journeys={journeys} value={chatJourney} disabled={busy} onPick={switchJourney} onNew={startNewJourney} />
        </div>
        <Link
          to="/app/explore"
          className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-muted hover:bg-rose-100 hover:text-forest-950"
        >
          <MapIcon className="size-4" aria-hidden /> <span className="hidden sm:inline">{t('chat.whereCanIGo')}</span>
        </Link>
        <History_
          sessions={sessions}
          journeyTitles={Object.fromEntries(journeys.map((j) => [j.id, j.title]))}
          current={current}
          onPick={setCurrent}
          onDelete={async (id) => {
            try {
              await api.deleteChat(id)
              if (id === current) setCurrent(null)
              loadSessions()
            } catch (e) {
              toast(e instanceof Error ? e.message : t('chat.deleteFailed'), 'error')
            }
          }}
        />
        {current && (
          <button
            type="button"
            onClick={() => setCurrent(null)}
            disabled={busy}
            className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-muted hover:bg-rose-100 hover:text-forest-950 disabled:opacity-50"
          >
            <Plus className="size-4" aria-hidden /> <span className="hidden sm:inline">{t('chat.new')}</span>
          </button>
        )}
      </div>

      <div ref={scroller} className="flex-1 overflow-y-auto px-5 py-6 sm:px-9">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> {t('chat.loading')}
          </p>
        ) : messages.length === 0 ? (
          <div className="mx-auto max-w-[560px] py-4">
            <p className="text-xs font-semibold tracking-[0.25em] text-brick-600 uppercase">{today}</p>
            <h1 className="font-display mt-4 text-[26px] leading-tight font-semibold text-forest-950 sm:text-[28px]">
              {t('chat.greeting', { name: user?.firstName ?? '' })}
            </h1>
            <p className="mt-6 text-[15px] text-muted">
              {t('chat.intro')}
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {suggestedQuestions.map((key) => t(key)).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => ask(q)}
                  className="flex items-start gap-3 rounded-2xl border-2 border-rose-200 bg-white p-4 text-left text-sm transition-colors hover:border-brick-600"
                >
                  <Spark className="mt-0.5" />
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-4" aria-live="polite">
            {messages.map((m) =>
              m.role === 'user' ? (
                <li key={m.id} className="animate-fade-in max-w-[85%] self-end rounded-2xl rounded-br-md bg-forest-950 px-4 py-3 text-[15px] whitespace-pre-wrap text-white">
                  {m.text}
                </li>
              ) : (
                <li key={m.id} className="animate-fade-in max-w-[92%] self-start rounded-2xl rounded-bl-md border-2 border-rose-200 bg-blush px-5 py-4 text-[15px]">
                  <Steps steps={m.steps} />
                  {m.text ? (
                    <Markdown remarkPlugins={[remarkGfm]} components={markdown}>
                      {m.text}
                    </Markdown>
                  ) : (
                    m.streaming && !m.steps.some((s) => s.state === 'start') && <p className="text-[13px] text-muted italic">{t('chat.thinking')}</p>
                  )}
                  <RefCards steps={m.steps} journeys={journeys} current={chatJourney?.id} busy={busy} onSwitch={switchJourney} />
                  {m.error && (
                    <p role="alert" className="mt-2 flex items-start gap-2 text-sm text-brick-700">
                      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {m.error}
                    </p>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          ask(draft)
        }}
        className="border-t border-rose-200 px-5 pt-4 pb-3 sm:px-6"
      >
        <div className="flex items-end gap-3">
          <label htmlFor="ask" className="sr-only">
            {t('chat.askLabel')}
          </label>
          <textarea
            ref={input}
            id="ask"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                ask(draft)
              }
            }}
            placeholder={t('chat.placeholder')}
            maxLength={2000}
            className="max-h-40 min-h-12 min-w-0 flex-1 resize-none rounded-2xl border border-rose-200 bg-blush px-4 py-3 text-[15px] placeholder:text-muted outline-none [field-sizing:content] focus:border-forest-950 focus-visible:outline-none"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => abort.current?.abort()}
              aria-label={t('chat.stop')}
              className="grid size-12 shrink-0 place-items-center rounded-2xl bg-forest-950 text-white hover:bg-forest-700"
            >
              <Square className="size-4 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label={t('chat.send')}
              className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brick-600 text-white transition-colors hover:bg-brick-700 disabled:opacity-50"
            >
              <ArrowRight className="size-5" />
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">{t('chat.footer')}</p>
      </form>
    </Card>
  )
}
