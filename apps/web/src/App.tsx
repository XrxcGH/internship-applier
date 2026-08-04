import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { HealthResponse } from '@ia/shared';
import { fetchHealth } from './lib/api';
import { Field, Nav, Page, RunningHead, Section, type View } from './components/Chrome';
import { Badge, Button, Notice } from './components/Controls';
import { Onboarding } from './pages/Onboarding';
import { Matches } from './pages/Matches';
import { Applications } from './pages/Applications';
import { Voice } from './pages/Voice';

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
  { id: 'M2', label: 'Discovery', done: true },
  { id: 'M3', label: 'Matching', done: true },
  { id: 'M4', label: 'Review queue', done: true },
  { id: 'M5', label: 'Writing engine', done: true },
  { id: 'M6', label: 'Form automation', done: false },
];

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [view, setView] = useState<View>('home');

  const refresh = useCallback(() => {
    fetchHealth()
      .then((health) => setState({ kind: 'ready', health }))
      .catch((err: unknown) =>
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  }, []);

  useEffect(refresh, [refresh]);

  const confirmed = state.kind === 'ready' && state.health.profileConfirmed;

  const body = (): ReactNode => {
    if (view === 'setup') {
      return (
        <Onboarding
          onDone={() => {
            refresh();
            setView('home');
          }}
        />
      );
    }
    if (view === 'voice') return <Voice />;
    if (view === 'queue') return <Matches onOpenApplications={() => setView('applications')} />;
    if (view === 'applications') return <Applications onBack={() => setView('queue')} />;
    return <Home state={state} confirmed={confirmed} onNavigate={setView} />;
  };

  return (
    <>
      <Nav view={view} onNavigate={setView} profileConfirmed={confirmed} />
      {body()}
    </>
  );
}

function Home({
  state,
  confirmed,
  onNavigate,
}: {
  state: State;
  confirmed: boolean;
  onNavigate: (v: View) => void;
}) {
  return (
    <Page>
      <RunningHead
        section="A working dossier"
        gate={confirmed ? undefined : 'G1'}
        lede="Every filter decision here quotes the job description that caused it. Every drafted
              sentence points at the fact behind it. Nothing is sent anywhere until you sign for it."
      />

      <Section n="01" title="Server" step={4}>
        {state.kind === 'loading' && <p className="text-dim a-pulse text-sm">Checking…</p>}

        {state.kind === 'error' && (
          <div className="text-sm">
            <Notice tone="redline">Cannot reach the API.</Notice>
            <p className="u-quote mt-3">{state.message}</p>
            <p className="text-dim mt-4">
              Start it with <span className="u-data">npm run dev</span>.
            </p>
          </div>
        )}

        {state.kind === 'ready' && (
          <>
            <div className="u-card-flat divide-rule/60 divide-y px-5 py-2">
              <Field label="Status" value={state.health.status} tone="var(--verified)" />
              <Field label="Runtime" value={state.health.node} />
              <Field label="Uptime" value={`${state.health.uptimeSeconds}s`} />
              <Field
                label="Ledger"
                value={
                  state.health.db.connected ? `${state.health.db.tables} tables` : 'disconnected'
                }
                tone={state.health.db.connected ? undefined : 'var(--redline)'}
              />
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
                  <Button variant="primary" onClick={() => onNavigate('queue')}>
                    Open the queue (G2)
                  </Button>
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
                  className={`u-card-flat flex h-full w-full gap-4 px-4 py-4 text-left transition-colors ${
                    reachable ? 'hover:border-rule-strong cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <span className="u-data text-accent w-6 shrink-0 pt-0.5">{g.id}</span>
                  <span>
                    <span className="block text-[1.0625rem] leading-snug">{g.label}</span>
                    <span className="text-dim block text-[0.9375rem] leading-snug">{g.note}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="text-faint mt-6 max-w-[58ch] text-[0.9375rem] italic">
          None of these can be switched off. There is no endpoint that submits an application for
          you. That&rsquo;s asserted by a test, a lint rule, and a CI check, not by good intentions.
        </p>
      </Section>

      <Section n="03" title="Build" step={6}>
        <ul className="u-card-flat divide-rule/50 divide-y px-5 py-1">
          {MILESTONES.map((m) => (
            <li key={m.id} className="flex items-baseline gap-4 py-2.5">
              <span
                className="u-data w-7 shrink-0"
                style={{ color: m.done ? 'var(--verified)' : 'var(--ink-faint)' }}
              >
                {m.id}
              </span>
              <span
                className="flex-1 text-[0.9375rem]"
                style={{ color: m.done ? 'var(--ink)' : 'var(--ink-faint)' }}
              >
                {m.label}
              </span>
              {m.done ? (
                <span className="a-stamp u-data text-verified text-[0.6875rem] tracking-widest uppercase">
                  done
                </span>
              ) : (
                <Badge>next</Badge>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <footer className="a-rise a-step-8 mt-16">
        <hr className="u-rule a-draw a-step-8 mb-4" />
        <p className="u-eyebrow">
          local&nbsp;only&nbsp;· no&nbsp;telemetry&nbsp;· your&nbsp;machine
        </p>
      </footer>
    </Page>
  );
}
