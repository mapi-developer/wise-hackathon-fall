import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Route } from 'lucide-react'
import { Chat } from '@/components/chat/Chat'
import { Badge, Card, CardTitle, DateTile, Progress } from '@/components/ui/primitives'
import { expiryOf } from '@/components/case/expiry'
import { statusMeta } from '@/components/case/journey-meta'
import { useI18n } from '@/i18n'
import { daysUntil, relativeDays, shortDate } from '@/lib/format'
import { useCase } from '@/store/context'

export function AssistantPage() {
  const [params] = useSearchParams()
  const { tasks, documents, journeys } = useCase()
  const { t, tOr, language } = useI18n()
  // The journey the open conversation is about: the side panel follows it.
  const [focusId, setFocusId] = useState<string>()
  const focus = journeys.find((j) => j.id === focusId)
  const others = journeys.filter((j) => j.id !== focusId && (j.status === 'planning' || j.status === 'active'))
  const focusSteps = focus ? tasks.filter((x) => x.journeyId === focus.id && !x.done).slice(0, 3) : []
  const upcoming = tasks
    .filter((x) => !focus || x.journeyId === focus.id)
    .filter((t) => !t.done && t.due && daysUntil(t.due) >= 0)
    .sort((a, b) => a.due!.localeCompare(b.due!))
    .slice(0, 4)
  const renew = documents
    .filter((d) => ['expired', 'soon'].includes(expiryOf(d.expiresOn).state))
    .sort((a, b) => a.expiresOn!.localeCompare(b.expiresOn!))[0]
  const nextTask = upcoming[0]

  // The single most urgent real thing: an expiring document, the next deadline, or getting started.
  const next = renew
    ? {
        title: t('assistant.renew.title', { doc: language === 'EN' ? renew.title.toLowerCase() : renew.title }),
        body: t('assistant.renew.body', { expiry: expiryOf(renew.expiresOn).label }),
        to: '/app/documents',
        cta: t('assistant.renew.cta'),
      }
    : nextTask
      ? {
          title: nextTask.title,
          body: t('assistant.task.body', { date: shortDate(nextTask.due!, { weekday: 'short', day: 'numeric', month: 'short' }), relative: relativeDays(nextTask.due!) }),
          to: '/app/todo',
          cta: t('assistant.task.cta'),
        }
      : documents.length === 0
        ? { title: t('assistant.first.title'), body: t('assistant.first.body'), to: '/app/documents', cta: t('assistant.first.cta') }
        : { title: t('assistant.plan.title'), body: t('assistant.plan.body'), to: '/app/todo', cta: t('assistant.plan.cta') }

  return (
    // Increased right column width (e.g., 320px / 340px) to make the panel wider
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_340px]">
      <Chat journeyId={params.get('journey') ?? undefined} openChatId={params.get('chat') ?? undefined} initialPrompt={params.get('prompt') ?? undefined} fresh={params.has('new')} onJourneyChange={setFocusId} key={params.get('new') ? `new-${params.get('new')}` : 'chat'} />

      {/* Added w-full so the aside container spans the full width of its grid column */}
      <aside className="flex w-full flex-col gap-4">
        {focus && (
          <Card className="w-full p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-[0.2em] text-brick-600 uppercase">{t('assistant.thisJourney')}</p>
                <h2 className="mt-1 truncate text-[17px] font-semibold">{focus.title}</h2>
              </div>
              <Badge tone={statusMeta[focus.status].tone}>{t(statusMeta[focus.status].label)}</Badge>
            </div>
            <Progress value={focus.progress.total ? (focus.progress.done / focus.progress.total) * 100 : 0} className="mt-4" label={t('journeys.progressOf', { title: focus.title })} />
            <p className="mt-2 text-[13px] text-muted">{t('journeys.stepsDone', { done: focus.progress.done, total: focus.progress.total })}</p>
            {focusSteps.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1.5 text-sm">
                {focusSteps.map((x) => (
                  <li key={x.id} className="flex items-start gap-2">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brick-600" aria-hidden />
                    <span className="min-w-0">
                      {x.title}
                      {x.due && <span className="text-muted"> · {relativeDays(x.due)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Link to={`/app/journeys/${focus.id}`} className="mt-4 inline-flex text-[13px] font-semibold underline underline-offset-2">
              {t('chat.card.openPlan')}
            </Link>
          </Card>
        )}

        {!focus && (
        <Card tone="dark" className="w-full p-6">
          <Badge tone="accent" className="h-[22px] text-[11px]">
            {t('assistant.nextStep')}
          </Badge>
          <h2 className="mt-3 text-lg leading-snug font-semibold">{next.title}</h2>
          <p className="mt-4 text-[13px] text-rose-300">{next.body}</p>
          <Link to={next.to} className="mt-5 inline-flex h-9 items-center rounded-full bg-brick-600 px-6 text-[13px] font-semibold hover:bg-brick-700">
            {next.cta}
          </Link>
        </Card>
        )}

        {others.length > 0 && (
          <Card className="w-full p-6">
            <div className="mb-3 flex items-center justify-between">
              <CardTitle>{focus ? t('assistant.otherJourneys') : t('assistant.yourJourneys')}</CardTitle>
              <Link to="/app/journeys" className="text-[13px] font-semibold underline underline-offset-2">
                {t('assistant.allJourneys')}
              </Link>
            </div>
            <ul className="flex flex-col gap-1">
              {others.slice(0, 4).map((j) => (
                <li key={j.id}>
                  <Link to={`/app/journeys/${j.id}`} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-blush">
                    <Route className="size-4 shrink-0 text-brick-600" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{j.title}</span>
                      <span className="text-xs text-muted">{t('journeys.stepsDone', { done: j.progress.done, total: j.progress.total })}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">{t('assistant.switchHint')}</p>
          </Card>
        )}

        <Card className="w-full p-6">
          <div className="mb-4 flex items-center justify-between">
            <CardTitle>{t('assistant.comingUp')}</CardTitle>
            <Link to="/app/todo" className="text-[13px] font-semibold underline underline-offset-2">
              {t('assistant.allTasks')}
            </Link>
          </div>
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted">{t('assistant.noDeadlines')}</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {upcoming.map((task) => (
                <li key={task.id} className="flex items-center gap-3.5">
                  <DateTile iso={task.due!} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{task.title}</p>
                    <p className="text-xs text-muted">
                      {tOr(`taskCategory.${task.category}`, task.category)} · {relativeDays(task.due!)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </aside>
    </div>
  )
}