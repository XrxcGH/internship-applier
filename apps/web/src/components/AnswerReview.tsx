import { useMemo, useState } from 'react';
import type { Answer, AnswerEvidence } from '../lib/api';
import { Badge, Button, Empty, Notice } from './Controls';

/**
 * Gate G3 — one answer, reviewed.
 *
 * The design brief for this screen is a single sentence: make it faster to check a claim
 * than to ignore it. So the evidence sits beside the text rather than behind a
 * disclosure, clicking a highlighted sentence scrolls its evidence into view, and the
 * approve button states its own blocker instead of just going grey.
 */

const VERDICT_LABEL: Record<AnswerEvidence['verdict'], string> = {
  supported: 'Backed by your profile',
  inferred: 'Loosely tied to your profile',
  unsupported: 'Not in your profile',
  overstated: 'Overstates your profile',
};

const VERDICT_TONE: Record<AnswerEvidence['verdict'], 'verified' | 'caution' | 'redline'> = {
  supported: 'verified',
  inferred: 'caution',
  unsupported: 'redline',
  overstated: 'redline',
};

interface Segment {
  text: string;
  index: number | null;
  verdict: AnswerEvidence['verdict'] | null;
}

/**
 * Splits the answer into highlighted claims and the plain text between them.
 *
 * Spans are found here rather than trusted from the server: the user edits this text
 * locally, and a stale span would underline the wrong words — which is worse than no
 * underline at all. A claim that no longer appears verbatim simply stops highlighting.
 */
function segment(text: string, evidence: AnswerEvidence[]): Segment[] {
  const hits: Array<{ start: number; end: number; i: number }> = [];
  let cursor = 0;

  evidence.forEach((e, i) => {
    const at = text.indexOf(e.claim, cursor);
    if (at < 0) return;
    hits.push({ start: at, end: at + e.claim.length, i });
    cursor = at + e.claim.length;
  });

  const out: Segment[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start > pos) out.push({ text: text.slice(pos, h.start), index: null, verdict: null });
    out.push({ text: text.slice(h.start, h.end), index: h.i, verdict: evidence[h.i]!.verdict });
    pos = h.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), index: null, verdict: null });
  return out;
}

function EditMeter({ answer }: { answer: Answer }) {
  const draftWords = (answer.draftText.match(/\S+/g) ?? []).length;
  if (draftWords === 0) return null;
  const pct = Math.min(100, Math.round((answer.editDistance / draftWords) * 100));

  return (
    <div className="flex items-center gap-3">
      <div className="bg-sunk h-1 w-24 overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${String(Math.max(pct, 2))}%`, background: 'var(--accent)' }}
        />
      </div>
      <span className="text-faint text-[0.8125rem]">{answer.editSummary}</span>
    </div>
  );
}

