import { BadgeCheck, Loader2, MessageSquareText, Route, X } from 'lucide-react'
import { Card } from '@/components/ui/primitives'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/format'
import type { DestinationAlternatives } from '@/lib/types'
import { statusColor } from './status'

/**
 * Easier destinations than one the user can't go to (or the easiest overall), ranked by the
 * server: visa-free first, then visa on arrival and e-visa, verified before indicative, nearest first.
 */
export function AlternativesCard({
  insteadOf,
  result,
  selected,
  onPick,
  onAsk,
  onClose,
}: {
  /** The blocked destination, or undefined for "easiest anywhere". */
  insteadOf?: string
  result: { data?: DestinationAlternatives; error?: string } | null
  selected?: string
  onPick: (code: string) => void
  onAsk: (prompt: string) => void
  onClose: () => void
}) {
  const { t, country } = useI18n()
  const list = result?.data?.alternatives ?? []
  const names = list.map((a) => country(a.code)).join(', ')
  const anyIndicative = list.some((a) => a.basis === 'indicative')

  return (
    <Card className="shrink-0 p-5">
      <div className="flex items-start gap-2">
        <Route className="mt-0.5 size-5 shrink-0 text-brick-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] leading-snug font-semibold text-forest-950">
            {insteadOf ? t('explore.alt.title', { country: country(insteadOf) }) : t('explore.alt.titleAny')}
          </h2>
          <p className="mt-0.5 text-xs text-muted">{t('explore.alt.subtitle')}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t('explore.alt.close')} className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-rose-100">
          <X className="size-4" />
        </button>
      </div>

      {!result ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('explore.alt.loading')}
        </p>
      ) : result.error ? (
        <p className="mt-4 text-sm text-brick-700">{result.error}</p>
      ) : list.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{t('explore.alt.none')}</p>
      ) : (
        <>
          <ol className="mt-3 flex flex-col gap-0.5">
            {list.map((a, i) => (
              <li key={a.code}>
                <button
                  type="button"
                  onClick={() => onPick(a.code)}
                  className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-blush', a.code === selected && 'bg-rose-100')}
                >
                  <span className="w-4 shrink-0 text-right text-xs text-muted">{i + 1}</span>
                  <span className="size-2.5 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: statusColor[a.status] }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 truncate font-semibold">
                      {country(a.code)}
                      {a.hasGuideline && <BadgeCheck className="size-3.5 shrink-0 text-ok-700" aria-label={t('explore.alt.verified')} />}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {t(`explore.status.${a.status}`)}
                      {a.stayDays != null && ` · ${t('explore.stayDays', { count: a.stayDays })}`}
                      {a.distanceKm != null && ` · ${t('explore.alt.km', { km: a.distanceKm.toLocaleString() })}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {anyIndicative && <p className="mt-2 rounded-xl bg-warn-100 px-3 py-2 text-xs text-warn-700">{t('explore.alt.indicative')}</p>}
          <button
            type="button"
            onClick={() => onAsk(insteadOf ? t('explore.alt.askPrompt', { country: country(insteadOf), list: names }) : t('explore.alt.askPromptAny', { list: names }))}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-brick-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-brick-700"
          >
            <MessageSquareText className="size-4" aria-hidden /> {t('explore.alt.ask')}
          </button>
        </>
      )}
    </Card>
  )
}
