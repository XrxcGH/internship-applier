import { useState } from 'react';
import {
  continueFill,
  discardFill,
  markSubmitted,
  startFill,
  type FillFieldResult,
  type FillRunView,
} from '../lib/api';
import { Badge, Button, Empty, Notice } from './Controls';

/**
 * Gate G4 — the pre-submit review.
 *
 * This screen exists to be the last thing between a filled form and a person's name on
 * it, so it is built around what still needs them rather than what got done. The counts
 * lead with "left for you", the fields that need attention sort to the top, and the only
 * button that says anything about submitting is the one that records that the USER did.
 *
 * There is no button here that submits. Not a disabled one, not one behind a
 * confirmation. The tool opens the page, fills what it can, and stops.
 */

const STATUS_TONE = {
  ok: 'verified',
  mismatch: 'caution',
  failed: 'redline',
  skipped: 'caution',
} as const;

const STATUS_LABEL = {
  ok: 'filled',
  mismatch: 'check this',
  failed: 'could not fill',
  skipped: 'left for you',
} as const;

/** Needs-attention first. A list that opens with thirty green rows buries the four amber ones. */
function ordered(fields: FillFieldResult[]): FillFieldResult[] {
  const rank = { failed: 0, mismatch: 1, skipped: 2, ok: 3 };
  return [...fields].sort((a, b) => rank[a.status] - rank[b.status]);
}

export function FillReview({
  applicationId,
  applyUrl,
  canFill,
  blockedReason,
  onChanged,
}: {
  applicationId: string;
  applyUrl: string;
  canFill: boolean;
  blockedReason: string | null;
  onChanged: () => void;
}) {
  const [run, setRun] = useState<FillRunView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<FillRunView | null>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      setRun(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  if (!canFill) {
    return (
      <Notice tone="caution">
        <strong>Not ready to fill yet.</strong>{' '}
        {blockedReason ?? 'Approve every answer first (gate G3).'}
      </Notice>
    );
  }

  const needsAttention = run?.fields?.filter((f) => f.status !== 'ok').length ?? 0;

  return (
    <div className="space-y-5">
      {error && <Notice tone="redline">{error}</Notice>}

      {!run && (
        <div className="u-card-flat px-5 py-5">
          <p className="text-dim u-prose">
            This opens the application page in a browser you can watch, reads the form, and shows
            you what it plans to type <em>before</em> typing anything.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="solid"
              disabled={busy !== null}
              onClick={() => void act('start', () => startFill(applicationId))}
            >
              {busy === 'start' ? 'Opening…' : 'Open and read the form'}
            </Button>
            <a
              href={applyUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="u-data border-rule text-dim hover:text-ink hover:border-rule-strong hover:bg-ink/[0.04] inline-flex items-center rounded border px-4 py-2 tracking-wide uppercase transition-colors"
            >
              Open posting myself ↗
            </a>
          </div>
        </div>
      )}

      {run?.intervention && (
        <Notice tone="caution">
          <strong>
            {run.intervention.reason === 'login' ? 'This site wants you signed in.' : 'Bot check.'}
          </strong>{' '}
          {run.intervention.detail}
          <div className="mt-3">
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null}
              onClick={() => void act('continue', () => continueFill(applicationId))}
            >
              {busy === 'continue' ? 'Checking…' : 'I have done that, continue'}
            </Button>
          </div>
        </Notice>
      )}

      {run && !run.intervention && run.state !== 'done' && (
        <div className="u-card-flat px-5 py-5">
          <p className="u-eyebrow mb-2">What it found</p>
          <p className="text-dim">{run.summary ?? run.message}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="solid"
              disabled={busy !== null}
              onClick={() => void act('continue', () => continueFill(applicationId))}
            >
              {busy === 'continue' ? 'Filling…' : 'Fill the form'}
            </Button>
            <Button
              disabled={busy !== null}
              onClick={() =>
                void act('discard', async () => {
                  await discardFill(applicationId);
                  return null;
                })
              }
            >
              Close the browser
            </Button>
          </div>
        </div>
      )}

      {run?.state === 'done' && run.counts && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={needsAttention === 0 ? 'verified' : 'caution'}>
              {run.counts.filled} filled
            </Badge>
            {run.counts.skipped > 0 && (
              <Badge tone="caution">{run.counts.skipped} left for you</Badge>
            )}
            {run.counts.mismatched > 0 && (
              <Badge tone="caution">{run.counts.mismatched} to check</Badge>
            )}
            {run.counts.failed > 0 && <Badge tone="redline">{run.counts.failed} failed</Badge>}
          </div>

          <p className="text-dim u-prose">{run.message}</p>

          <div className="u-card overflow-hidden">
            <ul className="divide-rule/60 divide-y">
              {ordered(run.fields ?? []).map((f, i) => (
                <li key={i} className="flex flex-wrap items-start gap-4 px-5 py-3.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[1rem] leading-snug">{f.label}</span>
                    {f.note && (
                      <span className="text-dim mt-1 block text-[0.9375rem] leading-snug">
                        {f.note}
                      </span>
                    )}
                    {f.status === 'ok' && f.readBack && (
                      <span className="u-data text-faint mt-1 block truncate">{f.readBack}</span>
                    )}
                  </span>
                  <Badge tone={STATUS_TONE[f.status]}>{STATUS_LABEL[f.status]}</Badge>
                </li>
              ))}
            </ul>
          </div>

          {/* The gate itself. */}
          <div className="u-tint-accent rounded px-5 py-5">
            <p className="u-eyebrow mb-2">Gate G4</p>
            <p className="text-dim u-prose">
              The browser is still open on the filled form. Read it, complete anything left for you,
              and <strong>submit it yourself</strong>. This tool has no button that submits an
              application, by design.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={() =>
                  void act('mark', () => markSubmitted(applicationId).then(() => null))
                }
              >
                {busy === 'mark' ? 'Recording…' : 'I submitted it'}
              </Button>
              <Button
                disabled={busy !== null}
                onClick={() =>
                  void act('discard', async () => {
                    await discardFill(applicationId);
                    return null;
                  })
                }
              >
                Close the browser
              </Button>
            </div>
          </div>
        </>
      )}

      {run?.state === 'failed' && <Empty title="The run could not finish.">{run.message}</Empty>}
    </div>
  );
}
