import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { HealthResponse } from '@ia/shared';
import { fetchHealth } from './lib/api';
import {
  Field,
  Nav,
  Page,
  RunningHead,
  Section,
  type ProfileStatus,
  type View,
} from './components/Chrome';
import { Badge, Button, Notice } from './components/Controls';
import { Onboarding } from './pages/Onboarding';
import { Discovery } from './pages/Discovery';
import { Matches } from './pages/Matches';
import { Applications } from './pages/Applications';
import { Voice } from './pages/Voice';
import { Tracker } from './pages/Tracker';
import { Settings } from './pages/Settings';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'error'; message: string };

const GATES = [
  {
    id: 'G1',
    label: 'Confirm profile',
    note: 'You correct what was read from your resume.',
    view: 'setup' as View | null,
  },
  {
    id: 'G2',
    label: 'Approve posting',
    note: 'One explicit approval, per application.',
    view: 'queue' as View | null,
  },
  {
    id: 'G3',
    label: 'Review answers',
    note: 'You read and edit every generated sentence.',
    view: 'applications' as View | null,
  },
  { id: 'G4', label: 'Submit', note: 'You click Submit yourself, on the real page.', view: null },
];

const MILESTONES = [
  { id: 'M0', label: 'Skeleton', done: true },
  { id: 'M1', label: 'Resume → profile', done: true },
  // This read "Discovery (server only)" for as long as the endpoints existed with nothing
  // in the interface calling them. `pages/Discovery.tsx` is that screen, so the qualifier
  // goes — and if the screen is ever removed, the qualifier comes back rather than the row
  // going on claiming a milestone the user cannot reach.
  { id: 'M2', label: 'Discovery', done: true },
  { id: 'M3', label: 'Matching', done: true },
  { id: 'M4', label: 'Review queue', done: true },
  { id: 'M5', label: 'Writing engine', done: true },
  { id: 'M6', label: 'Form automation', done: true },
  { id: 'M7', label: 'Tracker', done: true },
  { id: 'M8', label: 'Hardening', done: true },
];

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [view, setView] = useState<View>('home');
  /**
   * What the open screen is in the middle of, so the nav can refuse to unmount it.
   *
   * Held here rather than on the screens because the nav is here. Each long operation is
   * guarded by a `busyRef` inside the component that started it, and unmounting that
   * component throws the guard away — see the comment on `Nav`. A screen with nothing in
   * flight reports null and nothing is locked.
   */
  const [busy, setBusy] = useState<string | null>(null);

  // Whatever the last screen was doing, it is not doing it here. Without this a screen
  // unmounted by anything other than the nav — the Home gate buttons, `onDone` — could
  // leave the bar locked with no way to clear it but a reload.
  useEffect(() => setBusy(null), [view]);

  const refresh = useCallback(() => {
    fetchHealth()
      .then((health) => setState({ kind: 'ready', health }))
      .catch((err: unknown) =>
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  }, []);

  useEffect(refresh, [refresh]);

  /**
   * The four states the nav needs told apart. `confirmed` stays a boolean for the Home
   * button, which genuinely only cares whether G1 is done.
   */
  const profile: ProfileStatus =
    state.kind === 'loading'
      ? 'checking'
      : state.kind === 'error'
        ? 'unreachable'
        : state.health.profileConfirmed
          ? 'confirmed'
          : 'unconfirmed';
  const confirmed = profile === 'confirmed';

  /**
   * The way back from a failed health check.
   *
   * `refresh` is a `useCallback(…, [])` wired to one `useEffect`, so a single failed fetch
   * pinned the app for the life of the tab — with four nav destinations greyed out and no
   * control anywhere to ask again. Settings already learned this lesson and put a "Try again"
   * inside its error banner; the landing screen is the one place it was not applied.
   *
   * The loading reset lives HERE and not inside `refresh` itself: `Onboarding`'s `onDone`
   * calls refresh too, and flipping to 'loading' there would drop `confirmed` and re-lock the
   * whole nav at the moment the queue mounts.
   */
  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    refresh();
  }, [refresh]);

  const body = (): ReactNode => {
    if (view === 'setup') {
      return (
        <Onboarding
          // Called by the confirmation screen, not by the confirm request. Navigating the
          // moment the request returned unmounted Onboarding in the same render, so the
          // "profile established" stamp — the one acknowledgement G1 gives the user for
          // the work they just did — was never on screen for a single frame.
          onBusy={setBusy}
          onDone={() => {
            refresh();
            setView('queue');
          }}
          // `refresh()` on this path too, and it is not optional: `confirmed` is derived from
          // the health fetch, and the whole nav is locked on it until that answer arrives.
          onFindPostings={() => {
            refresh();
            setView('discovery');
          }}
        />
      );
    }
    if (view === 'voice') return <Voice />;
    if (view === 'discovery')
      return <Discovery onOpenQueue={() => setView('queue')} onBusy={setBusy} />;
    if (view === 'queue') {
      return (
        <Matches
          onOpenApplications={() => setView('applications')}
          onOpenDiscovery={() => setView('discovery')}
          onBusy={setBusy}
        />
      );
    }
    if (view === 'applications') return <Applications onBack={() => setView('queue')} />;
    if (view === 'tracker') return <Tracker />;
    if (view === 'settings') return <Settings />;
    return (
      <Home
        state={state}
        confirmed={confirmed}
        profile={profile}
        onNavigate={setView}
        onRetry={retry}
      />
    );
  };

  return (
    <>
      <Nav view={view} onNavigate={setView} profile={profile} busy={busy} />
      {body()}
    </>
  );
}

