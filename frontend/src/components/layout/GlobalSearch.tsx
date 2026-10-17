import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { FileText, Globe2, LayoutGrid, ListChecks, Loader2, MessageSquareText, NotebookPen, Route, Search, type LucideIcon } from 'lucide-react'
import { expiryOf } from '@/components/case/expiry'
import { purposeLabel, statusMeta } from '@/components/case/journey-meta'
import { statusColor } from '@/components/explore/status'
import { profileKey as keyOf, visaMapFor } from '@/components/explore/visa-cache'
import { useI18n, type Key } from '@/i18n'
import { assistantUrl, cn, shortDate } from '@/lib/format'
import type { VisaMap } from '@/lib/types'
import { useAuth, useCase } from '@/store/context'

type Group = 'countries' | 'journeys' | 'documents' | 'tasks' | 'forms' | 'pages' | 'ask'
interface Result {
  group: Group
  id: string
  label: string
  detail?: string
  /** A coloured dot before the detail, e.g. the visa status. */
  dot?: string
  to: string
}

const icons: Record<Group, LucideIcon> = {
  countries: Globe2,
  journeys: Route,
  documents: FileText,
  tasks: ListChecks,
  forms: NotebookPen,
  pages: LayoutGrid,
  ask: MessageSquareText,
}
const groupLabel: Record<Exclude<Group, 'ask'>, Key> = {
  countries: 'search.countries',
  journeys: 'search.journeys',
  documents: 'search.documents',
  tasks: 'search.tasks',
  forms: 'search.forms',
  pages: 'search.pages',
}
const pages: { label: Key; to: string; words?: string }[] = [
  { label: 'nav.assistant', to: '/app', words: 'chat ai help' },
  { label: 'nav.journeys', to: '/app/journeys', words: 'trip plan' },
  { label: 'explore.title', to: '/app/explore', words: 'map globe visa' },
  { label: 'nav.documents', to: '/app/documents', words: 'upload passport' },
  { label: 'nav.finances', to: '/app/finances', words: 'money budget savings fees' },
  { label: 'finances.costsTab', to: '/app/finances/costs', words: 'fees payments pay' },
  { label: 'nav.todo', to: '/app/todo', words: 'tasks' },
  { label: 'nav.profile', to: '/app/profile', words: 'settings account notifications language' },
]
const PER_GROUP = 4

/** Case- and accent-insensitive: "Osterreich" finds "Österreich". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()

/**
 * The top bar search: countries with the user's visa status, journeys, documents, tasks, forms
 * and pages, plus "ask the assistant" for anything else. Arrow keys move, Enter opens, / focuses.
 */
