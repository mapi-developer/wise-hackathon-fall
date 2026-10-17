import { Component, lazy, Suspense, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { ChevronDown, Loader2, Search, Star } from 'lucide-react'
import { CountryPanel } from '@/components/explore/CountryPanel'
import { centreOf, loadCountries, regions, regionView, type CountryFeature, type Region } from '@/components/explore/geo'
import { statusColor } from '@/components/explore/status'
import { Card, CardTitle, Field, PageHeader, Segmented } from '@/components/ui/primitives'
import { useI18n } from '@/i18n'
import * as api from '@/lib/api'
import { cn } from '@/lib/format'
import { travelPurposes, visaStatuses, type TravelPurpose, type VisaAlternative, type VisaMap, type VisaStatus } from '@/lib/types'
import { useAuth, useToast } from '@/store/context'

const GlobeView = lazy(() => import('@/components/explore/GlobeView'))

/** Shown instead of the globe when WebGL isn't available; search and the list still work. */
class GlobeBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** A card whose body opens and closes; one at a time keeps the sidebar within the screen. */
function Panel({ title, badge, open, onToggle, children }: { title: string; badge?: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId()
  return (
    <Card className="shrink-0">
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={id} className="flex w-full items-center gap-2 px-5 py-4 text-left">
        <span className="flex-1 text-[17px] font-semibold text-forest-950">{title}</span>
        {badge && <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold">{badge}</span>}
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div id={id} className="animate-fade-in px-5 pb-5">
          {children}
        </div>
      )}
    </Card>
  )
}

const selectClass = 'h-11 w-full rounded-2xl border border-rose-300 bg-white px-3 text-[15px] outline-none focus:border-forest-950'

export function ExplorePage() {
  const { user, updateUser } = useAuth()
  const { toast } = useToast()
  const { t, country, locale } = useI18n()
  const [params, setParams] = useSearchParams()
  const selected = params.get('country') ?? undefined

  // Overrides for "what if" exploring; unset values come from the profile on the server.
  const [query, setQuery] = useState<api.ExploreQuery>({})
  const [map, setMap] = useState<{ for: string; data?: VisaMap; error?: string } | null>(null)
  const [features, setFeatures] = useState<CountryFeature[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [shown, setShown] = useState<Set<VisaStatus>>(() => new Set([...visaStatuses, 'home']))
  const [region, setRegion] = useState<Region | 'all'>('all')
  const [search, setSearch] = useState('')
  const [focus, setFocus] = useState<{ lat: number; lng: number; altitude: number }>()
  const [saving, setSaving] = useState(false)
  const [openPanel, setOpenPanel] = useState<'filters' | 'destinations' | null>(null)
  const [listTab, setListTab] = useState<'easy' | 'all' | 'saved'>('easy')
  // Alternatives to the open country, for the globe arcs; tagged with the country they belong to.
  const [alts, setAlts] = useState<{ for: string; list: VisaAlternative[] } | null>(null)

  const queryKey = JSON.stringify(query)
  useEffect(() => {
    let cancelled = false
    api.getVisaMap(JSON.parse(queryKey)).then(
      (data) => !cancelled && setMap({ for: queryKey, data }),
      (e) => !cancelled && setMap({ for: queryKey, error: e instanceof Error ? e.message : t('error.generic') }),
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey])

  useEffect(() => {
    loadCountries().then(setFeatures, () => toast(t('explore.shapesFailed'), 'error'))
    api.listFavorites().then(setFavorites, () => {})
    // once per visit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const data = map?.data
  const loading = !map || map.for !== queryKey
  const decisions = useMemo(() => new Map(data?.countries.map((c) => [c.code, c])), [data])
  const featureOf = useMemo(() => new Map(features.map((f) => [f.properties.code, f])), [features])
  const statusOf = useCallback((code: string): VisaStatus => decisions.get(code)?.status ?? 'unknown', [decisions])
  const regionOf = useCallback((code: string) => featureOf.get(code)?.properties.region, [featureOf])
  const visible = useCallback(
    (code: string) => shown.has(statusOf(code)) && (region === 'all' || regionOf(code) === region),
    [shown, statusOf, region, regionOf],
  )

  const counts = useMemo(() => {
    const c = Object.fromEntries([...visaStatuses, 'home'].map((s) => [s, 0])) as Record<VisaStatus, number>
    for (const d of data?.countries ?? []) if (region === 'all' || regionOf(d.code) === region) c[d.status]++
    return c
  }, [data, region, regionOf])

  const collator = useMemo(() => new Intl.Collator(locale), [locale])
  const allCodes = useMemo(() => [...new Set([...(data?.countries.map((c) => c.code) ?? []), ...featureOf.keys()])], [data, featureOf])
  const matching = useMemo(() => {
    const q = search.trim().toLocaleLowerCase(locale)
    return allCodes
      .filter((c) => (q ? country(c).toLocaleLowerCase(locale).includes(q) || c.toLowerCase() === q : visible(c)))
      .sort((a, b) => collator.compare(country(a), country(b)))
  }, [allCodes, search, visible, country, collator, locale])

  // Visa-free first, then on arrival, then eVisa; longer stays first. Mirrors explore.easiest on the server.
  const easiest = useMemo(() => {
    const ease: Partial<Record<VisaStatus, number>> = { visa_free: 0, visa_on_arrival: 1, evisa: 2 }
    return (data?.countries ?? [])
      .filter((c) => ease[c.status] != null && (region === 'all' || regionOf(c.code) === region) && featureOf.has(c.code))
      .sort((a, b) => ease[a.status]! - ease[b.status]! || (b.stayDays ?? 0) - (a.stayDays ?? 0) || collator.compare(country(a.code), country(b.code)))
  }, [data, region, regionOf, featureOf, collator, country])

  const shownAlts = useMemo(() => (alts && alts.for === selected ? alts.list : []), [alts, selected])
  const highlighted = useMemo(() => new Set(shownAlts.map((a) => a.code)), [shownAlts])
  const arcs = useMemo(() => {
    const from = selected && featureOf.get(selected)
    if (!from) return []
    const start = centreOf(from)
    return shownAlts.flatMap((a) => {
      const f = featureOf.get(a.code)
      return f ? [{ from: start, to: centreOf(f), color: statusColor[a.status] }] : []
    })
  }, [shownAlts, selected, featureOf])

  const select = (code: string | undefined) => {
    setParams((p) => {
      if (code) p.set('country', code)
      else p.delete('country')
      return p
    })
    const f = code && featureOf.get(code)
    if (f) setFocus({ ...centreOf(f), altitude: 1.6 })
  }

  const toggleFavorite = async (code: string) => {
    const on = favorites.includes(code)
    setFavorites((fs) => (on ? fs.filter((c) => c !== code) : [code, ...fs]))
    try {
      await (on ? api.removeFavorite(code) : api.addFavorite(code))
    } catch (e) {
      setFavorites((fs) => (on ? [code, ...fs] : fs.filter((c) => c !== code)))
      toast(e instanceof Error ? e.message : t('error.generic'), 'error')
    }
  }

  // Current choices vs what's saved on the profile.
  const origin = data?.origin ?? ''
  const residence = data?.residence ?? ''
  const purpose: TravelPurpose = data?.purpose ?? user?.travelPurpose ?? 'tourism'
  const unsaved = !!user && !!data && (origin !== user.nationalityCode || residence !== user.residenceCode || purpose !== user.travelPurpose)

  const saveToProfile = async () => {
    setSaving(true)
    try {
      await updateUser({ nationalityCode: origin, residenceCode: residence, travelPurpose: purpose })
      setQuery({})
      toast(t('explore.saved'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : t('error.generic'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const countryOptions = (codes: string[]) =>
    [...codes]
      .sort((a, b) => collator.compare(country(a), country(b)))
      .map((c) => (
        <option key={c} value={c}>
          {country(c)}
        </option>
      ))

  const legend = [...visaStatuses, 'home'] as VisaStatus[]
  const globeFallback = <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-sky-100">{t('explore.noWebgl')}</p>

  return (
    // Fills the viewport under the top bar (main has 2rem padding top and bottom on lg): no page scroll.
    <div className="flex flex-col lg:h-[calc(100svh-76px-4rem)]">
      <PageHeader
        eyebrow={data?.origin ? t('explore.eyebrow', { passport: country(data.origin) }) : undefined}
        title={t('explore.title')}
        subtitle={t('explore.subtitle')}
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card tone="dark" className="relative flex min-h-0 flex-col overflow-hidden bg-[radial-gradient(ellipse_at_center,#12304d_0%,#071628_60%,#040b15_100%)]">
          <div className="relative h-[420px] min-h-0 sm:h-[520px] lg:h-auto lg:flex-1">
            {/* With a country open, slide the globe left by half the panel (360px + 12px gap) so it stays centred in the free space. */}
            <div className={cn('absolute inset-0 transition-transform duration-500 ease-out', selected && 'lg:-translate-x-[186px]')}>
              <GlobeBoundary fallback={globeFallback}>
                <Suspense
                  fallback={
                    <p className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-sky-100" role="status">
                      <Loader2 className="size-4 animate-spin" aria-hidden /> {t('explore.loadingGlobe')}
                    </p>
                  }
                >
                  {features.length > 0 && (
                    <GlobeView
                      features={features}
                      colorOf={(c) => statusColor[statusOf(c)]}
                      dimmed={(c) => !visible(c)}
                      labelOf={(c) => [country(c), t(`explore.status.${statusOf(c)}`)]}
                      selected={selected}
                      highlighted={highlighted}
                      arcs={arcs}
                      focus={focus}
                      onSelect={select}
                    />
                  )}
                </Suspense>
              </GlobeBoundary>
            </div>

            {loading && (
              <p className="absolute top-4 left-4 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs text-sky-100" role="status">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> {t('explore.loadingMap')}
              </p>
            )}
            {map?.error && !loading && <p className="absolute top-4 left-4 rounded-xl bg-brick-600 px-3 py-2 text-xs text-white">{map.error}</p>}

            <ul className="pointer-events-none absolute bottom-4 left-4 flex max-w-[calc(100%-2rem)] flex-wrap gap-1.5" aria-hidden>
              {legend.map((s) => (
                <li key={s} className={cn('flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 text-[11px] text-white', !shown.has(s) && 'opacity-40')}>
                  <span className="size-2.5 rounded-full" style={{ background: statusColor[s] }} />
                  {t(`explore.status.${s}`)}
                </li>
              ))}
            </ul>
            <p className="pointer-events-none absolute top-4 right-4 hidden text-[11px] text-sky-100/70 sm:block">{t('explore.hint')}</p>

            {selected && (
              // Floats over the globe on large screens so the globe keeps its size; below it on small ones.
              <div className="bg-white p-5 text-forest-950 lg:absolute lg:inset-y-3 lg:right-3 lg:w-[360px] lg:overflow-y-auto lg:rounded-2xl lg:shadow-[0_24px_60px_-20px_rgb(0_0_0/0.6)]">
                <CountryPanel
                  key={selected}
                  code={selected}
                  query={query}
                  favorite={favorites.includes(selected)}
                  onToggleFavorite={() => toggleFavorite(selected)}
                  onClose={() => select(undefined)}
                  onSelectCountry={select}
                  onLoaded={(d) => setAlts({ for: d.decision.code, list: d.alternatives })}
                />
              </div>
            )}
          </div>
        </Card>

        <aside className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto">
          <Card className="p-5">
            <CardTitle>{t('explore.profile')}</CardTitle>
            <p className="mt-1 text-[13px] text-muted">{t(`explore.originSource.${data?.originSource ?? 'none'}`)}</p>
            <div className="mt-4 flex flex-col gap-3">
              <Field label={t('explore.passport')} htmlFor="ex-origin">
                <select id="ex-origin" className={selectClass} value={origin} onChange={(e) => setQuery((q) => ({ ...q, origin: e.target.value || undefined }))}>
                  <option value="">{t('explore.choosePassport')}</option>
                  {countryOptions(data?.passports ?? [])}
                </select>
              </Field>
              <Field label={t('explore.residence')} htmlFor="ex-residence" hint={t('explore.residenceHint')}>
                <select id="ex-residence" className={selectClass} value={residence} onChange={(e) => setQuery((q) => ({ ...q, residence: e.target.value }))}>
                  <option value="">{t('explore.noResidence')}</option>
                  {countryOptions(data?.passports ?? [])}
                </select>
              </Field>
              <Field label={t('explore.purpose')} htmlFor="ex-purpose">
                <select id="ex-purpose" className={selectClass} value={purpose} onChange={(e) => setQuery((q) => ({ ...q, purpose: e.target.value as TravelPurpose }))}>
                  {travelPurposes.map((p) => (
                    <option key={p} value={p}>
                      {t(`explore.purpose.${p}`)}
                    </option>
                  ))}
                </select>
              </Field>
              {purpose !== 'tourism' && <p className="rounded-xl bg-warn-100 px-3 py-2 text-xs text-warn-700">{t('explore.purposeNote')}</p>}
              {unsaved && (
                <button type="button" onClick={saveToProfile} disabled={saving} className="self-start text-[13px] font-semibold underline underline-offset-2 disabled:opacity-50">
                  {saving ? t('upload.saving') : t('explore.saveToProfile')}
                </button>
              )}
            </div>
          </Card>

          <Panel
            title={t('explore.filters')}
            badge={shown.size < legend.length || region !== 'all' ? t('explore.filtersActive') : undefined}
            open={openPanel === 'filters'}
            onToggle={() => setOpenPanel(openPanel === 'filters' ? null : 'filters')}
          >
            <fieldset>
              <legend className="text-sm font-semibold">{t('explore.visaType')}</legend>
              <ul className="mt-2 flex flex-col gap-0.5">
                {legend.map((s) => (
                  <li key={s}>
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1 text-sm hover:bg-blush">
                      <input
                        type="checkbox"
                        checked={shown.has(s)}
                        onChange={() =>
                          setShown((prev) => {
                            const next = new Set(prev)
                            if (next.has(s)) next.delete(s)
                            else next.add(s)
                            return next
                          })
                        }
                        className="size-4 accent-forest-950"
                      />
                      <span className="size-3 rounded-full ring-1 ring-black/10" style={{ background: statusColor[s] }} aria-hidden />
                      <span className="flex-1">{t(`explore.status.${s}`)}</span>
                      <span className="text-xs text-muted">{counts[s]}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <div className="mt-3">
              <Field label={t('explore.region')} htmlFor="ex-region">
                <select
                  id="ex-region"
                  className={selectClass}
                  value={region}
                  onChange={(e) => {
                    const r = e.target.value as Region | 'all'
                    setRegion(r)
                    setFocus(r === 'all' ? { lat: 25, lng: 15, altitude: 2.6 } : regionView[r])
                  }}
                >
                  <option value="all">{t('explore.allRegions')}</option>
                  {regions.map((r) => (
                    <option key={r} value={r}>
                      {t(`explore.region.${r}`)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </Panel>

          <Panel
            title={t('explore.destinations')}
            badge={favorites.length ? t('explore.savedCount', { count: favorites.length }) : undefined}
            open={openPanel === 'destinations'}
            onToggle={() => setOpenPanel(openPanel === 'destinations' ? null : 'destinations')}
          >
            <Segmented
              label={t('explore.destinations')}
              value={listTab}
              onChange={setListTab}
              options={[
                { value: 'easy', label: t('explore.easiestTab') },
                { value: 'all', label: t('explore.matching', { count: matching.length }) },
                { value: 'saved', label: t('explore.savedCount', { count: favorites.length }) },
              ]}
            />
            {listTab === 'easy' ? (
              <>
                <p className="mt-3 text-xs text-muted">{t('explore.easiestHint')}</p>
                {easiest.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">{data?.origin ? t('explore.easiestNone') : t('explore.note.no_passport')}</p>
                ) : (
                  <ol className="mt-2 max-h-56 overflow-y-auto">
                    {easiest.map((c, i) => (
                      <li key={c.code}>
                        <button
                          type="button"
                          onClick={() => select(c.code)}
                          className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-blush', c.code === selected && 'bg-rose-100 font-semibold')}
                        >
                          <span className="w-5 shrink-0 text-right text-xs text-muted">{i + 1}</span>
                          <span className="size-2.5 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: statusColor[c.status] }} aria-hidden />
                          <span className="flex-1 truncate">{country(c.code)}</span>
                          <span className="shrink-0 text-xs text-muted">{c.stayDays ? t('explore.stayDays', { count: c.stayDays }) : t(`explore.status.${c.status}`)}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            ) : listTab === 'all' ? (
              <>
                <label htmlFor="ex-search" className="sr-only">
                  {t('explore.search')}
                </label>
                <div className="relative mt-3">
                  <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
                  <input
                    id="ex-search"
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && matching[0] && select(matching[0])}
                    placeholder={t('explore.searchPlaceholder')}
                    className="h-11 w-full rounded-2xl border border-rose-300 bg-white pr-3 pl-10 text-[15px] outline-none focus:border-forest-950"
                  />
                </div>
                <ul className="mt-2 max-h-56 overflow-y-auto">
                  {matching.map((c) => (
                    <li key={c}>
                      <button
                        type="button"
                        onClick={() => select(c)}
                        className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-blush', c === selected && 'bg-rose-100 font-semibold')}
                      >
                        <span className="size-2.5 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: statusColor[statusOf(c)] }} aria-hidden />
                        <span className="flex-1 truncate">{country(c)}</span>
                        <span className="shrink-0 text-xs text-muted">{t(`explore.status.${statusOf(c)}`)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : favorites.length === 0 ? (
              <p className="mt-3 text-sm text-muted">{t('explore.noFavorites')}</p>
            ) : (
              <ul className="mt-2 max-h-56 overflow-y-auto">
                {favorites.map((c) => (
                  <li key={c} className="flex items-center gap-1">
                    <button type="button" onClick={() => select(c)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-blush">
                      <span className="size-2.5 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: statusColor[statusOf(c)] }} aria-hidden />
                      <span className="flex-1 truncate font-semibold">{country(c)}</span>
                      <span className="shrink-0 text-xs text-muted">{t(`explore.status.${statusOf(c)}`)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleFavorite(c)}
                      aria-label={t('explore.unfavorite', { country: country(c) })}
                      className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-rose-100"
                    >
                      <Star className="size-4 fill-brick-600 text-brick-600" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {data && (
            <p className="px-2 text-xs text-muted">
              {t('explore.footer', { source: data.source.title })}{' '}
              <a href={data.source.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                {t('explore.sourceLink')}
              </a>
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}
