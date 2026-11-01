import type { ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router-dom'

/** Shown in the top bar and the sidebar. Keep index.html's <title> the same. */
const APP_NAME = 'New app'

type NavItem = { to: string; label: string; icon: ReactNode }

/**
 * One entry per page, in the order they appear; each needs its <Route> in main.tsx.
 * Empty it for a one-screen app and the frame is just the top bar, at every size.
 */
const NAV: NavItem[] = [{ to: '/', label: 'Home', icon: <Icon d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" /> }]

/**
 * The frame around every page, laid out three ways:
 * - phone (unprefixed, under 768px): a top bar, the page, and NAV as tabs at the bottom,
 *   within thumb reach, once there are two or more
 * - tablet (md:, 768px+): NAV as a rail of icons down the left, and no top bar
 * - desktop (lg:, 1024px+): the rail widens into a sidebar with the name and the labels
 * The page fills the rest and owns its padding and its columns.
 */
export default function AppShell() {
  const rail = NAV.length > 0
  const tabs = NAV.length > 1
  return (
    <div className="min-h-dvh bg-canvas text-ink md:flex">
      {rail && (
        <nav
          aria-label="Main"
          className="sticky top-0 hidden h-dvh w-20 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline bg-surface p-2 md:flex lg:w-60 lg:p-3"
        >
          <div className="mb-2 flex h-14 shrink-0 items-center justify-center gap-3 lg:justify-start lg:px-2">
            <Mark />
            <span className="hidden truncate font-display font-semibold lg:inline">{APP_NAME}</span>
          </div>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 rounded-md px-1 py-2.5 text-[11px] font-medium lg:flex-row lg:gap-3 lg:px-3 lg:py-2 lg:text-sm ${
                  isActive ? 'bg-primary text-on-primary' : 'text-ink-muted hover:bg-ink/5'
                }`
              }
            >
              {item.icon}
              <span className="max-w-full truncate">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={`sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-hairline bg-surface/90 px-4 backdrop-blur ${
            rail ? 'md:hidden' : 'md:h-16 md:px-6 lg:px-10'
          }`}
        >
          <Mark />
          <span className="truncate font-display font-semibold">{APP_NAME}</span>
        </header>
        <main className={`flex min-w-0 flex-1 flex-col ${tabs ? 'pb-16 md:pb-0' : ''}`}>
          <Outlet />
        </main>
      </div>

      {tabs && (
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-20 flex border-t border-hairline bg-surface/95 backdrop-blur md:hidden"
        >
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium ${
                  isActive ? 'text-ink' : 'text-ink-muted'
                }`
              }
            >
              {item.icon}
              <span className="max-w-full truncate px-1">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  )
}

function Mark() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-primary font-display text-sm font-semibold text-on-primary">
      {APP_NAME.charAt(0)}
    </span>
  )
}

/** A 24×24 stroked icon from one path, sized for the tabs, the rail and the sidebar. */
export function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-6 shrink-0 lg:size-5"
    >
      <path d={d} />
    </svg>
  )
}