export function GlobalSearch() {
  const { user } = useAuth()
  const { tasks, documents, journeys, forms } = useCase()
  const { t, country } = useI18n()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [map, setMap] = useState<{ key: string; data?: VisaMap; failed?: boolean } | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const profileKey = keyOf(user)

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])

  // "/" or Ctrl/Cmd+K focuses the search from anywhere outside a text field.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])

  // The visa map loads the first time the search opens (and again after the travel profile changes).
  useEffect(() => {
    if (!open || map?.key === profileKey) return
    let cancelled = false
    visaMapFor(profileKey).then(
      (data) => !cancelled && setMap({ key: profileKey, data }),
      () => !cancelled && setMap({ key: profileKey, failed: true }),
    )
    return () => {
      cancelled = true
    }
  }, [open, map?.key, profileKey])

  const english = useMemo(() => new Intl.DisplayNames(['en'], { type: 'region' }), [])
  const visa = map?.key === profileKey ? map.data : undefined
  const mapLoading = open && !!q.trim() && !visa && !map?.failed

  const results = useMemo(() => {
    const term = fold(q.trim())
    if (!term) return []
    const hit = (...fields: (string | undefined)[]) => fields.some((f) => f && fold(f).includes(term))
    const out: Result[] = []

    const countryHits = (visa?.countries ?? [])
      .filter((c) => c.code.toLowerCase() === term || hit(country(c.code), english.of(c.code)))
      // Names that start with the term first ("Ice" → Iceland before Greece's "…ice…").
      .sort((a, b) => Number(!fold(country(a.code)).startsWith(term)) - Number(!fold(country(b.code)).startsWith(term)))
      .slice(0, PER_GROUP)
    for (const c of countryHits) {
      const parts = [t(`explore.status.${c.status}`)]
      if (c.stayDays) parts.push(t('explore.stayDays', { count: c.stayDays }))
      if (c.hasGuideline) parts.push(t('search.guide'))
      out.push({ group: 'countries', id: c.code, label: country(c.code), detail: parts.join(' · '), dot: statusColor[c.status], to: `/app/explore?country=${c.code}` })
    }

    for (const j of journeys.filter((j) => hit(j.title, j.destinationName, country(j.destinationCode), j.visaType)).slice(0, PER_GROUP)) {
      const parts = [t(statusMeta[j.status].label), purposeLabel(j.purpose), t('search.steps', { done: j.progress.done, total: j.progress.total })]
      if (j.travelDate) parts.push(shortDate(j.travelDate, { day: 'numeric', month: 'short', year: 'numeric' }))
      out.push({ group: 'journeys', id: j.id, label: j.title, detail: parts.join(' · '), to: `/app/journeys/${j.id}` })
    }

    for (const d of documents.filter((d) => hit(d.title, d.fileName, d.category, d.analysis?.kind)).slice(0, PER_GROUP))
      out.push({ group: 'documents', id: d.id, label: d.title, detail: `${d.category} · ${expiryOf(d.expiresOn).label}`, to: '/app/documents' })

    for (const x of tasks.filter((x) => hit(x.title)).sort((a, b) => Number(a.done) - Number(b.done)).slice(0, PER_GROUP)) {
      const detail = x.done ? t('search.done') : x.due ? t('search.due', { date: shortDate(x.due) }) : t('search.open')
      out.push({ group: 'tasks', id: x.id, label: x.title, detail, to: x.journeyId ? `/app/journeys/${x.journeyId}` : '/app/todo' })
    }

    for (const f of forms.filter((f) => hit(f.title)).slice(0, PER_GROUP)) {
      const missing = f.fields.filter((x) => x.status === 'missing').length
      out.push({ group: 'forms', id: f.id, label: f.title, detail: missing ? t('search.missing', { count: missing }) : t('search.complete'), to: `/app/forms/${f.id}` })
    }

    for (const p of pages.filter((p) => hit(t(p.label), p.words)).slice(0, PER_GROUP))
      out.push({ group: 'pages', id: p.to, label: t(p.label), to: p.to })

    out.push({ group: 'ask', id: 'ask', label: t('search.ask', { q: q.trim() }), to: assistantUrl(q.trim()) })
    return out
  }, [q, visa, journeys, documents, tasks, forms, t, country, english])

  const go = (r: Result) => {
    navigate(r.to)
    setOpen(false)
    setQ('')
    input.current?.blur()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
      input.current?.blur()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      const n = results.length
      if (n) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault()
      go(results[active])
    }
  }

  const showPanel = open && !!q.trim()
  return (
    <div ref={wrap} className="relative w-full max-w-[480px]">
      <Search className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-forest-950" aria-hidden />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-activedescendant={showPanel && results[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={t('search.placeholder')}
        aria-label={t('search.aria')}
        className="h-[42px] w-full rounded-xl border border-rose-300 bg-white pr-12 pl-11 text-[15px] placeholder:text-muted outline-none focus:border-forest-950 focus-visible:outline-none"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded-md border border-rose-300 px-1.5 text-[11px] text-muted sm:block" aria-hidden>
        /
      </kbd>

      {showPanel && (
        <div className="animate-pop-in absolute top-[calc(100%+8px)] z-40 w-full overflow-hidden rounded-2xl border border-rose-200 bg-white shadow-[0_24px_60px_-20px_rgb(3_16_10/0.35)] sm:w-[min(560px,calc(100vw-2rem))]">
          <ul id={listId} role="listbox" aria-label={t('search.aria')} className="max-h-[min(70svh,520px)] overflow-y-auto py-2">
            {results.map((r, i) => {
              const Icon = icons[r.group]
              const header = r.group !== 'ask' && results[i - 1]?.group !== r.group
              return (
                <li key={`${r.group}-${r.id}`} role="presentation">
                  {header && (
                    <p className="flex items-center gap-2 px-4 pt-2.5 pb-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase" role="presentation">
                      {t(groupLabel[r.group as Exclude<Group, 'ask'>])}
                    </p>
                  )}
                  {r.group === 'ask' && <div className="mx-4 my-1.5 border-t border-rose-200" role="presentation" />}
                  <button
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(r)}
                    className={cn('flex w-full items-center gap-3 px-4 py-2 text-left', i === active && 'bg-blush')}
                  >
                    <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', r.group === 'ask' ? 'bg-brick-600 text-white' : 'bg-rose-100 text-forest-950')}>
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{r.label}</span>
                      {r.detail && (
                        <span className="flex items-center gap-1.5 truncate text-xs text-muted">
                          {r.dot && <span className="size-2 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: r.dot }} aria-hidden />}
                          <span className="truncate">{r.detail}</span>
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {mapLoading && (
            <p className="flex items-center gap-2 border-t border-rose-200 px-4 py-2 text-xs text-muted" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> {t('search.loadingCountries')}
            </p>
          )}
          <p className="hidden border-t border-rose-200 px-4 py-2 text-[11px] text-muted sm:block">{t('search.keys')}</p>
        </div>
      )}
    </div>
  )
}