function Home({
  state,
  confirmed,
  profile,
  onNavigate,
  onRetry,
}: {
  state: State;
  confirmed: boolean;
  profile: ProfileStatus;
  onNavigate: (v: View) => void;
  /** Asks the server again after a failed health check. See `retry` in App. */
  onRetry: () => void;
}) {
  return (
    <Page wide>
      <RunningHead
        section="A working dossier"
        gate={profile === 'unconfirmed' ? 'G1' : undefined}
        lede={
          <>
            Every filter decision here quotes the job description that caused it. Every drafted
            sentence points at the fact behind it. <strong>Nothing is sent anywhere</strong> until
            you sign for it.
          </>
        }
      />

      {/* The status panel is a short list and the gates need room, so they sit side by
          side rather than stacking down the middle of a laptop screen. */}
      <div className="grid gap-x-14 lg:grid-cols-[24rem_minmax(0,1fr)]">
        <Section n="01" title="Where to start" step={4}>
          {state.kind === 'loading' && <p className="text-dim a-pulse">Checking the server…</p>}

          {state.kind === 'error' && (
            <div>
              <Notice tone="redline">
                <strong>The interface cannot reach the server.</strong> Nothing below is live.
              </Notice>
              <p className="u-quote mt-3">{state.message}</p>
              <p className="text-dim mt-4">
                Start it with <span className="u-data">npm run dev</span>.
              </p>
              {/* Without this the app is pinned for the life of the tab: the health fetch
                  runs from one useEffect with a stable callback, so nothing asks again. */}
              <div className="mt-4">
                <Button onClick={onRetry}>Try again</Button>
              </div>
            </div>
          )}

          {state.kind === 'ready' && (
            <>
              {/* A dead database inside a 200 answer, which the redline branch above
                  cannot catch: it is gated on the fetch or the parse failing, and
                  `db: { connected: false }` parses perfectly well. Deleting the old
                  "Ledger" row without this would leave that state reported nowhere. */}
              {!state.health.db.connected && (
                <Notice tone="redline">
                  <strong>The local database is not answering.</strong> Nothing you do here will be
                  saved.
                </Notice>
              )}
              {/* Runtime, uptime and a table count used to sit here, above everything else on
                  the first screen of the app: a health-check readout served to a student
                  before they were told what to do. So did a "Status" row that could only ever
                  read "ok" — the shared schema types it `z.literal('ok')`, so any other
                  answer fails the parse and lands in the error branch above instead.

                  The profile row stays. It is not the nav pill in miniature: that reads
                  local/setup rather than confirmed, and it is hidden below the sm breakpoint. */}
              <div className="u-card-flat divide-rule/60 divide-y px-5 py-2">
                <Field
                  label="Profile"
                  value={state.health.profileConfirmed ? 'confirmed' : 'not yet established'}
                  tone={state.health.profileConfirmed ? 'var(--verified)' : 'var(--caution)'}
                />
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <Button variant="solid" onClick={() => onNavigate('setup')}>
                  {confirmed ? 'Revisit profile' : 'Establish profile (G1)'}
                </Button>
                {confirmed && (
                  <>
                    {/* Ahead of the queue on purpose. A confirmed profile with nothing
                        searched yet reaches an empty queue, and the button that fixes
                        that was reachable only from the nav bar. */}
                    <Button variant="primary" onClick={() => onNavigate('discovery')}>
                      Find postings
                    </Button>
                    <Button onClick={() => onNavigate('queue')}>Open the queue (G2)</Button>
                    <Button onClick={() => onNavigate('voice')}>Set up your voice</Button>
                  </>
                )}
              </div>
            </>
          )}
        </Section>

        <Section n="02" title="The four gates" step={5}>
          <ol className="grid gap-3 sm:grid-cols-2">
            {GATES.map((g, i) => {
              const target = g.view;
              const reachable = target !== null && (confirmed || target === 'setup');
              return (
                <li key={g.id} className={`a-rise a-step-${String(Math.min(i + 5, 8))}`}>
                  <button
                    disabled={!reachable}
                    onClick={() => target && onNavigate(target)}
                    className={`u-card-flat flex h-full w-full gap-4 px-5 py-4 text-left transition-colors ${
                      reachable ? 'hover:border-rule-strong cursor-pointer' : 'cursor-default'
                    }`}
                  >
                    <span className="u-data text-accent w-7 shrink-0 pt-1">{g.id}</span>
                    <span>
                      <span className="block text-[1.125rem] leading-snug">{g.label}</span>
                      <span className="text-dim mt-1 block text-[1rem] leading-snug">{g.note}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="text-faint u-prose mt-6">
            <em>None of these can be switched off.</em> There is no endpoint that submits an
            application for you, and that is asserted by a test, a lint rule, and a CI check rather
            than by good intentions.
          </p>
        </Section>
      </div>

      <Section n="03" title="Build" step={6}>
        {/* A horizontal track rather than a stacked list: nine short items read as
            progress across the page, and it uses width the list was wasting. Nine across
            needs a very wide screen, so narrower ones wrap — the column counts are chosen
            so the track never ends with one card stranded on its own row. */}
        <ol className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-9">
          {MILESTONES.map((m) => (
            <li
              key={m.id}
              className="u-card-flat px-4 py-3.5"
              style={{ opacity: m.done ? 1 : 0.72 }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="u-data"
                  style={{ color: m.done ? 'var(--verified)' : 'var(--ink-faint)' }}
                >
                  {m.id}
                </span>
                {m.done ? (
                  <span className="a-stamp u-data text-verified text-[0.75rem] tracking-widest uppercase">
                    done
                  </span>
                ) : (
                  <Badge>next</Badge>
                )}
              </div>
              <p
                className="mt-1.5 text-[1rem] leading-snug"
                style={{ color: m.done ? 'var(--ink)' : 'var(--ink-faint)' }}
              >
                {m.label}
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <footer className="a-rise a-step-8 mt-16">
        <hr className="u-rule a-draw a-step-8 mb-4" />
        {/* Not "local only". Settings names six things that do leave this machine — the
            job-source lookups, the resume when the model reads it, the search brief, a
            posting's text, whatever is sent while drafting, and the application sites —
            and the upload step says outright that a PDF is sent to the model. This was the
            last line a new user reads on the landing screen, and it contradicted all of it. */}
        <p className="u-eyebrow">
          no&nbsp;telemetry&nbsp;· stored&nbsp;on&nbsp;your&nbsp;machine&nbsp;·
          what&nbsp;leaves&nbsp;is&nbsp;listed&nbsp;in&nbsp;Settings
        </p>
      </footer>
    </Page>
  );
}
