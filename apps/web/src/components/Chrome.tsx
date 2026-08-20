import type { ReactNode } from 'react';

/**
 * What the app knows about the profile — including that it does not know yet, and that it
 * could not ask. Collapsing the last two into `false` is what made the nav blame G1 for an
 * unreachable server.
 */
export type ProfileStatus = 'checking' | 'unreachable' | 'unconfirmed' | 'confirmed';

export type View =
  'home' | 'setup' | 'discovery' | 'queue' | 'applications' | 'tracker' | 'voice' | 'settings';

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
  profile,
  busy,
}: {
  view: View;
  onNavigate: (v: View) => void;
  profile: ProfileStatus;
  /** What the current screen is in the middle of, if anything. See below. */
  busy?: string | null;
}) {
  /**
   * Leaving is locked while a screen is spending something, and this is not politeness.
   *
   * Every long operation in this app is guarded by a `busyRef` inside the component that
   * started it — Discovery's search, the queue's Recompute, the resume upload — and the
   * server has no lock of its own for any of them. Those guards disable their own buttons and
   * Discovery's comment states the invariant outright: "a guard with a door beside it is not
   * a guard." The nav bar was that door. It sits above every page, took no busy signal, and
   * one click on it unmounts the component holding the guard; coming back mounts a fresh one
   * with `busyRef` false, and the button is live again while the first run is still going.
   * Two concurrent discovery runs over the same boards, or two Recomputes each re-extracting
   * requirements at cost, from two clicks a second apart.
   *
   * The masthead is exempt: it navigates home, and someone who genuinely wants out needs a
   * way that is not the browser's back button.
   */
  const running = busy ? `${busy} — wait for it to finish, or reload to abandon it.` : undefined;
  /**
   * Four states, not a boolean, because two of them were being told to fix the wrong thing.
   *
   * `profileConfirmed` was derived from the health fetch, so a server that could not be
   * reached — or had not answered yet — collapsed into "not confirmed", and four nav
   * destinations greyed out under "Confirm your profile first (gate G1)" for a returning user
   * whose profile has been confirmed for weeks. The instruction was impossible to act on and
   * named the wrong cause.
   */
  const locked =
    running ??
    (profile === 'confirmed'
      ? undefined
      : profile === 'unconfirmed'
        ? 'Confirm your profile first (gate G1).'
        : profile === 'checking'
          ? 'Still asking the server.'
          : 'The server is not answering, so nothing here is live.');

  const items: NavItem[] = [
    { id: 'home', label: 'Overview', blocked: running },
    { id: 'setup', label: 'Profile', blocked: running },
    { id: 'voice', label: 'Voice', blocked: running },
    // Ahead of the queue because it is what fills the queue, and locked with it: every
    // /api/discovery route answers 409 until a profile is confirmed, since eligibility
    // would have nothing to check a posting against.
    { id: 'discovery', label: 'Discover', blocked: locked },
    { id: 'queue', label: 'Queue', blocked: locked },
    { id: 'applications', label: 'Applications', blocked: locked },
    { id: 'tracker', label: 'Tracker', blocked: locked },
    { id: 'settings', label: 'Settings', blocked: running },
  ];

  return (
    <nav className="u-nav sticky top-0 z-30">
      {/* Two rows on a phone, one from sm up.

          In a single row the wordmark and the status pill take their width first and the nav
          track gets what is left — which at 375px was 101 pixels onto 790 of content, so the
          eight destinations were technically reachable and practically not: one visible at a
          time, through a window narrower than a single label. Giving the track its own line
          below the wordmark hands it the full width instead. */}
      <div
        className="mx-auto flex w-full flex-col gap-0 sm:flex-row sm:items-center sm:gap-6"
        style={{
          maxWidth: 'min(96rem, 100%)',
          paddingInline: 'clamp(1.25rem, 0.5rem + 2.2vw, 4.5rem)',
        }}
      >
        <button
          onClick={() => onNavigate('home')}
          className="u-eyebrow hover:text-ink shrink-0 self-start pt-3 pb-1 transition-colors sm:self-auto sm:py-3"
        >
          internship&nbsp;·&nbsp;applier
        </button>

        {/* Bleeds to the screen edges on mobile so a half-scrolled label is visibly cut off
            rather than sitting flush against the padding and looking like the end of the list. */}
        <div className="scrollbar-none -mx-5 flex flex-1 items-center gap-5 overflow-x-auto px-5 pb-1 sm:mx-0 sm:gap-7 sm:px-0 sm:pb-0">
          {items.map((item) => (
            /* aria-disabled rather than disabled, so the reason stays reachable.
               A locked destination is supposed to say what to do next, and that text
               lived only in `title` on a `disabled` button — which is out of the tab
               order, shows no tooltip on touch, and is generally skipped by screen
               readers. The guidance was invisible to exactly the people who cannot
               hover. */
            /* The dimming and the cursor live in the stylesheet, on the same
               `[aria-disabled='true']` selector the hover rule excludes. Setting them here
               as well is how the two drifted apart in the first place: this line was
               updated, the stylesheet went on keying `:disabled`, and a locked item stayed
               dim but lit up on hover like a live one. */
            <button
              key={item.id}
              className="u-nav-link shrink-0"
              aria-current={view === item.id ? 'page' : undefined}
              aria-disabled={item.blocked ? true : undefined}
              title={item.blocked}
              onClick={() => {
                if (!item.blocked) onNavigate(item.id);
              }}
            >
              {item.label}
              {item.blocked && <span className="sr-only"> — {item.blocked}</span>}
            </button>
          ))}
        </div>

        {/* Says which of the four states it is in, rather than reading "setup" at a
            returning user whose profile is confirmed and whose server is simply down. */}
        <span
          className="u-data hidden shrink-0 items-center gap-2 py-3 text-2xs tracking-widest uppercase sm:flex"
          style={{
            color:
              profile === 'confirmed'
                ? 'var(--verified)'
                : profile === 'unreachable'
                  ? 'var(--redline)'
                  : 'var(--caution)',
          }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: 'currentColor' }}
          />
          {profile === 'confirmed'
            ? 'local'
            : profile === 'unconfirmed'
              ? 'setup'
              : profile === 'checking'
                ? 'checking'
                : 'offline'}
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
      {/* Nothing at all when there is no gate, rather than "no gate pending" — which this
          component cannot know. It takes a `gate` prop and no session state, so on Voice
          and Settings (blocked on `running`, never on the gate) a first-time user read "no
          gate pending" on one screen while Home said "gate G1" for the same session. The
          whole row goes, and the h1's top margin with it, or an empty flex row leaves a gap
          where the eyebrow used to be. */}
      {gate && (
        <div className="flex items-baseline justify-between gap-4">
          <span className="u-eyebrow">{`gate ${gate}`}</span>
        </div>
      )}
      <h1 className={`u-display u-display-title ${gate ? 'mt-3' : ''}`}>{section}</h1>
      <hr className="u-rule a-draw a-step-2 mt-6" />
      {lede && <p className="text-dim u-prose a-rise a-step-3 mt-6 text-lg">{lede}</p>}
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
    <div className="flex items-baseline justify-between gap-6 py-2.5">
      <span className="text-dim text-base">{label}</span>
      <span className="u-data text-right" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
    </div>
  );
}

