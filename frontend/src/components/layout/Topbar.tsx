import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router'
import { Bell, Globe2, Menu } from 'lucide-react'
import { useI18n } from '@/i18n'
import { useCase } from '@/store/context'
import { cn } from '@/lib/format'
import { GlobalSearch } from './GlobalSearch'
import { LanguageMenu } from './LanguageMenu'
import { NotificationsPanel } from './NotificationsPanel'

function useClickAway(ref: React.RefObject<HTMLElement | null>, onAway: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onAway()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onAway()
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [ref, onAway, active])
}

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { notifications } = useCase()
  const { t } = useI18n()
  const [panel, setPanel] = useState<'none' | 'notifications' | 'lang'>('none')
  const right = useRef<HTMLDivElement>(null)
  useClickAway(right, () => setPanel('none'), panel !== 'none')
  const unread = notifications.filter((n) => n.unread).length

  return (
    <header className="sticky top-0 z-30 border-b border-rose-200 bg-blush/90 backdrop-blur">
      <div className="flex h-[76px] items-center gap-3 px-4 sm:px-7">
        <button
          type="button"
          onClick={onMenu}
          aria-label={t('layout.openMenu')}
          className="grid size-[42px] shrink-0 place-items-center rounded-xl border border-rose-300 bg-white lg:hidden"
        >
          <Menu className="size-5" />
        </button>

        <GlobalSearch />

        <div ref={right} className="relative ml-auto flex items-center gap-2.5">
          <NavLink
            to="/app/explore"
            aria-label={t('explore.title')}
            title={t('explore.title')}
            className={({ isActive }) =>
              cn('grid size-[42px] place-items-center rounded-xl border bg-white transition-colors hover:border-forest-950', isActive ? 'border-forest-950 bg-rose-100' : 'border-rose-300')
            }
          >
            <Globe2 className="size-5" aria-hidden />
          </NavLink>

          <LanguageMenu open={panel === 'lang'} onOpenChange={(o) => setPanel(o ? 'lang' : 'none')} />

          <button
            type="button"
            onClick={() => setPanel(panel === 'notifications' ? 'none' : 'notifications')}
            aria-label={t('notifications.aria', { count: unread })}
            aria-expanded={panel === 'notifications'}
            className={cn(
              'relative grid size-[42px] place-items-center rounded-xl border bg-white',
              panel === 'notifications' ? 'border-forest-950' : 'border-rose-300',
            )}
          >
            <Bell className="size-5" />
            {unread > 0 && (
              <span className="absolute -top-2 -right-2 grid size-5 place-items-center rounded-full bg-brick-600 text-[11px] font-semibold text-white">
                {unread}
              </span>
            )}
          </button>
          {panel === 'notifications' && <NotificationsPanel onClose={() => setPanel('none')} />}
        </div>
      </div>
    </header>
  )
}
