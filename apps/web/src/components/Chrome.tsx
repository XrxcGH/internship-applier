import type { ReactNode } from 'react';

export type View = 'home' | 'setup' | 'queue' | 'applications' | 'voice';

interface NavItem {
  id: View;
  label: string;
  /** Why it is unavailable, shown as a tooltip. Absent means available. */
  blocked?: string;
}

/**
 * Persistent navigation.
 *
 * Locked destinations stay VISIBLE and disabled rather than being hidden. A user who
 * cannot see the queue does not know a queue exists; a user who sees it greyed out with
 * "confirm your profile first" knows exactly what to do next. The gates are the shape of
 * the app, so the nav should show them.
 */
export function Nav({
  view,
  onNavigate,
  profileConfirmed,
}: {
  view: View;
  onNavigate: (v: View) => void;
  profileConfirmed: boolean;
}) {
  const locked = profileConfirmed ? undefined : 'Confirm your profile first (gate G1).';

  const items: NavItem[] = [
    { id: 'home', label: 'Overview' },
    { id: 'setup', label: 'Profile' },
    { id: 'voice', label: 'Voice' },
    { id: 'queue', label: 'Queue', blocked: locked },
    { id: 'applications', label: 'Applications', blocked: locked },
  ];

  return (
    <nav className="u-nav sticky top-0 z-30">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 sm:px-10">
        <button
          onClick={() => onNavigate('home')}
          className="u-eyebrow hover:text-ink shrink-0 py-3 transition-colors"
        >
          internship&nbsp;·&nbsp;applier
        </button>

        <div className="scrollbar-none flex flex-1 items-center gap-5 overflow-x-auto sm:gap-7">
          {items.map((item) => (
            <button
              key={item.id}
              className="u-nav-link shrink-0"
              aria-current={view === item.id ? 'page' : undefined}
              disabled={Boolean(item.blocked)}
              title={item.blocked}
              onClick={() => onNavigate(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <span
          className="u-data hidden shrink-0 items-center gap-2 py-3 text-[0.6875rem] tracking-widest uppercase sm:flex"
          style={{ color: profileConfirmed ? 'var(--verified)' : 'var(--caution)' }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: 'currentColor' }}
          />
          {profileConfirmed ? 'local' : 'setup'}
        </span>
      </div>
    </nav>
  );
}

/** Page masthead. This is a document header, not a nav bar — the nav is above it. */
export function RunningHead({
  section,
  gate,
  lede,
}: {
  section: string;
  gate?: string;
  lede?: ReactNode;
}) {
  return (
    <header className="a-rise a-step-1 mb-12">
      <div className="flex items-baseline justify-between gap-4">
        <span className="u-eyebrow">{gate ? `gate ${gate}` : 'no gate pending'}</span>
      </div>
      <h1 className="u-display mt-3 text-5xl sm:text-6xl">{section}</h1>
      <hr className="u-rule a-draw a-step-2 mt-5" />
      {lede && (
        <p className="text-dim a-rise a-step-3 mt-5 max-w-[64ch] text-[1.0625rem] leading-relaxed">
          {lede}
        </p>
      )}
    </header>
  );
}

/** Numbered section, like a clause in a file. */
export function Section({
  n,
  title,
  step,
  actions,
  children,
}: {
  n: string;
  title: string;
  step: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`a-rise mb-14 a-step-${step}`}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <span className="u-data text-faint">{n}</span>
          <h2 className="u-eyebrow">{title}</h2>
        </div>
        {actions}
      </div>
      <hr className={`u-rule a-draw mb-6 a-step-${step}`} />
      {children}
    </section>
  );
}

export function Field({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2">
      <span className="text-dim text-[0.9375rem]">{label}</span>
      <span className="u-data text-right" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
    </div>
  );
}

/** Standard page frame: consistent max-width, gutters, and vertical rhythm. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto px-6 py-12 sm:px-10 sm:py-16 ${wide ? 'max-w-6xl' : 'max-w-3xl'}`}>
      {children}
    </div>
  );
}
