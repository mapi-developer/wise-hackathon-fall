import { cn } from '@/lib/format'

/** The star's outline (100×100 box); stroked with round joins so the four tips come out rounded. */
const STAR = 'M50 8.2C52.4 31 61 44 83.4 50C61 56 52.4 69 50 91.8C47.6 69 39 56 16.6 50C39 44 47.6 31 50 8.2Z'
const NEEDLE = 'M49.4 50.8L50.8 45.2L67.6 32.4L55.2 48.8Z'

/** The Unbound mark: a light four-point compass star with a needle, for dark backgrounds. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={cn('shrink-0', className)} aria-hidden>
      <path d={STAR} fill="#F7E1E1" stroke="#F7E1E1" strokeWidth="4.4" strokeLinejoin="round" />
      <path d={NEEDLE} fill="#AB4E4C" stroke="#AB4E4C" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="50" cy="50" r="1.9" fill="#03100A" />
    </svg>
  )
}

export function Logo({ className, onDark = true }: { className?: string; onDark?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-3', className)}>
      <LogoMark className="size-9" />
      <span className={cn('font-display text-xl font-semibold tracking-tight', onDark ? 'text-white' : 'text-forest-950')}>
        unbound
      </span>
    </span>
  )
}
