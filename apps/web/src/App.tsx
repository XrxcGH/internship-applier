import { useCallback, useEffect, useState } from 'react';
import type { HealthResponse } from '@ia/shared';
import { fetchHealth } from './lib/api';
import { Field, RunningHead, Section } from './components/Chrome';
import { Button } from './components/Controls';
import { Onboarding } from './pages/Onboarding';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'error'; message: string };

const GATES = [
  { id: 'G1', label: 'Confirm profile', note: 'You correct what was read from your resume.' },
  { id: 'G2', label: 'Approve posting', note: 'One explicit approval, per application.' },
  { id: 'G3', label: 'Review answers', note: 'You read and edit every generated sentence.' },
  { id: 'G4', label: 'Submit', note: 'You click Submit yourself, on the real page.' },
];

const MILESTONES = [
  { id: 'M0', label: 'Skeleton', done: true },
  { id: 'M1', label: 'Resume → profile', done: true },
  { id: 'M2', label: 'Discovery', done: true },
  { id: 'M3', label: 'Matching', done: true },
  { id: 'M4', label: 'Review queue', done: false },
  { id: 'M5', label: 'Writing engine', done: false },
  { id: 'M6', label: 'Form automation', done: false },
];

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [setupOpen, setSetupOpen] = useState(false);

  const refresh = useCallback(() => {
    fetchHealth()
      .then((health) => setState({ kind: 'ready', health }))
      .catch((err: unknown) =>
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  }, []);

  useEffect(refresh, [refresh]);

  const confirmed = state.kind === 'ready' && state.health.profileConfirmed;

  if (setupOpen) {
    return (
      <Onboarding
        onDone={() => {
          refresh();
          setSetupOpen(false);
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-16 sm:px-10 sm:py-24">
      <RunningHead section="A working dossier" gate={confirmed ? undefined : 'G1'} />

      <p className="a-rise a-step-2 text-dim mb-14 max-w-[62ch] text-[1.0625rem] leading-relaxed">
        Every filter decision here quotes the job description that caused it. Every drafted sentence
        points at the fact behind it. Nothing is sent anywhere until you sign for it.
      </p>

      <Section n="01" title="Server" step={3}>
        {state.kind === 'loading' && <p className="text-dim text-sm">Checking…</p>}

        {state.kind === 'error' && (
          <div className="text-sm">
            <p className="text-redline">Cannot reach the API.</p>
            <p className="u-quote mt-3">{state.message}</p>
            <p className="text-dim mt-4">
              Start it with <span className="u-data">npm run dev</span>.
            </p>
          </div>
        )}

        {state.kind === 'ready' && (
          <div className="divide-rule/60 divide-y">
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
        )}

        {state.kind === 'ready' && (
          <div className="mt-6">
            <Button variant="primary" onClick={() => setSetupOpen(true)}>
              {confirmed ? 'Revisit profile' : 'Establish profile — G1'}
            </Button>
          </div>
        )}
      </Section>

      <Section n="02" title="The four gates" step={4}>
        <ol className="space-y-4">
          {GATES.map((g, i) => (
            <li key={g.id} className={`a-rise flex gap-4 a-step-${Math.min(i + 5, 8)}`}>
              <span className="u-data text-brass w-6 shrink-0 pt-0.5">{g.id}</span>
              <span>
                <span className="block text-[1.0625rem]">{g.label}</span>
                <span className="text-dim text-[0.9375rem]">{g.note}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="text-faint mt-6 max-w-[58ch] text-[0.9375rem] italic">
          None of these can be switched off. There is no endpoint that submits an application for
          you — that&rsquo;s asserted by a test, a lint rule, and a CI check, not by good
          intentions.
        </p>
      </Section>

      <Section n="03" title="Build" step={6}>
        <ul className="space-y-1.5">
          {MILESTONES.map((m) => (
            <li key={m.id} className="flex items-baseline gap-4">
              <span
                className="u-data w-6 shrink-0"
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
              {m.done && (
                <span className="a-stamp u-data text-verified text-[0.6875rem] tracking-widest uppercase">
                  done
                </span>
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
    </div>
  );
}
