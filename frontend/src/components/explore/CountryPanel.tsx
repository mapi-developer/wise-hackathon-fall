import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { BadgeCheck, CircleAlert, ExternalLink, Info, Loader2, MessageSquareText, Route, Star, X } from 'lucide-react'
import { Badge } from '@/components/ui/primitives'
import { useI18n, type Key } from '@/i18n'
import * as api from '@/lib/api'
import { cn, shortDate } from '@/lib/format'
import type { CountryVisaDetail } from '@/lib/types'
import { statusColor, statusTone } from './status'

const dateOf = (iso: string) => shortDate(iso.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-rose-200 pt-4">
      <h3 className="text-xs font-semibold tracking-[0.15em] text-forest-950/70 uppercase">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-blush px-3 py-2.5">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mt-0.5 text-sm font-semibold">{value}</p>
    </div>
  )
}

/** Visa details for one destination, for the current passport/residence/purpose. */
export function CountryPanel({
  code,
  query,
  favorite,
  onToggleFavorite,
  onShowAlternatives,
  onClose,
}: {
  code: string
  query: api.ExploreQuery
  favorite: boolean
  onToggleFavorite: () => void
  /** Show easier destinations than this one on the map; offered when entry isn't visa-free. */
  onShowAlternatives?: () => void
  onClose: () => void
}) {
  const { t, tOr, country } = useI18n()
  const navigate = useNavigate()
  const queryKey = JSON.stringify(query)
  const [result, setResult] = useState<{ for: string; detail?: CountryVisaDetail; error?: string } | null>(null)
  const current = `${code}|${queryKey}`

  useEffect(() => {
    let cancelled = false
    api.getCountryVisa(code, JSON.parse(queryKey)).then(
      (detail) => !cancelled && setResult({ for: current, detail }),
      (e) => !cancelled && setResult({ for: current, error: e instanceof Error ? e.message : t('error.generic') }),
    )
    return () => {
      cancelled = true
    }
    // `current` already encodes code and query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])

  const fresh = result?.for === current ? result : null
  const d = fresh?.detail
  const name = country(code)

  const header = (
    // Sticky so Close stays in reach while the panel scrolls (the panel has p-5).
    <div className="sticky -top-5 z-10 -mx-5 -mt-5 flex items-start justify-between gap-3 border-b border-rose-200 bg-white px-5 pt-5 pb-3">
      <div className="min-w-0">
        <h2 className="font-display text-xl leading-tight font-semibold">{name}</h2>
        {d && (
          <Badge tone={statusTone[d.decision.status]} className="mt-2 gap-1.5">
            <span className="size-2 rounded-full" style={{ background: statusColor[d.decision.status] }} aria-hidden />
            {t(`explore.status.${d.decision.status}`)}
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onToggleFavorite}
          aria-pressed={favorite}
          aria-label={favorite ? t('explore.unfavorite', { country: name }) : t('explore.favorite', { country: name })}
          className="grid size-9 place-items-center rounded-full hover:bg-rose-100"
        >
          <Star className={cn('size-5', favorite ? 'fill-brick-600 text-brick-600' : 'text-forest-950/70')} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-forest-950 px-3.5 text-[13px] font-semibold text-white hover:bg-forest-700"
        >
          <X className="size-4" aria-hidden /> {t('common.close')}
        </button>
      </div>
    </div>
  )

  // The panel sits inside the dark globe card: set the text colour here so nothing inherits white.
  if (!fresh)
    return (
      <div className="text-forest-950">
        {header}
        <p className="mt-4 flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('explore.loadingCountry')}
        </p>
      </div>
    )
  if (!d)
    return (
      <div className="text-forest-950">
        {header}
        <p className="mt-4 text-sm text-brick-700">{fresh.error}</p>
      </div>
    )

  const { decision, guideline, indicative, source } = d
  const g = guideline?.status === 'current' ? guideline : undefined
  const purpose = t(`explore.purpose.${d.purpose}`)
  const verified = decision.basis === 'verified' || decision.basis === 'rule' || decision.basis === 'home'
  const basisText =
    decision.basis === 'verified' && g?.verifiedAt
      ? t('explore.basis.verified', { date: dateOf(g.verifiedAt) })
      : decision.basis === 'indicative'
        ? t('explore.basis.indicative', { source: source.title, date: dateOf(source.asOf) })
        : t(`explore.basis.${decision.basis}`)
  const links = g?.officialLinks ?? []
  const ask = d.origin
    ? t('explore.askWithPassport', { passport: country(d.origin), country: name, purpose: t(`purpose.${d.purpose}`) })
    : t('explore.ask', { country: name, purpose: t(`purpose.${d.purpose}`) })

  const facts: [string, string][] = []
  if (decision.stayDays != null) facts.push([t('explore.stay'), t('explore.stayDays', { count: decision.stayDays })])
  if (g) facts.push([t('explore.visaType'), g.visaType])
  if (g?.processingDays) facts.push([t('explore.processing'), t('explore.processingDays', { min: g.processingDays[0] ?? '?', max: g.processingDays[1] ?? '?' })])

  const notes = decision.notes.map((n) => tOr(`explore.note.${n}`, n, { country: name, residence: d.residence ? country(d.residence) : '', purpose }))
  const indicativeText = !g && indicative && decision.basis === 'indicative' ? t(`explore.indicative.${indicative.category}` as Key) : undefined

  return (
    <div className="flex flex-col gap-4 text-sm text-forest-950">
      {header}

      <div className="flex flex-wrap gap-1.5 text-xs">
        <span className="rounded-full bg-rose-100 px-2.5 py-1 font-semibold">
          {d.origin ? t('explore.forPassport', { passport: country(d.origin), purpose }) : t('explore.noPassportShort')}
        </span>
        {d.residence && <span className="rounded-full bg-rose-100 px-2.5 py-1 font-semibold">{t('explore.withResidence', { country: country(d.residence) })}</span>}
      </div>

      {facts.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {facts.map(([label, value]) => (
            <Fact key={label} label={label} value={value} />
          ))}
        </div>
      )}

      {(notes.length > 0 || indicativeText) && (
        <ul className="flex flex-col gap-2">
          {[...notes, ...(indicativeText ? [indicativeText] : [])].map((text) => (
            <li key={text} className="flex items-start gap-2 rounded-xl bg-sage-100 px-3 py-2.5 text-[13px] leading-snug">
              <Info className="mt-0.5 size-4 shrink-0 text-forest-600" aria-hidden />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      )}

      {onShowAlternatives && d.origin && ['visa_required', 'unknown', 'evisa', 'visa_on_arrival'].includes(decision.status) && (
        <button
          type="button"
          onClick={onShowAlternatives}
          className="flex items-center gap-2 rounded-xl border-2 border-rose-200 px-3 py-2.5 text-left text-[13px] font-semibold hover:border-brick-600"
        >
          <Route className="size-4 shrink-0 text-brick-600" aria-hidden />
          <span className="flex-1">{t('explore.alt.show')}</span>
        </button>
      )}

      {g && (
        <Section title={t('explore.conditions')}>
          {g.summary && <p className="text-[13px] leading-relaxed text-muted">{g.summary}</p>}
          {g.requirements.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {g.requirements.map((r) => (
                <li key={r.title} className="flex items-start gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brick-600" aria-hidden />
                  <span>
                    {r.title}
                    {!r.mandatory && <span className="text-muted">{t('plan.optional')}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {g.fees.length > 0 && (
            <ul className="mt-3 divide-y divide-rose-200 rounded-xl border border-rose-200">
              {g.fees.map((f) => (
                <li key={f.title} className="flex justify-between gap-3 px-3 py-2 text-[13px]">
                  <span>{f.title}</span>
                  <span className="shrink-0 font-semibold">{f.amount ? `${f.amount} ${f.currency}` : '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title={t('explore.officialLinks')}>
        {links.length ? (
          <ul className="flex flex-col gap-1.5">
            {links.map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-brick-700 underline underline-offset-2">
                  {l.title} <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] leading-relaxed text-muted">{t('explore.noOfficialLinks')}</p>
        )}
      </Section>

      <Section title={t('explore.sources')}>
        <p className={cn('flex items-start gap-2 rounded-xl px-3 py-2.5 text-[13px] leading-snug', verified ? 'bg-ok-100 text-ok-700' : 'bg-warn-100 text-warn-700')}>
          {verified ? <BadgeCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span>{basisText}</span>
        </p>
        <ul className="mt-2 flex flex-col gap-1.5 text-[13px]">
          {g?.sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-brick-700">
                {s.title} <ExternalLink className="size-3" aria-hidden />
              </a>
            </li>
          ))}
          {indicative && (
            <li>
              <a href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-brick-700">
                {source.title} <ExternalLink className="size-3" aria-hidden />
              </a>
              <span className="block text-xs text-muted">{t('explore.sourceMeta', { date: dateOf(source.asOf), licence: source.licence })}</span>
            </li>
          )}
          {guideline && guideline.status !== 'current' && <li className="text-xs text-muted">{t('explore.guidelineWithheld', { reason: guideline.reason })}</li>}
        </ul>
      </Section>

      <div className="border-t border-rose-200 pt-4">
        <button
          type="button"
          onClick={() => navigate(`/app?new=1&prompt=${encodeURIComponent(ask)}`)}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-brick-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-brick-700"
        >
          <MessageSquareText className="size-4" aria-hidden /> {t('explore.planWithAssistant')}
        </button>
        <p className="mt-3 text-xs leading-relaxed text-muted">{t('explore.disclaimer')}</p>
      </div>
    </div>
  )
}
