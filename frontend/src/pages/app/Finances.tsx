import { useCallback, useEffect, useState } from 'react'
import { Link, NavLink } from 'react-router'
import { ArrowRight, BadgeCheck, CircleAlert, Loader2, MessageSquareText, Plane, Wallet } from 'lucide-react'
import { PayDialog } from '@/components/case/DocumentDialogs'
import { purposeLabel, statusMeta } from '@/components/case/journey-meta'
import { Button } from '@/components/ui/Button'
import { buttonClass } from '@/components/ui/button-class'
import { Badge, Card, CardTitle, PageHeader, Progress } from '@/components/ui/primitives'
import { useI18n } from '@/i18n'
import * as api from '@/lib/api'
import { assistantUrl, cn, exactMoney, money, moneyTotals, shortDate } from '@/lib/format'
import type { FinanceOverview } from '@/lib/types'
import { useAuth, useCase, useToast } from '@/store/context'

export function FinanceTabs() {
  const { t } = useI18n()
  const tab = ({ isActive }: { isActive: boolean }) =>
    cn(
      'relative pb-3 text-[15px] font-semibold transition-colors',
      isActive ? 'text-forest-950 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brick-600' : 'text-muted hover:text-forest-950',
    )
  return (
    <nav aria-label={t('finances.title')} className="mb-6 flex gap-7 border-b border-rose-200">
      <NavLink to="/app/finances" end className={tab}>
        {t('finances.overview')}
      </NavLink>
      <NavLink to="/app/finances/costs" className={tab}>
        {t('finances.costsTab')}
      </NavLink>
    </nav>
  )
}

function Stat({ label, value, sub, dark }: { label: string; value: string; sub: string; dark?: boolean }) {
  return (
    <Card tone={dark ? 'dark' : 'light'} className="px-5 py-4">
      <p className={cn('text-xs font-semibold tracking-[0.12em] uppercase', dark ? 'text-rose-300' : 'text-forest-950/80')}>{label}</p>
      <p className="font-display mt-4 text-[22px] leading-tight font-semibold break-words">{value}</p>
      <p className={cn('mt-2.5 text-[13px]', dark ? 'text-rose-300' : 'text-muted')}>{sub}</p>
    </Card>
  )
}

/** A profile number edited live and saved once the input settles, not on every keystroke. */
function useSavedNumber(key: 'monthlyBudget' | 'savings', onSaved: () => void) {
  const { user, updateUser } = useAuth()
  const { toast } = useToast()
  const { t } = useI18n()
  const saved = user?.[key] ?? 0
  const [value, setValue] = useState(saved)

  useEffect(() => {
    if (value === saved) return
    const timer = setTimeout(() => {
      updateUser({ [key]: value }).then(onSaved, (e) => {
        setValue(saved)
        toast(e instanceof Error ? e.message : t('finances.saveFailed'), 'error')
      })
    }, 600)
    return () => clearTimeout(timer)
  }, [key, value, saved, updateUser, toast, t, onSaved])

  return [value, setValue] as const
}

function EuroInput({ id, label, hint, value, onChange }: { id: string; label: string; hint: string; value: number; onChange: (n: number) => void }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <div className="relative mt-1.5">
        <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-[15px] text-muted">€</span>
        <input
          id={id}
          type="number"
          min={0}
          step={50}
          inputMode="numeric"
          value={value || ''}
          placeholder="0"
          onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0)))}
          className="h-11 w-full rounded-2xl border border-rose-300 bg-white pr-4 pl-9 text-[15px] outline-none focus:border-forest-950"
        />
      </div>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  )
}

type Journey = FinanceOverview['journeys'][number]
type Fee = Journey['finances']['fees']['items'][number]

