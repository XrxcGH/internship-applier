import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  downloadFile,
  getDraftMessage,
  getTracker,
  setStatus,
  type Rate,
  type TrackedApp,
  type TrackerView,
} from '../lib/api';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Badge, Button, Empty, Notice } from '../components/Controls';

/**
 * The tracker — docs/11 § M7.
 *
 * Built around one idea: an applicant's real question is never "what is my response rate",
 * it is "what should I do next". So the nudges come first, the board is second, and the
 * numbers are last and refuse to say more than they know.
 */

const COLUMNS = [
  { key: 'preparing', label: 'Preparing', statuses: ['draft', 'answers_ready', 'filled'] },
  { key: 'to_submit', label: 'Ready for you', statuses: ['awaiting_submit'] },
  { key: 'waiting', label: 'Waiting', statuses: ['submitted', 'acknowledged'] },
  { key: 'talking', label: 'Talking', statuses: ['interview'] },
  { key: 'closed', label: 'Closed', statuses: ['offer', 'rejected', 'withdrawn', 'ghosted'] },
];

/** Statuses a person can select. `ghosted` is absent because it is derived, not chosen. */
const REPORTABLE = [
  { value: 'submitted', label: 'I submitted it' },
  { value: 'acknowledged', label: 'They acknowledged it' },
  { value: 'interview', label: 'Interviewing' },
  { value: 'offer', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

/**
 * A refused status change, said in words this screen has used before.
 *
 * The server answers with its own vocabulary — "Cannot go from draft to submitted. From
 * here: answers_ready, withdrawn." — and nobody using this board has ever seen
 * `answers_ready`. The refusal is not rare, either: it is what someone gets for the most
 * ordinary route through this tool, which is approving a posting at G2, applying on the
 * employer's own site through the ↗ link, and coming back here to record it. This tool
 * genuinely cannot record that yet, and the least it owes the person is a sentence in
 * English rather than a dump of its internal state names.
 */
function refusal(err: unknown, status: string): string {
  if (err instanceof ApiError && err.code === 'ILLEGAL_TRANSITION') {
    const label = REPORTABLE.find((r) => r.value === status)?.label ?? status;
    return (
      `This one cannot be moved to "${label}" from where it stands. ` +
      'Only an application that has been through the fill step can be reported as sent; ' +
      'until then the one status you can record is Withdrawn.'
    );
  }
  return err instanceof Error ? err.message : String(err);
}

const ATTENTION_TONE: Record<string, 'redline' | 'caution' | 'verified' | 'neutral'> = {
  deadline_passed: 'redline',
  deadline_soon: 'caution',
  awaiting_your_submit: 'caution',
  ready_to_fill: 'verified',
  unfinished: 'neutral',
  silent: 'neutral',
  none: 'neutral',
};

/** A rate, or the reason there is not one worth showing. */
function RateFigure({ label, rate }: { label: string; rate: Rate }) {
  return (
    <div className="u-card-flat px-5 py-4">
      <p className="u-eyebrow mb-1.5">{label}</p>
      {rate.value === null ? (
        <>
          <p className="u-data text-faint text-[1.25rem]">
            {rate.numerator} of {rate.denominator}
          </p>
          <p className="text-faint mt-1.5 text-[0.9375rem] leading-snug">{rate.why}</p>
        </>
      ) : (
        <>
          <p className="u-data text-ink text-[1.75rem]">{Math.round(rate.value * 100)}%</p>
          <p className="text-faint mt-1 text-[0.9375rem]">
            {rate.numerator} of {rate.denominator}
          </p>
        </>
      )}
    </div>
  );
}

function Card({
  app,
  onStatus,
  onDraft,
  busy,
}: {
  app: TrackedApp;
  onStatus: (status: string) => void;
  onDraft: () => void;
  busy: boolean;
}) {
  const tone = ATTENTION_TONE[app.derived.attention] ?? 'neutral';

  return (
    <li className="u-card px-4 py-4">
      <p className="u-eyebrow truncate">{app.company}</p>
      <p className="mt-1.5 text-[1rem] leading-snug">{app.title}</p>

      {app.derived.nudge && (
        <p
          className="mt-2.5 text-[0.9375rem] leading-snug"
          style={{ color: tone === 'neutral' ? 'var(--ink-dim)' : `var(--${tone})` }}
        >
          {app.derived.nudge}
        </p>
      )}

      <div className="border-rule mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        <Badge tone={tone === 'neutral' ? undefined : tone}>
          {app.derived.effectiveStatus.replace(/_/g, ' ')}
        </Badge>
        {app.source && <Badge>{app.source}</Badge>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          aria-label={`Report a status change for ${app.title} at ${app.company}`}
          className="u-data bg-raised text-ink border-rule focus:border-accent rounded border px-2 py-1.5 outline-none"
          value=""
          disabled={busy}
          onChange={(e) => e.target.value && onStatus(e.target.value)}
        >
          <option value="">Report…</option>
          {REPORTABLE.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        {(app.status === 'submitted' || app.derived.effectiveStatus === 'ghosted') && (
          <Button size="sm" onClick={onDraft}>
            Draft a follow-up
          </Button>
        )}
        <a
          href={app.applyUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open the posting for ${app.title} at ${app.company}`}
          className="u-data text-faint hover:text-ink px-1 py-1 transition-colors"
        >
          ↗
        </a>
      </div>
    </li>
  );
}

export function Tracker() {
  const [view, setView] = useState<TrackerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string; note: string } | null>(null);

  const refresh = useCallback(() => {
    getTracker()
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  const report = async (id: string, status: string): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await setStatus(id, status);
      refresh();
    } catch (err) {
      setError(refusal(err, status));
    } finally {
      setBusy(null);
    }
  };

  const showDraft = async (id: string): Promise<void> => {
    setError(null);
    try {
      const d = await getDraftMessage(id);
      setDraft({ text: d.text, note: d.note });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!view) {
    return (
      <Page wide>
        <RunningHead section="Tracker" />
        {error ? (
          <Notice tone="redline">{error}</Notice>
        ) : (
          <p className="text-dim a-pulse">Loading…</p>
        )}
      </Page>
    );
  }

  const { applications, reminders, stats } = view;

  return (
    <Page wide>
      <RunningHead
        section="Tracker"
        lede={
          <>
            Where every application stands, and what each one needs from you. Statuses after
            submitting are <em>yours to report</em>: this tool never submitted anything, so it has
            no way to know what happened next.
          </>
        }
      />

      {error && <Notice tone="redline">{error}</Notice>}

      {draft && (
        <div className="u-card mb-8 px-5 py-5">
          <div className="mb-3 flex items-start justify-between gap-4">
            <p className="u-eyebrow">Follow-up draft</p>
            <Button size="sm" onClick={() => setDraft(null)}>
              Close
            </Button>
          </div>
          <pre className="u-quote text-[0.9375rem] whitespace-pre-wrap">{draft.text}</pre>
          <p className="text-faint mt-3 text-[0.9375rem]">{draft.note}</p>
          <div className="mt-3">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void navigator.clipboard.writeText(draft.text)}
            >
              Copy
            </Button>
          </div>
        </div>
      )}

      {applications.length === 0 ? (
        <Empty title="Nothing tracked yet.">
          Approve a posting in the queue and it appears here.
        </Empty>
      ) : (
        <>
          {reminders.length > 0 && (
            <Section n="01" title="What needs you" step={3}>
              <ul className="space-y-2.5">
                {reminders.map((r, i) => (
                  <li
                    key={i}
                    className={`rounded px-4 py-3 ${r.urgency <= 1 ? 'u-tint-caution' : 'u-card-flat'}`}
                  >
                    <p className="text-[1rem] leading-snug">{r.headline}</p>
                    <p className="text-dim mt-1 text-[0.9375rem] leading-snug">{r.detail}</p>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section
            n={reminders.length > 0 ? '02' : '01'}
            title="The board"
            step={4}
            actions={
              <Button
                size="sm"
                onClick={() =>
                  void downloadFile('/api/tracker/export.csv', 'applications.csv').catch(
                    (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
                  )
                }
              >
                Export CSV
              </Button>
            }
          >
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-5">
              {COLUMNS.map((col) => {
                const inCol = applications.filter((a) =>
                  col.statuses.includes(a.derived.effectiveStatus),
                );
                return (
                  <div key={col.key}>
                    <p className="u-eyebrow border-rule mb-3 border-b pb-2">
                      {col.label} · {inCol.length}
                    </p>
                    {inCol.length === 0 ? (
                      <p className="text-faint text-[0.9375rem]">Empty.</p>
                    ) : (
                      <ul className="space-y-3">
                        {inCol.map((a) => (
                          <Card
                            key={a.id}
                            app={a}
                            busy={busy === a.id}
                            onStatus={(s) => void report(a.id, s)}
                            onDraft={() => void showDraft(a.id)}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          <Section n={reminders.length > 0 ? '03' : '02'} title="How it is going" step={5}>
            {stats.notes.length > 0 && (
              <ul className="mb-5 space-y-1.5">
                {stats.notes.map((n, i) => (
                  <li key={i} className="text-dim u-prose text-[1rem]">
                    {n}
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="u-card-flat px-5 py-4">
                <p className="u-eyebrow mb-1.5">Submitted</p>
                <p className="u-data text-ink text-[1.75rem]">{stats.funnel.submitted}</p>
                <p className="text-faint mt-1 text-[0.9375rem]">of {stats.funnel.total} tracked</p>
              </div>
              <RateFigure label="Heard back" rate={stats.responseRate} />
              <RateFigure label="Reached interview" rate={stats.interviewRate} />
              <div className="u-card-flat px-5 py-4">
                <p className="u-eyebrow mb-1.5">Typical reply time</p>
                {stats.medianDaysToResponse === null ? (
                  <p className="text-faint text-[0.9375rem] leading-snug">
                    Not enough replies yet to say.
                  </p>
                ) : (
                  <p className="u-data text-ink text-[1.75rem]">
                    {stats.medianDaysToResponse} days
                  </p>
                )}
              </div>
            </div>

            <p className="text-faint u-prose mt-5 text-[0.9375rem] italic">
              Percentages only appear once there are enough applications for one to mean something.
              Below that you get the counts, which are the honest version.
            </p>
          </Section>
        </>
      )}
    </Page>
  );
}
