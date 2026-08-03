import { useEffect, useState } from 'react';
import type { HealthResponse } from '@ia/shared';
import { fetchHealth } from './lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'error'; message: string };

const GATES = [
  { id: 'G1', label: 'Confirm profile', note: 'You correct what was read from your resume' },
  { id: 'G2', label: 'Approve posting', note: 'One explicit approval per application' },
  { id: 'G3', label: 'Review answers', note: 'You read and edit every generated answer' },
  { id: 'G4', label: 'Submit', note: 'You click Submit yourself, in the browser' },
];

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((health) => {
        if (!cancelled) setState({ kind: 'ready', health });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-6 py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">internship-applier</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Milestone 0 — skeleton. Nothing is wired to the internet yet.
        </p>
      </header>

      <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">
          Server
        </h2>
        {state.kind === 'loading' && <p className="text-sm">Checking…</p>}
        {state.kind === 'error' && (
          <div className="text-sm">
            <p className="font-medium text-red-600">Cannot reach the API.</p>
            <p className="mt-1 text-neutral-500">{state.message}</p>
            <p className="mt-2 text-neutral-500">
              Start it with <code className="font-mono">npm run dev</code>.
            </p>
          </div>
        )}
        {state.kind === 'ready' && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Row label="Status" value={state.health.status} />
            <Row label="Node" value={state.health.node} />
            <Row label="Uptime" value={`${state.health.uptimeSeconds}s`} />
            <Row
              label="Database"
              value={
                state.health.db.connected
                  ? `connected · ${state.health.db.tables} tables`
                  : 'disconnected'
              }
            />
            <Row
              label="Profile"
              value={state.health.profileConfirmed ? 'confirmed' : 'not set up yet'}
            />
          </dl>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">
          Human gates
        </h2>
        <ul className="space-y-2 text-sm">
          {GATES.map((g) => (
            <li key={g.id} className="flex gap-3">
              <span className="font-mono text-xs text-neutral-400">{g.id}</span>
              <span>
                <span className="font-medium">{g.label}</span>
                <span className="text-neutral-500"> — {g.note}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-neutral-500">
          None of these can be disabled. The tool never submits an application for you.
        </p>
      </section>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </>
  );
}
