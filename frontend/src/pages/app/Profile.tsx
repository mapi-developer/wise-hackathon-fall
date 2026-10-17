import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { Bell, Globe2, Languages, ShieldCheck, Wallet, type LucideIcon } from 'lucide-react'
import { Flag } from '@/components/brand/Flag'
import { profileKey, visaMapFor } from '@/components/explore/visa-cache'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Avatar, Card, CardTitle, Field, Input, PageHeader, Toggle } from '@/components/ui/primitives'
import { languages, useI18n, type Key } from '@/i18n'
import { cn, money } from '@/lib/format'
import { travelPurposes, type ProfilePatch, type Settings, type TravelPurpose, type User } from '@/lib/types'
import { useAuth, useCase, useToast } from '@/store/context'

const fields: { key: keyof ProfilePatch & keyof User; label: Key; placeholder: Key }[] = [
  { key: 'fullName', label: 'profile.field.fullName', placeholder: 'profile.field.fullName.ph' },
  { key: 'citizenship', label: 'profile.field.citizenship', placeholder: 'profile.field.citizenship.ph' },
  { key: 'passport', label: 'profile.field.passport', placeholder: 'profile.field.passport.ph' },
  { key: 'address', label: 'profile.field.address', placeholder: 'profile.field.address.ph' },
  { key: 'residenceStatus', label: 'profile.field.residenceStatus', placeholder: 'profile.field.residenceStatus.ph' },
  { key: 'studies', label: 'profile.field.studies', placeholder: 'profile.field.studies.ph' },
]

function SettingRow({ k, title, hint }: { k: keyof Settings; title: string; hint?: string }) {
  const { settings, setSetting } = useAuth()
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div>
        <p className="text-[15px] font-semibold">{title}</p>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      <Toggle checked={settings[k]} onChange={(v) => setSetting(k, v)} label={title} />
    </div>
  )
}