/**
 * Standard page frame — one width, for every screen.
 *
 * The frame is wide; the MEASURE is not. Reading comfort caps out around 70 characters a
 * line, so prose blocks carry `u-prose` and cap themselves regardless of how much room the
 * page has. The frame's job is to give panels somewhere to sit side by side.
 *
 * There used to be two frames, `wide` and not, and the split did more harm than the sizing
 * ever did: Discover, the queue and the tracker filled a 88rem frame while Profile, Voice,
 * Applications and Settings sat in a 64rem one, so moving between them on a large monitor
 * made the content jump inward by four hundred pixels for no reason the reader could see.
 * The narrow four were narrow because they were single columns and a single column stranded
 * in a wide frame reads as text pinned to one edge — but the answer to that is to give those
 * pages columns, which is what the grids on each of them now do, not to shrink the page
 * around them.
 *
 * Fluid rather than stepped. `min()` against the viewport means the frame tracks the window
 * continuously instead of snapping at breakpoints, and the padding is a `clamp` for the same
 * reason: at 1280 it is 40px, at 2560 it is 72px, and every width between gets the
 * proportional value rather than the nearest of three. Widths are in rem, so they scale with
 * the root type size.
 */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div
      className="mx-auto w-full py-10 sm:py-14"
      style={{
        maxWidth: 'min(96rem, 100%)',
        paddingInline: 'clamp(1.25rem, 0.5rem + 2.2vw, 4.5rem)',
      }}
    >
      {children}
    </div>
  );
}
