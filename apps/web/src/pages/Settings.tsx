import { useCallback, useEffect, useState } from 'react';
import {
  deleteEverything,
  getCosts,
  getDeletePreview,
  getModelAccess,
  downloadFile,
  testModelAccess,
  type CostSummary,
  type DeletePreview,
  type ModelAccess,
} from '../lib/api';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Badge, Button, Empty, Notice, TextField } from '../components/Controls';

/**
 * Settings — docs/10 § User control, docs/11 § M8.
 *
 * Three things live here, and they are the three questions a local-first tool owes an
 * answer to: what is it connected to, what has it cost, and how do I get my data out or
 * get rid of it.
 *
 * The delete control is deliberately awkward. It shows real counts before it will do
 * anything, it requires a typed phrase, and it says there is no undo. Making an
 * irreversible action easy to trigger is not good design.
 */

function money(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function Settings() {
  const [access, setAccess] = useState<ModelAccess | null>(null);
  const [costs, setCosts] = useState<CostSummary | null>(null);
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [deleted, setDeleted] = useState<{
    message: string;
    failed: Array<{ path: string; reason: string }>;
  } | null>(null);

  // Every action handler on this page surfaces its errors; the mount path used to be the
  // one that did not, so a failed fetch left "Checking…" and "Reading the ledger…"
  // pulsing for the life of the page.
  //
  // Clears the banner on the way in, so retrying after the server comes back leaves the
  // page reading as it did before the failure rather than keeping a red bar over three
  // sections that have just loaded.
  const refresh = useCallback(() => {
    setError(null);
    const fail = (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    };
    void getModelAccess().then(setAccess).catch(fail);
    void getCosts().then(setCosts).catch(fail);
    void getDeletePreview().then(setPreview).catch(fail);
  }, []);

  useEffect(refresh, [refresh]);

  const runTest = async (): Promise<void> => {
    setBusy('test');
    setError(null);
    setTestResult(null);
    try {
      const r = await testModelAccess();
      setTestResult({ ok: r.ok ?? false, detail: r.detail ?? r.description });
      refresh();
    } catch (err) {
      // A failed self-test answers with 503 and a useful message; show it as the result
      // rather than as a crash, because "not signed in yet" is the expected first answer.
      setTestResult({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const runDelete = async (): Promise<void> => {
    setBusy('delete');
    setError(null);
    try {
      const r = await deleteEverything(confirmText);
      setDeleted({ message: r.message, failed: r.failed });
      setConfirmText('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * No fallback phrase, deliberately.
   *
   * It used to default to the real confirmation string, so while the preview was in
   * flight — or had failed, since refresh() has no catch — the warning paragraph rendered
   * empty, the counts were omitted, and typing the phrase still armed the button. The
   * section header promises the user sees what will be destroyed before anything happens;
   * that promise has to be a precondition, not a paragraph.
   */
  const phrase = preview?.confirmationPhrase ?? null;
  const armed = phrase !== null && confirmText.trim().toLowerCase() === phrase;

  return (
    <Page>
      <RunningHead
        section="Settings"
        lede="What this is connected to, what it has cost, and how to take your data with you
              or get rid of it."
      />

      {error && (
        <Notice tone="redline">
          {error}
          {/* The way back. Every other control that reloads this page lives inside a
              branch that only renders once the data it needs has arrived, so a mount
              fetch that failed left no control anywhere on screen and the only way
              forward was reloading the tab by hand. */}
          <div className="mt-3">
            <Button size="sm" disabled={busy !== null} onClick={refresh}>
              Try again
            </Button>
          </div>
        </Notice>
      )}

      <Section n="01" title="Model access" step={3}>
        {/* Yields to the banner above, as Applications already does. Keyed only on the
            data being absent, a failed fetch pulsed "Checking…" under a red error for
            the life of the page — the page looked like it was still working on it. */}
        {!access && !error && <p className="text-dim a-pulse">Checking…</p>}
        {access && (
          <div className="u-card-flat px-5 py-5">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Badge tone={access.available ? 'verified' : 'caution'}>
                {access.available ? 'connected' : 'not connected'}
              </Badge>
              <span className="text-dim">{access.description}</span>
            </div>

            {access.limitations.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {access.limitations.map((l, i) => (
                  <li key={i} className="text-dim u-prose text-[1rem]">
                    {l}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={busy !== null} onClick={() => void runTest()}>
                {busy === 'test' ? 'Testing…' : 'Test the connection'}
              </Button>
            </div>

            {testResult && (
              <Notice tone={testResult.ok ? 'verified' : 'caution'}>
                <span className="whitespace-pre-wrap">{testResult.detail}</span>
              </Notice>
            )}

            <p className="text-faint u-prose mt-4 text-[0.9375rem]">
              Drafting can run through the Claude Code CLI, against a subscription you already pay
              for, or through an Anthropic API key. Everything else here works without either.
            </p>
          </div>
        )}
      </Section>

      <Section n="02" title="What it has cost" step={4}>
        {!costs && !error && <p className="text-dim a-pulse">Reading the ledger…</p>}
        {costs && (
          <>
            <p className="text-dim u-prose mb-4">{costs.note}</p>

            {costs.byPurpose.length === 0 ? (
              <Empty title="No model calls recorded.">
                Every call gets written down as it happens, so this is a record rather than an
                estimate.
              </Empty>
            ) : (
              <div className="u-card-flat divide-rule/60 divide-y px-5 py-1">
                {costs.byPurpose.map((p) => (
                  <div key={p.purpose} className="flex items-baseline justify-between gap-6 py-2.5">
                    <span className="text-[1rem]">{p.purpose.replace(/_/g, ' ')}</span>
                    <span className="u-data text-dim">
                      {p.calls} {p.calls === 1 ? 'call' : 'calls'} · {money(p.usd)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Section>

      <Section n="03" title="Your data" step={5}>
        <div className="u-card-flat px-5 py-5">
          {/* This list named three things and left out the two largest. Your resume goes
              to the model whole at G1, before there is any answer to draft, and the full
              text of a posting goes with it whenever requirements are extracted, which is
              the default on every Recompute. A closed list is worth keeping — it is what
              someone comes to this page to read — but it has to be the real one, and it
              now points at the ledger above, which counts every model call as it is made.
              Anything added that talks to the network belongs in this paragraph. */}
          <p className="text-dim u-prose">
            Everything is stored on this machine. Some of it does leave, and this is the whole list:
            the job-source lookups discovery runs, your resume when the model reads it at G1, the
            search brief — role keywords and a location, nothing personal — when the web-search
            source runs, the text of a posting when its requirements are extracted, whatever is sent
            to the model while you draft or check an answer, and the application sites themselves.
            Every one of those model calls is counted in the ledger above, by purpose. You can take
            all of it with you at any time.
          </p>
          <div className="mt-4">
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() =>
                void downloadFile('/api/privacy/export', 'internship-applier-export.json').catch(
                  (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
                )
              }
            >
              Export everything
            </Button>
          </div>
          <p className="text-faint mt-3 text-[0.9375rem]">
            One JSON file, decrypted, including your resume, contact details, and every answer you
            wrote. Keep it somewhere safe.
          </p>
        </div>
      </Section>

      <Section n="04" title="Delete everything" step={6}>
        {deleted ? (
          /* Green only when everything really went. A delete that left files behind used to
             report in the same green as one that did not, with the list of survivors dropped
             on the client — on the one screen whose whole promise is that nothing is kept. */
          <Notice tone={deleted.failed.length === 0 ? 'verified' : 'caution'}>
            {deleted.message}
            {deleted.failed.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {deleted.failed.map((f) => (
                  <li key={f.path} className="u-prose text-[0.9375rem]">
                    <span className="u-data">{f.path}</span> — {f.reason}
                  </li>
                ))}
              </ul>
            )}
          </Notice>
        ) : preview === null ? (
          <div className="u-card-flat px-5 py-5">
            {/* The precondition holds either way, but saying "loading" over a failed
                fetch promised something that was never going to arrive. */}
            <p className="text-dim u-prose">
              {error ? 'Could not read what is stored.' : 'Loading what is stored.'} Nothing can be
              deleted until this page can tell you exactly what would go.
            </p>
          </div>
        ) : (
          <div className="u-tint-redline rounded px-5 py-5">
            <p className="text-dim u-prose">{preview.warning}</p>

            {preview.items.some((i) => i.count > 0) && (
              <ul className="mt-4 space-y-1">
                {preview.items
                  .filter((i) => i.count > 0)
                  .map((i) => (
                    <li key={i.label} className="u-data text-dim">
                      {i.count} · {i.label}
                    </li>
                  ))}
              </ul>
            )}

            <div className="mt-5 max-w-md">
              <TextField
                label={`Type "${phrase}" to confirm`}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={phrase ?? undefined}
              />
            </div>

            <div className="mt-3">
              <Button
                variant="danger"
                disabled={!armed || busy !== null}
                onClick={() => void runDelete()}
              >
                {busy === 'delete' ? 'Deleting…' : 'Delete everything permanently'}
              </Button>
            </div>
          </div>
        )}
      </Section>
    </Page>
  );
}
