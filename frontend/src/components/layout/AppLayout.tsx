import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { Loader2 } from 'lucide-react'
import { LogoMark } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'
import { useI18n } from '@/i18n'
import { useAuth, useCase } from '@/store/context'
import { usePersistentState } from '@/store/persist'
import { cn } from '@/lib/format'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

function Gate({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="grid min-h-svh place-content-center justify-items-center gap-5 bg-blush px-4 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-forest-950">
        <LogoMark className="size-10" />
      </span>
      {error ? (
        <>
          <div>
            <h1 className="text-lg font-semibold text-forest-950">{t('layout.caseFailed')}</h1>
            <p className="mt-1 max-w-sm text-sm text-muted">{error}</p>
          </div>
          <Button onClick={onRetry}>{t('common.tryAgain')}</Button>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('layout.loadingCase')}
        </p>
      )}
    </div>
  )
}

export function AppLayout() {
  const auth = useAuth()
  const kase = useCase()
  const location = useLocation()
  const { t } = useI18n()
  const [collapsed, setCollapsed] = usePersistentState('sidebar-collapsed', false)
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    document.body.style.overflow = drawer ? 'hidden' : ''
  }, [drawer])

  if (!auth.session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (auth.status === 'error' || kase.status === 'error')
    return (
      <Gate
        error={auth.error ?? kase.error}
        onRetry={() => {
          if (auth.status === 'error') auth.reload()
          if (kase.status === 'error') kase.reload()
        }}
      />
    )
  if (!auth.user || kase.status !== 'ready') return <Gate error={null} onRetry={() => {}} />

  return (
    <div className="flex min-h-svh bg-blush">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-white px-4 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t('layout.skip')}
      </a>

      {/* desktop */}
      <div className="sticky top-0 hidden h-svh shrink-0 lg:block">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      </div>

      {/* mobile drawer */}
      <div className={cn('fixed inset-0 z-50 lg:hidden', drawer ? 'visible' : 'invisible')} aria-hidden={!drawer}>
        <button
          type="button"
          aria-label={t('layout.closeMenu')}
          tabIndex={drawer ? 0 : -1}
          onClick={() => setDrawer(false)}
          className={cn('absolute inset-0 bg-forest-950/50 transition-opacity', drawer ? 'opacity-100' : 'opacity-0')}
        />
        <div className={cn('absolute inset-y-0 left-0 transition-transform duration-200', drawer ? 'translate-x-0' : '-translate-x-full')}>
          <Sidebar collapsed={false} mobile onNavigate={() => setDrawer(false)} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setDrawer(true)} />
        <main id="main" className="w-full flex-1 px-4 py-6 sm:px-7 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