function JourneyMoney({ j, savings, onPay }: { j: Journey; savings: number; onPay: (j: Journey, fee: Fee) => void }) {
  const { t, country } = useI18n()
  const f = j.finances
  const current = j.guideline.status === 'current'
  const fixed = f.fees.items.filter((x) => x.amount)
  // Alternatives (one per way of applying): once one is paid, the rest aren't needed.
  const paidAlternative = fixed.some((x) => !x.mandatory && x.paid)
  const funds = f.proof_of_funds
  const fundsPct = funds && funds.currency === 'EUR' ? Math.min(100, (savings / Number(funds.required)) * 100) : 0
  const allEur = Object.keys(f.remaining).every((c) => c === 'EUR')
  const toPlan = allEur && f.living_budget_eur ? Number(f.remaining.EUR ?? 0) + Number(f.living_budget_eur) : null

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/app/journeys/${j.id}`} className="font-display text-lg leading-tight font-semibold hover:underline">
            {j.title}
          </Link>
          <p className="mt-1 text-[13px] text-muted">
            {[country(j.destinationCode), j.visaType, purposeLabel(j.purpose), j.travelDate && shortDate(j.travelDate, { day: 'numeric', month: 'short', year: 'numeric' }), j.stayDays && t('explore.stayDays', { count: j.stayDays })]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <Badge tone={statusMeta[j.status].tone}>{t(statusMeta[j.status].label)}</Badge>
      </div>

      {!current && (
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-warn-100 px-3 py-2.5 text-[13px] text-warn-700">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {t('finances.guidelineUpdating', { country: country(j.destinationCode) })}
        </p>
      )}

      {f.fees.items.length > 0 ? (
        <table className="mt-4 w-full text-left text-sm">
          <caption className="sr-only">{t('finances.feesFor', { journey: j.title })}</caption>
          <thead>
            <tr className="text-[11px] tracking-[0.12em] text-muted uppercase">
              <th className="pb-2 font-semibold">{t('finances.fee')}</th>
              <th className="pb-2 text-right font-semibold">{t('costs.amount')}</th>
              <th className="w-[112px] pb-2 text-right font-semibold">
                <span className="sr-only">{t('finances.status')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rose-200 border-t border-rose-200">
            {f.fees.items.map((x) => {
              const skip = !x.mandatory && paidAlternative && !x.paid
              return (
                <tr key={x.key ?? x.title} className={cn(skip && 'opacity-50')}>
                  <td className="py-2.5 pr-3">
                    <span className="block font-semibold">{x.title}</span>
                    <span className="block text-xs text-muted">
                      {x.mandatory ? t('finances.required') : t('finances.alternative')}
                      {x.note ? ` · ${x.note}` : ''}
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-semibold whitespace-nowrap">{x.amount ? exactMoney(x.amount, x.currency) : t('finances.varies')}</td>
                  <td className="py-2.5 pl-3 text-right">
                    {x.paid ? (
                      <Badge tone="ok">{t('costs.paid')}</Badge>
                    ) : x.amount && x.key && current && !skip ? (
                      <Button size="sm" variant={x.mandatory ? 'accent' : 'outline'} onClick={() => onPay(j, x)}>
                        {t('finances.pay')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <p className="mt-4 text-sm text-muted">{current ? t('finances.noFees') : t('finances.feesWithheld')}</p>
      )}

      <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
        {(
          [
            ['jd.officialFees', moneyTotals(f.fees.mandatory_totals)],
            ['jd.paid', moneyTotals(f.paid)],
            ['jd.remaining', moneyTotals(f.remaining)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-xl bg-blush px-3 py-2.5">
            <dt className="text-[11px] text-muted">{t(label)}</dt>
            <dd className="mt-0.5 font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      {Object.keys(f.fees.mandatory_totals).length === 0 && fixed.length > 1 && <p className="mt-2 text-xs text-muted">{t('jd.payOneOf')}</p>}
      {f.fees.amounts_not_fixed.length > 0 && <p className="mt-2 text-xs text-muted">{t('jd.plusVarying', { items: f.fees.amounts_not_fixed.join(', ').toLowerCase() })}</p>}

      {(funds || f.living_budget_eur) && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {funds && (
            <div className="rounded-xl border border-rose-200 px-3.5 py-3">
              <p className="text-xs font-semibold">{t('finances.proofOfFunds')}</p>
              <p className="mt-0.5 text-xs text-muted">{t('jd.fundsRequired', { requirement: funds.requirement, amount: exactMoney(funds.required, funds.currency) })}</p>
              {funds.covered === null ? (
                <p className="mt-2 text-xs text-warn-700">{t('jd.fundsCompare')}</p>
              ) : (
                <>
                  <Progress value={fundsPct} tone={funds.covered ? 'ok' : 'accent'} className="mt-2 h-2" label={t('finances.proofOfFunds')} />
                  <p className={cn('mt-1.5 text-xs font-semibold', funds.covered ? 'text-ok-700' : 'text-brick-700')}>
                    {funds.covered ? t('jd.fundsCovered') : t('jd.fundsShort', { amount: exactMoney(funds.short_by ?? '0', 'EUR') })}
                  </p>
                </>
              )}
            </div>
          )}
          {f.living_budget_eur && (
            <div className="rounded-xl border border-rose-200 px-3.5 py-3">
              <p className="text-xs font-semibold">{t('jd.living', { count: f.stay_months ?? 0 })}</p>
              <p className="font-display mt-1 text-lg font-semibold">{exactMoney(f.living_budget_eur, 'EUR')}</p>
              <p className="text-xs text-muted">{t('finances.livingHow', { budget: money(f.monthly_budget_eur), count: f.stay_months ?? 0 })}</p>
            </div>
          )}
        </div>
      )}

      {toPlan != null && (
        <p className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-forest-950 px-4 py-3 text-sm text-white">
          <span>{t('finances.toPlan')}</span>
          <span className="font-display text-lg font-semibold">{exactMoney(toPlan, 'EUR')}</span>
        </p>
      )}

      <p className="mt-3 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
        {current ? <BadgeCheck className="size-3.5 text-ok-700" aria-hidden /> : null}
        {current && j.guideline.verifiedAt ? t('finances.verified', { date: shortDate(j.guideline.verifiedAt.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' }) }) : null}
        {j.guideline.sources.slice(0, 2).map((s) => (
          <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-forest-950">
            {s.title}
          </a>
        ))}
      </p>
    </Card>
  )
}

export function FinancesPage() {
  const { refresh } = useCase()
  const { t } = useI18n()
  const [data, setData] = useState<{ overview?: FinanceOverview; error?: string } | null>(null)
  const [paying, setPaying] = useState<{ j: Journey; fee: Fee } | null>(null)

  const load = useCallback(() => {
    api.getFinances().then(
      (overview) => setData({ overview }),
      (e) => setData({ error: e instanceof Error ? e.message : t('error.generic') }),
    )
  }, [t])
  useEffect(load, [load])

  const [budget, setBudget] = useSavedNumber('monthlyBudget', load)
  const [savings, setSavings] = useSavedNumber('savings', load)

  const o = data?.overview
  const eurNeeded = o
    ? o.journeys.reduce(
        (sum, j) => {
          const f = j.finances
          if (Object.keys(f.remaining).some((c) => c !== 'EUR')) sum.otherCurrency = true
          sum.fees += Number(f.remaining.EUR ?? 0)
          const funds = f.proof_of_funds
          if (funds?.currency === 'EUR') sum.funds = Math.max(sum.funds, Number(funds.required))
          return sum
        },
        { fees: 0, funds: 0, otherCurrency: false },
      )
    : null
  // Savings must cover the fees still to pay and still show the largest proof-of-funds amount afterwards.
  const need = eurNeeded ? eurNeeded.fees + eurNeeded.funds : 0
  const covered = savings >= need

  return (
    <>
      <PageHeader title={t('finances.title')} subtitle={t('finances.subtitle')} />
      <FinanceTabs />

      {!data ? (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('finances.loading')}
        </p>
      ) : data.error ? (
        <Card className="p-6">
          <p className="text-sm text-brick-700">{data.error}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={load}>
            {t('common.tryAgain')}
          </Button>
        </Card>
      ) : (
        o && (
          <>
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
              <Stat dark label={t('finances.savings')} value={money(savings)} sub={t('finances.savingsSub')} />
              <Stat label={t('finances.toPay')} value={moneyTotals(o.totals.remaining, money(0))} sub={t('finances.toPaySub', { count: o.journeys.length })} />
              <Stat label={t('finances.paid')} value={moneyTotals(o.totals.paid, money(0))} sub={t('finances.paidSub')} />
              <Stat label={t('finances.budget')} value={money(budget)} sub={t('finances.budgetSub')} />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-w-0 flex-col gap-4">
                {o.journeys.length === 0 ? (
                  <Card className="p-8 text-center">
                    <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-rose-100">
                      <Plane className="size-6" aria-hidden />
                    </span>
                    <CardTitle className="mt-4">{t('finances.emptyTitle')}</CardTitle>
                    <p className="mx-auto mt-1 max-w-md text-sm text-muted">{t('finances.emptyBody')}</p>
                    <div className="mt-5 flex flex-wrap justify-center gap-2">
                      <Link to={assistantUrl(t('finances.emptyAsk'))} className={buttonClass('primary', 'md')}>
                        <MessageSquareText className="size-4" aria-hidden /> {t('finances.emptyCta')}
                      </Link>
                      <Link to="/app/finances/costs" className={buttonClass('outline', 'md')}>
                        {t('finances.lookUpFees')}
                      </Link>
                    </div>
                  </Card>
                ) : (
                  o.journeys.map((j) => <JourneyMoney key={j.id} j={j} savings={savings} onPay={(jj, fee) => setPaying({ j: jj, fee })} />)
                )}
              </div>

              <aside className="flex flex-col gap-4">
                <Card className="p-6">
                  <CardTitle>{t('finances.yourMoney')}</CardTitle>
                  <div className="mt-4 flex flex-col gap-4">
                    <EuroInput id="savings" label={t('finances.yourSavings')} hint={t('finances.savingsHint')} value={savings} onChange={setSavings} />
                    <EuroInput id="budget" label={t('finances.budget')} hint={t('finances.budgetHint')} value={budget} onChange={setBudget} />
                  </div>
                </Card>

                {o.journeys.length > 0 && eurNeeded && (
                  <Card className="p-6">
                    <CardTitle>{t('finances.readiness')}</CardTitle>
                    <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
                      <dt className="text-muted">{t('finances.feesLeftEur')}</dt>
                      <dd className="text-right font-semibold">{exactMoney(eurNeeded.fees, 'EUR')}</dd>
                      <dt className="text-muted">{t('finances.largestFunds')}</dt>
                      <dd className="text-right font-semibold">{eurNeeded.funds ? exactMoney(eurNeeded.funds, 'EUR') : '—'}</dd>
                      <dt className="border-t border-rose-200 pt-2 font-semibold">{t('finances.needInTotal')}</dt>
                      <dd className="border-t border-rose-200 pt-2 text-right font-semibold">{exactMoney(need, 'EUR')}</dd>
                    </dl>
                    <Progress value={need ? Math.min(100, (savings / need) * 100) : 100} tone={covered ? 'ok' : 'accent'} className="mt-4 h-2" label={t('finances.readiness')} />
                    <p className={cn('mt-2 text-[13px] font-semibold', covered ? 'text-ok-700' : 'text-brick-700')}>
                      {covered ? t('finances.ready') : t('finances.short', { amount: exactMoney(need - savings, 'EUR') })}
                    </p>
                    {eurNeeded.otherCurrency && <p className="mt-2 text-xs text-muted">{t('finances.otherCurrency')}</p>}
                  </Card>
                )}

                <Link to="/app/finances/costs" className="flex items-center gap-3 rounded-2xl border border-rose-200 bg-white px-5 py-4 text-sm font-semibold hover:border-forest-950">
                  <Wallet className="size-5 shrink-0" aria-hidden />
                  <span className="flex-1">{t('finances.lookUpFees')}</span>
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
                <p className="px-1 text-xs text-muted">{t('finances.exactNote')}</p>
              </aside>
            </div>
          </>
        )
      )}

      <PayDialog
        open={!!paying}
        amount={Number(paying?.fee.amount ?? 0)}
        currency={paying?.fee.currency}
        what={paying ? `${paying.fee.title} · ${paying.j.title}` : ''}
        onClose={() => setPaying(null)}
        onPay={async () => {
          if (!paying?.fee.key) return
          await api.payJourneyFee(paying.j.id, paying.fee.key)
          refresh(['payments', 'journeys'])
          load()
        }}
      />
    </>
  )
}