function EditDialog({ open, onClose, user }: { open: boolean; onClose: () => void; user: User }) {
  const { updateUser } = useAuth()
  const { toast } = useToast()
  const [form, setForm] = useState(() => Object.fromEntries(fields.map((f) => [f.key, String(user[f.key] ?? '')])) as Record<string, string>)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { t } = useI18n()

  return (
    <Dialog open={open} onClose={() => !saving && onClose()} title={t('profile.edit')} description={t('profile.editDescription')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setSaving(true)
          setError(null)
          try {
            await updateUser(form as ProfilePatch)
            toast(t('profile.saved'), 'success')
            onClose()
          } catch (err) {
            setError(err instanceof Error ? err.message : t('profile.saveFailed'))
          } finally {
            setSaving(false)
          }
        }}
      >
        {fields.map((f) => (
          <Field key={f.key} label={t(f.label)} htmlFor={`ed-${f.key}`}>
            <Input
              id={`ed-${f.key}`}
              value={form[f.key]}
              placeholder={t(f.placeholder)}
              required={f.key === 'fullName'}
              maxLength={f.key === 'fullName' ? 120 : 200}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          </Field>
        ))}
        {error && (
          <p role="alert" className="rounded-xl bg-rose-100 px-4 py-3 text-sm text-brick-700">
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={saving}>
            {t('profile.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** A titled block inside the settings panel. */
function SettingsSection({ id, icon: Icon, title, hint, children }: { id: string; icon: LucideIcon; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-rose-200 px-6 py-5 first:border-t-0">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-rose-100" aria-hidden>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h3 id={id} className="text-[15px] font-semibold">
            {title}
          </h3>
          {hint && <p className="text-xs text-muted">{hint}</p>}
        </div>
      </div>
      <div className="mt-3 sm:pl-11">{children}</div>
    </section>
  )
}

const selectClass = 'h-11 w-full rounded-2xl border border-rose-300 bg-white px-3 text-[15px] outline-none focus:border-forest-950 disabled:opacity-60'

/** Passport, residence permit and purpose: what the map, search and assistant personalise with. */
function TravelSettings({ user }: { user: User }) {
  const { updateUser } = useAuth()
  const { toast } = useToast()
  const { t, country, locale } = useI18n()
  const [passports, setPassports] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    visaMapFor(profileKey(user)).then((m) => setPassports(m.passports), () => {})
  }, [user])

  const options = useMemo(() => {
    const collator = new Intl.Collator(locale)
    const codes = new Set(passports)
    for (const c of [user.nationalityCode, user.residenceCode]) if (c) codes.add(c)
    return [...codes].sort((a, b) => collator.compare(country(a), country(b)))
  }, [passports, user.nationalityCode, user.residenceCode, country, locale])

  const save = async (patch: ProfilePatch) => {
    setSaving(true)
    try {
      await updateUser(patch)
      toast(t('profile.saved'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : t('profile.saveFailed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label={t('explore.passport')} htmlFor="set-passport">
        <select id="set-passport" className={selectClass} disabled={saving} value={user.nationalityCode} onChange={(e) => save({ nationalityCode: e.target.value })}>
          <option value="">{t('explore.choosePassport')}</option>
          {options.map((c) => (
            <option key={c} value={c}>
              {country(c)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('explore.residence')} htmlFor="set-residence">
        <select id="set-residence" className={selectClass} disabled={saving} value={user.residenceCode} onChange={(e) => save({ residenceCode: e.target.value })}>
          <option value="">{t('explore.noResidence')}</option>
          {options.map((c) => (
            <option key={c} value={c}>
              {country(c)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('explore.purpose')} htmlFor="set-purpose">
        <select id="set-purpose" className={selectClass} disabled={saving} value={user.travelPurpose} onChange={(e) => save({ travelPurpose: e.target.value as TravelPurpose })}>
          {travelPurposes.map((p) => (
            <option key={p} value={p}>
              {t(`explore.purpose.${p}`)}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

export function ProfilePage() {
  const { user, logout, deleteAccount } = useAuth()
  const { documents, tasks, payments, journeys } = useCase()
  const { toast } = useToast()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const { t, locale, language, setLanguage } = useI18n()
  if (!user) return null

  const downloadData = () => {
    const data = { exportedAt: new Date().toISOString(), profile: user, journeys, tasks, documents, payments }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'unbound-my-data.json'
    a.click()
    URL.revokeObjectURL(a.href)
    toast(t('profile.downloading'))
  }

  const activity: [string, number, string][] = [
    [t('nav.journeys'), journeys.filter((j) => j.status !== 'archived').length, '/app/journeys'],
    [t('nav.documents'), documents.length, '/app/documents'],
    [t('profile.openTasks'), tasks.filter((x) => !x.done).length, '/app/todo'],
  ]

  return (
    <>
      <PageHeader
        eyebrow={t('profile.eyebrow')}
        title={t('profile.title')}
        aside={
          <Button variant="outline" onClick={() => setEditing(true)}>
            {t('profile.edit')}
          </Button>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="flex flex-col gap-4">
          <Card className="p-6">
            <div className="flex items-center gap-4">
              <Avatar size="xl" text={user.initials} src={user.pictureUrl} />
              <div className="min-w-0">
                <p className="font-display truncate text-xl font-semibold">{user.fullName}</p>
                <p className="truncate text-[13px] text-muted">
                  {t('profile.memberSince', { email: user.email, date: new Date(user.memberSince).toLocaleDateString(locale, { month: 'long', year: 'numeric' }) })}
                </p>
              </div>
            </div>
            <dl className="mt-6 grid grid-cols-[120px_minmax(0,1fr)] gap-y-3.5 text-sm">
              {fields.slice(1).map((f) => (
                <div key={f.key} className="contents">
                  <dt className="text-muted">{t(f.label)}</dt>
                  <dd className={user[f.key] ? 'font-semibold' : 'text-muted/70'}>
                    {String(user[f.key] || '') || (
                      <button type="button" onClick={() => setEditing(true)} className="underline underline-offset-2 hover:text-forest-950">
                        {t('common.add')}
                      </button>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card className="p-6">
            <CardTitle>{t('profile.activity')}</CardTitle>
            <ul className="mt-4 grid grid-cols-3 gap-2">
              {activity.map(([label, count, to]) => (
                <li key={to}>
                  <Link to={to} className="block rounded-xl bg-blush px-3 py-3 hover:bg-rose-100">
                    <span className="font-display block text-2xl font-semibold">{count}</span>
                    <span className="block truncate text-xs text-muted">{label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <Card className="overflow-hidden lg:sticky lg:top-[100px]">
          <div className="border-b border-rose-200 bg-rose-100/60 px-6 py-4">
            <CardTitle>{t('profile.settings')}</CardTitle>
            <p className="text-xs text-muted">{t('profile.settingsSub')}</p>
          </div>

          <SettingsSection id="set-travel" icon={Globe2} title={t('profile.travel')} hint={t('profile.travelHint')}>
            <TravelSettings user={user} />
            <Link to="/app/explore" className="mt-3 inline-block text-[13px] font-semibold underline underline-offset-2">
              {t('profile.travelOnMap')}
            </Link>
          </SettingsSection>

          <SettingsSection id="set-language" icon={Languages} title={t('lang.label')} hint={t('profile.languageHint')}>
            <div role="radiogroup" aria-labelledby="set-language" className="flex flex-wrap gap-2">
              {languages.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  role="radio"
                  aria-checked={language === l.value}
                  onClick={() => setLanguage(l.value)}
                  className={cn(
                    'flex h-10 items-center gap-2 rounded-xl border-2 px-3 text-sm font-semibold',
                    language === l.value ? 'border-forest-950 bg-rose-100' : 'border-rose-200 hover:border-rose-300',
                  )}
                >
                  <Flag code={l.flag} /> {l.label}
                </button>
              ))}
            </div>
          </SettingsSection>

          <SettingsSection id="set-notifications" icon={Bell} title={t('profile.notifications')}>
            <SettingRow k="push" title={t('profile.push')} />
            <SettingRow k="email" title={t('profile.email')} hint={t('profile.emailHint')} />
            <SettingRow k="sms" title={t('profile.sms')} hint={t('profile.smsHint')} />
          </SettingsSection>

          <SettingsSection id="set-money" icon={Wallet} title={t('profile.money')} hint={t('profile.moneyHint')}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span>
                <span className="text-muted">{t('finances.budget')}: </span>
                <span className="font-semibold">{money(user.monthlyBudget)}</span>
              </span>
              <span>
                <span className="text-muted">{t('finances.savings')}: </span>
                <span className="font-semibold">{money(user.savings)}</span>
              </span>
              <Link to="/app/finances" className="text-[13px] font-semibold underline underline-offset-2">
                {t('profile.manageMoney')}
              </Link>
            </div>
          </SettingsSection>

          <SettingsSection id="set-privacy" icon={ShieldCheck} title={t('profile.privacy')} hint={t('profile.privacyBody')}>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={downloadData}>
                {t('profile.download')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  logout()
                  navigate('/')
                }}
              >
                {t('profile.logOut')}
              </Button>
              <Button variant="accent" size="sm" onClick={() => setDeleting(true)}>
                {t('profile.deleteAccount')}
              </Button>
            </div>
          </SettingsSection>
        </Card>
      </div>

      <EditDialog key={String(editing)} open={editing} onClose={() => setEditing(false)} user={user} />

      <Dialog
        open={deleting}
        onClose={() => !deleteBusy && setDeleting(false)}
        title={t('profile.deleteTitle')}
        description={t('profile.deleteBody', { count: documents.length })}
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleting(false)} disabled={deleteBusy}>
            {t('profile.keep')}
          </Button>
          <Button
            variant="accent"
            loading={deleteBusy}
            onClick={async () => {
              setDeleteBusy(true)
              try {
                await deleteAccount()
                navigate('/')
                toast(t('profile.deleted'))
              } catch (e) {
                setDeleteBusy(false)
                toast(e instanceof Error ? e.message : t('profile.deleteFailed'), 'error')
              }
            }}
          >
            {t('profile.deleteAccount')}
          </Button>
        </div>
      </Dialog>
    </>
  )
}
