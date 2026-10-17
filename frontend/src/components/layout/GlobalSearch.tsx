import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router'
import { Compass, FileText, FileUp, Globe2, ListChecks, MessageSquareText, Plus, Route, Search, Settings, Wallet } from 'lucide-react'
import { statusColor } from '@/components/explore/status'
import { useI18n, type Key } from '@/i18n'
import * as api from '@/lib/api'
import { countryCodes, englishCountryName } from '@/lib/countries'
import { cn } from '@/lib/format'
import type { ChatSessionInfo, VisaStatus } from '@/lib/types'
import { useCase } from '@/store/context'

type Group = 'journeys' | 'forms' | 'chats' | 'documents' | 'tasks' | 'countries' | 'actions'

interface Result {
  group: Group
  label: string
  detail?: string
  to: string
  icon: ComponentType<{ className?: string }>
  /** A coloured dot: the country's visa status for the user's passport. */
  dot?: string
}

const GROUP_LABEL: Record<Group, Key> = {
  journeys: 'search.journeys',
  forms: 'search.forms',
  chats: 'search.chats',
  documents: 'search.documents',
  tasks: 'search.tasks',
  countries: 'search.countries',
  actions: 'search.actions',
}
const PER_GROUP = 4

/** Lower case without accents, so "magyarorszag" finds "Magyarország" and "cote" finds "Côte d’Ivoire". */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()

/** Every word of the query appears somewhere in the text; earlier and whole-word hits rank higher. */
function score(text: string, words: string[]): number {
  const t = fold(text)
  let s = 0
  for (const w of words) {
    const i = t.indexOf(w)
    if (i < 0) return -1
    s += i === 0 ? 3 : /\W/.test(t[i - 1]) ? 2 : 1
  }
  return s
}

/**
 * Search across the user's case (journeys, forms, conversations, documents, tasks), every country with
 * its visa status, and quick actions. Arrow keys move, Enter opens, "/" or Ctrl+K focuses it.
 */