export function AnswerReview({
  answer,
  canDraft,
  busy,
  onDraft,
  onSave,
  onApprove,
  onUnapprove,
  onDelete,
}: {
  answer: Answer;
  canDraft: boolean;
  busy: string | null;
  onDraft: () => void;
  onSave: (text: string) => void;
  onApprove: () => void;
  onUnapprove: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(answer.text);
  const [active, setActive] = useState<number | null>(null);

  const shown = editing ? text : answer.text;
  const segments = useMemo(
    () => segment(answer.text, answer.evidence),
    [answer.text, answer.evidence],
  );

  const blocking = answer.evidence.filter(
    (e) => e.verdict === 'unsupported' || e.verdict === 'overstated',
  );
  const tells = answer.flags.filter((f) => f.type === 'ai_tell');
  const drift = answer.flags.filter((f) => f.type === 'style_drift');
  const words = (answer.text.match(/\S+/g) ?? []).length;

  return (
    <article className="u-card overflow-hidden">
      {/* ── question */}
      <header className="border-rule flex flex-wrap items-start justify-between gap-4 border-b px-6 py-5">
        <div className="min-w-0 flex-1">
          <p className="text-[1.0625rem] leading-snug">{answer.questionText}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge>{answer.archetype.replace(/_/g, ' ')}</Badge>
            {words > 0 && <Badge>{words} words</Badge>}
            {answer.reusedFrom && (
              <Badge tone="accent">reused · {answer.reusedFrom.useCount}×</Badge>
            )}
          </div>
        </div>
        {answer.approvedAt ? (
          <span className="a-stamp u-data text-verified shrink-0 text-[0.6875rem] tracking-widest uppercase">
            approved
          </span>
        ) : (
          <span className="u-data text-faint shrink-0 text-[0.6875rem] tracking-widest uppercase">
            not approved
          </span>
        )}
      </header>

      {answer.text.trim().length === 0 ? (
        <div className="px-6 py-8">
          <Empty title="No answer yet.">
            {canDraft
              ? 'Draft one from your profile, or write it yourself. Either way it gets fact-checked.'
              : 'Write it yourself below. It still gets fact-checked against your profile.'}
          </Empty>
          <div className="mt-4 flex flex-wrap gap-3">
            {canDraft && (
              <Button variant="solid" onClick={onDraft} disabled={busy !== null}>
                {busy === 'draft' ? 'Drafting…' : 'Draft it'}
              </Button>
            )}
            <Button
              onClick={() => {
                setEditing(true);
                setText('');
              }}
            >
              Write it myself
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete}>
              Remove question
            </Button>
          </div>
        </div>
      ) : null}

      {(answer.text.trim().length > 0 || editing) && (
        <div className="grid gap-0 lg:grid-cols-[1fr_20rem]">
          {/* ── the answer */}
          <div className="border-rule px-6 py-5 lg:border-r">
            {editing ? (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={Math.max(8, Math.ceil(text.length / 70) + 2)}
                autoFocus
                className="border-rule focus:border-accent w-full resize-y rounded border bg-transparent p-4 leading-relaxed outline-none transition-colors"
              />
            ) : (
              <p className="text-[1.0625rem] leading-[1.8] whitespace-pre-wrap">
                {segments.map((s, i) =>
                  s.index === null ? (
                    <span key={i}>{s.text}</span>
                  ) : (
                    <span
                      key={i}
                      className={`u-claim u-claim-${s.verdict!}`}
                      data-active={active === s.index}
                      onClick={() => setActive(active === s.index ? null : s.index)}
                      title={VERDICT_LABEL[s.verdict!]}
                    >
                      {s.text}
                    </span>
                  ),
                )}
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
              <EditMeter answer={answer} />
              <div className="flex flex-wrap gap-2">
                {editing ? (
                  <>
                    <Button
                      variant="solid"
                      size="sm"
                      onClick={() => {
                        onSave(text);
                        setEditing(false);
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setText(answer.text);
                        setEditing(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        setText(answer.text);
                        setEditing(true);
                      }}
                    >
                      Edit
                    </Button>
                    {canDraft && (
                      <Button size="sm" onClick={onDraft} disabled={busy !== null}>
                        {busy === 'draft' ? 'Drafting…' : 'Redraft'}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* ── flags */}
            {blocking.length > 0 && (
              <div className="u-tint-redline mt-5 rounded px-4 py-3">
                <p className="u-data text-redline mb-2 text-[0.6875rem] tracking-widest uppercase">
                  {blocking.length === 1
                    ? '1 claim blocks approval'
                    : `${blocking.length} claims block approval`}
                </p>
                <ul className="space-y-2">
                  {blocking.map((b, i) => (
                    <li key={i} className="text-dim text-[0.9375rem]">
                      <span className="text-ink">“{b.claim}”</span>
                      <br />
                      {answer.flags.find((f) => f.type === 'unsupported' || f.type === 'overstated')
                        ?.note ?? VERDICT_LABEL[b.verdict]}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {tells.length > 0 && (
              <div className="u-tint-caution mt-4 rounded px-4 py-3">
                <p className="u-data text-caution mb-2 text-[0.6875rem] tracking-widest uppercase">
                  reads as machine-written
                </p>
                <ul className="text-dim space-y-1 text-[0.9375rem]">
                  {tells.slice(0, 6).map((t, i) => (
                    <li key={i}>{t.note}</li>
                  ))}
                </ul>
              </div>
            )}

            {drift.length > 0 && (
              <div className="text-faint mt-4 text-[0.9375rem]">
                {drift.map((d, i) => (
                  <p key={i}>{d.note}</p>
                ))}
              </div>
            )}

            {answer.styleNote && (
              <p className="text-faint mt-4 text-[0.8125rem] italic">{answer.styleNote}</p>
            )}

            {/* ── the gate */}
            <div className="border-rule mt-6 border-t pt-5">
              {answer.approvedAt ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-dim text-[0.9375rem]">
                    You approved this. It will be filled in for you; you still submit it yourself.
                  </span>
                  <Button size="sm" onClick={onUnapprove}>
                    Reopen
                  </Button>
                </div>
              ) : blocking.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-dim text-[0.9375rem]">
                    Fix the flagged {blocking.length === 1 ? 'claim' : 'claims'} above, or add the
                    missing facts to your profile.
                  </span>
                  <Button variant="solid" disabled title="Unverified claims block approval.">
                    Approve (G3)
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-dim text-[0.9375rem]">
                    Read it once more. Approving means you stand behind every sentence.
                  </span>
                  <Button
                    variant="solid"
                    onClick={onApprove}
                    disabled={busy !== null || editing || shown.trim().length === 0}
                  >
                    {busy === 'approve' ? 'Checking…' : 'Approve (G3)'}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* ── evidence */}
          <aside className="bg-sunk/40 px-5 py-5">
            <p className="u-eyebrow mb-3">Evidence</p>
            {answer.evidence.length === 0 ? (
              <p className="text-faint text-[0.875rem]">
                Nothing to check yet. Claims appear here as soon as there is text.
              </p>
            ) : (
              <ol className="space-y-3">
                {answer.evidence.map((e, i) => (
                  <li
                    key={i}
                    onClick={() => setActive(active === i ? null : i)}
                    className={`cursor-pointer rounded px-3 py-2.5 transition-colors ${
                      active === i ? 'bg-accent/12' : 'hover:bg-ink/[0.04]'
                    }`}
                  >
                    <div className="mb-1.5">
                      <Badge tone={VERDICT_TONE[e.verdict]}>{VERDICT_LABEL[e.verdict]}</Badge>
                    </div>
                    <p className="text-dim text-[0.8125rem] leading-snug">
                      {e.claim.length > 90 ? `${e.claim.slice(0, 90)}…` : e.claim}
                    </p>
                    {e.quote && (
                      <p className="u-quote mt-2 text-[0.75rem]">
                        {e.quote.length > 140 ? `${e.quote.slice(0, 140)}…` : e.quote}
                      </p>
                    )}
                    {e.profileRef && (
                      <p className="u-data text-faint mt-1.5 text-[0.6875rem]">{e.profileRef}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}

            {answer.unresolved && (
              <Notice tone="caution">
                The draft still had unsupported claims after one revision. That is the model
                failing, not you — edit it directly.
              </Notice>
            )}
          </aside>
        </div>
      )}
    </article>
  );
}
