import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { BadgeCheck, ChevronDown, CircleAlert, ExternalLink, Loader2, MessageSquareText } from 'lucide-react'
import { buttonClass } from '@/components/ui/button-class'
import { Badge, Card, CardTitle, PageHeader } from '@/components/ui/primitives'
import { useI18n } from '@/i18n'
import * as api from '@/lib/api'
import { assistantUrl, cn, exactMoney, moneyTotals, shortDate } from '@/lib/format'
import { travelPurposes, type CountryVisaDetail, type TravelPurpose } from '@/lib/types'
import { useAuth, useCase } from '@/store/context'
import { FinanceTabs } from './Finances'

type Coverage = Awaited<ReturnType<typeof api.getGuidelineCoverage>>
const selectClass = 'h-12 w-full appearance-none rounded-2xl border-2 border-rose-200 bg-white pr-10 pl-4 text-[15px] outline-none focus:border-forest-950'
const day = (iso: string) => shortDate(iso.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })

/** Official fees for one destination and purpose, from Unbound's verified guidelines only. */
function CountryFees() {
  const { user } = useAuth()
  const { journeys } = useCase()
  const { t, country, locale } = useI18n()
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [dest, setDest] = useState('')
  const [purpose, setPurpose] = useState<TravelPurpose>(user?.travelPurpose ?? 'tourism')
  const [detail, setDetail] = useState<{ for: string; data?: CountryVisaDetail; error?: string } | null>(null)

  useEffect(() => {
    api.getGuidelineCoverage().then(setCoverage, () => setCoverage([]))
  }, [])

  const destinations = useMemo(() => {
    const codes = [...new Set((coverage ?? []).map((c) => c.destination))]
    const collator = new Intl.Collator(locale)
    return codes.sort((a, b) => collator.compare(country(a), country(b)))
  }, [coverage, country, locale])
  const code = dest || destinations[0] || ''
  const purposes = travelPurposes.filter((p) => coverage?.some((c) => c.destination === code && c.purpose === p))
  const chosenPurpose = purposes.includes(purpose) ? purpose : purposes[0]
  const key = `${code}|${chosenPurpose}`

  useEffect(() => {
    if (!code || !chosenPurpose) return
    let cancelled = false
    api.getCountryVisa(code, { purpose: chosenPurpose }).then(
      (data) => !cancelled && setDetail({ for: key, data }),
      (e) => !cancelled && setDetail({ for: key, error: e instanceof Error ? e.message : t('error.generic') }),
    )
    return () => {
      cancelled = true
    }
  }, [code, chosenPurpose, key, t])

  const fresh = detail?.for === key ? detail : null
  const g = fresh?.data?.guideline
  const current = g?.status === 'current'
  const totals = useMemo(() => {
    const out: Record<string, number> = {}
    for (const f of g?.fees ?? []) if (f.mandatory && f.amount) out[f.currency] = (out[f.currency] ?? 0) + Number(f.amount)
    return Object.fromEntries(Object.entries(out).map(([c, a]) => [c, a.toFixed(2)]))
  }, [g])
  const journey = journeys.find((j) => j.destinationCode === code && j.purpose === chosenPurpose && j.status !== 'archived')

  return (
    <Card className="p-6">
      <CardTitle>{t('costs.lookup')}</CardTitle>
      <p className="mt-1 text-[13px] text-muted">{t('costs.lookupSub')}</p>

      {!coverage ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('finances.loading')}
        </p>
      ) : destinations.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{t('costs.noCoverage')}</p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="relative">
              <label htmlFor="fee-dest" className="mb-1.5 block text-sm font-semibold">
                {t('costs.destination')}
              </label>
              <select id="fee-dest" value={code} onChange={(e) => setDest(e.target.value)} className={selectClass}>
                {destinations.map((c) => (
                  <option key={c} value={c}>
                    {country(c)}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-4 bottom-4 size-4" aria-hidden />
            </div>
            <div className="relative">
              <label htmlFor="fee-purpose" className="mb-1.5 block text-sm font-semibold">
                {t('explore.purpose')}
              </label>
              <select id="fee-purpose" value={chosenPurpose} onChange={(e) => setPurpose(e.target.value as TravelPurpose)} className={selectClass}>
                {purposes.map((p) => (
                  <option key={p} value={p}>
                    {t(`explore.purpose.${p}`)}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-4 bottom-4 size-4" aria-hidden />
            </div>
          </div>

          {!fresh ? (
            <p className="mt-5 flex items-center gap-2 text-sm text-muted" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden /> {t('finances.loading')}
            </p>
          ) : fresh.error ? (
            <p className="mt-5 text-sm text-brick-700">{fresh.error}</p>
          ) : !current ? (
            <p className="mt-5 flex items-start gap-2 rounded-xl bg-warn-100 px-3 py-2.5 text-[13px] text-warn-700">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {t('finances.guidelineUpdating', { country: country(code) })}
            </p>
          ) : (
            <>
              <p className="mt-5 text-sm">
                <span className="font-semibold">{g.visaType}</span>
                {g.processingDays?.[1] ? <span className="text-muted"> · {t('costs.processing', { count: g.processingDays[1] })}</span> : null}
              </p>
              {g.fees.length === 0 ? (
                <p className="mt-3 text-sm text-muted">{t('finances.noFees')}</p>
              ) : (
                <ul className="mt-3 divide-y divide-rose-200 border-y border-rose-200">
                  {g.fees.map((f) => (
                    <li key={f.title} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                      <span className="min-w-0">
                        <span className="block font-semibold">{f.title}</span>
                        <span className="block text-xs text-muted">
                          {f.mandatory ? t('finances.required') : t('finances.alternative')}
                          {f.note ? ` · ${f.note}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 font-semibold">{f.amount ? exactMoney(f.amount, f.currency) : t('finances.varies')}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 flex flex-wrap items-end justify-between gap-4 rounded-2xl bg-forest-950 px-5 py-5 text-white">
                <div>
                  <p className="text-[13px] text-rose-300">{t('costs.mandatoryTotal')}</p>
                  <p className="font-display mt-2 text-[30px] leading-none font-semibold">{moneyTotals(totals, '—')}</p>
                  {g.fees.some((f) => !f.mandatory && f.amount) && <p className="mt-2 text-xs text-rose-300">{t('costs.alternativesNote')}</p>}
                </div>
                {journey ? (
                  <Link to="/app/finances" className={buttonClass('accent', 'md')}>
                    {t('costs.payInJourney')}
                  </Link>
                ) : (
                  <Link
                    to={assistantUrl(t('costs.planAsk', { country: country(code), purpose: t(`purpose.${chosenPurpose}`) }))}
                    className={buttonClass('accent', 'md')}
                  >
                    <MessageSquareText className="size-4" aria-hidden /> {t('costs.plan')}
                  </Link>
                )}
              </div>

              <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
                <BadgeCheck className="size-3.5 text-ok-700" aria-hidden />
                {g.verifiedAt && t('finances.verified', { date: day(g.verifiedAt) })}
                {g.sources.slice(0, 2).map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-forest-950">
                    {s.title} <ExternalLink className="size-3" aria-hidden />
                  </a>
                ))}
              </p>
            </>
          )}
        </>
      )}
    </Card>
  )
}

export function CostsPage() {
  const { payments, journeys } = useCase()
  const { t } = useI18n()
  const list = [...payments].sort((a, b) => b.date.localeCompare(a.date))
  const titleOf = (id?: string) => journeys.find((j) => j.id === id)?.title

  return (
    <>
      <PageHeader eyebrow={t('finances.title')} title={t('costs.title')} subtitle={t('costs.subtitle')} />
      <FinanceTabs />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <CountryFees />

        <Card className="p-6">
          <CardTitle>{t('costs.history')}</CardTitle>
          {list.length > 0 ? (
            <table className="mt-4 w-full text-left text-sm">
              <thead>
                <tr className="text-[11px] tracking-[0.15em] text-muted uppercase">
                  <th className="py-2 font-semibold">{t('costs.date')}</th>
                  <th className="py-2 font-semibold">{t('costs.what')}</th>
                  <th className="py-2 text-right font-semibold">{t('costs.amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rose-200 border-t border-rose-200">
                {list.map((p) => (
                  <tr key={p.id}>
                    <td className="py-3.5 pr-3 align-top text-[13px] whitespace-nowrap text-muted">{day(p.date)}</td>
                    <td className="py-3.5 pr-3">
                      <span className="block font-semibold">{p.what}</span>
                      <span className="flex flex-wrap items-center gap-x-2 text-xs">
                        <span className={cn('font-semibold', p.status === 'paid' ? 'text-ok-700' : 'text-warn-700')}>
                          {p.status === 'paid' ? t('costs.paid') : t('costs.upcoming')}
                        </span>
                        {p.journeyId && titleOf(p.journeyId) && (
                          <Link to={`/app/journeys/${p.journeyId}`} className="text-muted underline underline-offset-2 hover:text-forest-950">
                            {titleOf(p.journeyId)}
                          </Link>
                        )}
                      </span>
                    </td>
                    <td className="py-3.5 text-right align-top font-semibold whitespace-nowrap">{exactMoney(p.amount, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-8 text-center text-sm text-muted">{t('costs.empty')}</p>
          )}
          <p className="mt-4 text-xs text-muted">
            <Badge tone="neutral" className="mr-1.5">
              Wise
            </Badge>
            {t('costs.simulated')}
          </p>
        </Card>
      </div>
    </>
  )
}