export function GlobalSearch() {
  const { tasks, documents, journeys, forms } = useCase()
  const { t, country } = useI18n()
  const navigate = useNavigate()
  const listId = useId()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  // Loaded on first focus: conversations and the visa status of each country for the user's passport.
  const [chats, setChats] = useState<ChatSessionInfo[]>([])
  const [statuses, setStatuses] = useState<Map<string, VisaStatus>>(new Map())
  const loaded = useRef(false)

  const load = useCallback(() => {
    if (loaded.current) return
    loaded.current = true
    api.listChats().then(setChats, () => {})
    api.getVisaMap().then((m) => setStatuses(new Map(m.countries.map((c) => [c.code, c.status]))), () => {})
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName))
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])

  const results = useMemo<Result[]>(() => {
    const words = fold(q.trim()).split(/\s+/).filter(Boolean)
    if (!words.length) return []
    const pick = (items: (Result & { s: number })[]) =>
      items
        .filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, PER_GROUP)
    const journeyTitle = Object.fromEntries(journeys.map((j) => [j.id, j.title]))

    const actions: Result[] = [
      { group: 'actions', label: t('search.action.plan'), to: '/app?new=1', icon: Plus },
      { group: 'actions', label: t('search.action.upload'), to: '/app/documents?upload=1', icon: FileUp },
      { group: 'actions', label: t('search.action.explore'), to: '/app/explore', icon: Compass },
      { group: 'actions', label: t('search.action.finances'), to: '/app/finances', icon: Wallet },
      { group: 'actions', label: t('search.action.settings'), to: '/app/profile', icon: Settings },
    ]

    return [
      ...pick(
        journeys.map((j) => ({
          group: 'journeys' as const,
          label: j.title,
          detail: `${country(j.destinationCode)} · ${j.visaType}`,
          to: `/app/journeys/${j.id}`,
          icon: Route,
          s: Math.max(score(j.title, words), score(`${country(j.destinationCode)} ${englishCountryName(j.destinationCode)} ${j.visaType}`, words)),
        })),
      ),
      ...pick(
        forms.map((f) => ({
          group: 'forms' as const,
          label: f.title,
          detail: f.journeyId ? journeyTitle[f.journeyId] : undefined,
          to: `/app/forms/${f.id}`,
          icon: FileText,
          s: score(f.title, words),
        })),
      ),
      ...pick(
        chats.map((c) => ({
          group: 'chats' as const,
          label: c.title,
          detail: c.journeyId ? journeyTitle[c.journeyId] : undefined,
          to: `/app?chat=${c.id}`,
          icon: MessageSquareText,
          s: score(c.title, words),
        })),
      ),
      ...pick(
        documents.map((d) => ({
          group: 'documents' as const,
          label: d.title,
          detail: d.fileName,
          to: '/app/documents',
          icon: FileText,
          s: Math.max(score(d.title, words), score(d.fileName, words)),
        })),
      ),
      ...pick(
        tasks
          .filter((x) => !x.done)
          .map((x) => ({
            group: 'tasks' as const,
            label: x.title,
            detail: x.journeyId ? journeyTitle[x.journeyId] : undefined,
            to: x.journeyId ? `/app/journeys/${x.journeyId}` : '/app/todo',
            icon: ListChecks,
            s: score(x.title, words),
          })),
      ),
      ...pick(
        countryCodes.map((c) => {
          const status = statuses.get(c)
          return {
            group: 'countries' as const,
            label: country(c),
            detail: status ? t(`explore.status.${status}`) : undefined,
            dot: status ? statusColor[status] : undefined,
            to: `/app/explore?country=${c}`,
            icon: Globe2,
            s: Math.max(score(country(c), words), score(englishCountryName(c), words), words.length === 1 && words[0] === c.toLowerCase() ? 4 : -1),
          }
        }),
      ),
      ...pick(actions.map((a) => ({ ...a, s: score(a.label, words) }))),
      // Always offer to ask the assistant.
      { group: 'actions', label: t('search.action.ask', { q: q.trim() }), to: `/app?new=1&prompt=${encodeURIComponent(q.trim())}`, icon: MessageSquareText },
    ]
  }, [q, journeys, forms, chats, documents, tasks, statuses, t, country])

  const go = (r: Result) => {
    navigate(r.to)
    setOpen(false)
    setQ('')
    input.current?.blur()
  }

  const shown = open && q.trim().length > 0
  const current = Math.min(active, results.length - 1)

  return (
    <div ref={wrap} className="relative w-full max-w-[432px]">
      <Search className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-forest-950" aria-hidden />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && results[current] ? `${listId}-${current}` : undefined}
        aria-label={t('search.aria')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => {
          load()
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = results.length
            if (n) setActive((current + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
          } else if (e.key === 'Enter' && results[current]) {
            e.preventDefault()
            go(results[current])
          } else if (e.key === 'Escape') {
            setOpen(false)
            input.current?.blur()
          }
        }}
        placeholder={t('search.placeholder')}
        className="h-[42px] w-full rounded-xl border border-rose-300 bg-white pr-12 pl-11 text-[15px] outline-none placeholder:text-muted focus:border-forest-950 focus-visible:outline-none"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded-md border border-rose-200 px-1.5 text-[11px] text-muted sm:block">/</kbd>
      {shown && (
        <ul
          id={listId}
          role="listbox"
          className="animate-pop-in absolute top-[calc(100%+8px)] z-40 max-h-[70vh] w-full overflow-y-auto rounded-2xl border border-rose-200 bg-white py-2 shadow-[0_24px_60px_-20px_rgb(3_16_10/0.35)] sm:w-[480px]"
        >
          {results.map((r, i) => {
            const Icon = r.icon
            const header = i === 0 || results[i - 1].group !== r.group
            return (
              <li key={`${r.group}:${r.to}:${i}`} role="presentation">
                {header && <p className="px-4 pt-2 pb-1 text-[11px] font-semibold text-muted">{t(GROUP_LABEL[r.group])}</p>}
                <button
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === current}
                  type="button"
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                  className={cn('flex w-full items-center gap-3 px-4 py-2 text-left text-sm', i === current && 'bg-blush')}
                >
                  <Icon className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate font-medium">{r.label}</span>
                  {r.detail && (
                    <span className="flex max-w-[45%] shrink-0 items-center gap-1.5 truncate text-xs text-muted">
                      {r.dot && <span className="size-2 shrink-0 rounded-full" style={{ background: r.dot }} aria-hidden />}
                      <span className="truncate">{r.detail}</span>
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
