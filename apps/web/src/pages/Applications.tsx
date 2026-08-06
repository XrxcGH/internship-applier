import { useCallback, useEffect, useState } from 'react';
import {
  addQuestion,
  ApiError,
  approveAnswer,
  deleteAnswer,
  draftAnswer,
  getApplication,
  listApplications,
  saveAnswer,
  unapproveAnswer,
  type ApplicationDetail,
  type ApplicationSummary,
} from '../lib/api';
import { Field, Page, RunningHead, Section } from '../components/Chrome';
import { Badge, Button, Empty, Notice, TextArea } from '../components/Controls';
import { AnswerReview } from '../components/AnswerReview';
import { FillReview } from '../components/FillReview';

/** Questions worth having on hand — most applications ask some version of these. */
const COMMON_QUESTIONS = [
  'Why do you want to work here?',
  'Tell us about a project you are proud of.',
  'Describe a technical challenge you worked through.',
  'What are you hoping to learn from this internship?',
  'Is there anything else you would like us to know?',
];

export function Applications({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState<ApplicationSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listApplications()
      .then(setList)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  if (openId) {
    return (
      <Detail
        id={openId}
        // The list row is the only thing that knows whether this one has been submitted:
        // GET /api/applications/:id answers with the posting and the answers and nothing
        // about the application's own state. Without it the fill panel offered to open
        // and fill a form the user had already told it they sent.
        submittedAt={list?.find((a) => a.id === openId)?.submittedAt ?? null}
        onBack={() => {
          setOpenId(null);
          refresh();
        }}
      />
    );
  }

  return (
    <Page wide>
      <RunningHead
        section="Applications"
        gate="G3"
        lede={
          <>
            Everything you approved in the queue. Each one needs its questions answered and every
            answer <em>read</em> before anything gets filled in.
          </>
        }
      />

      {error && <Notice tone="redline">{error}</Notice>}

      {/* Yields to the error, as Tracker already does. Keyed only on 'list === null',
          a failed load pulsed "Loading…" under the red banner forever. */}
      {list === null && !error && <p className="text-dim a-pulse text-sm">Loading…</p>}

      {list?.length === 0 && (
        <Empty title="No applications yet.">
          Approve a posting in the queue and it lands here.{' '}
          <button onClick={onBack} className="text-accent underline underline-offset-4">
            Open the queue
          </button>
        </Empty>
      )}

      {list && list.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2">
          {list.map((a, i) => {
            const ready = a.answerCount > 0 && a.approvedCount === a.answerCount;
            return (
              <li key={a.id} className={`a-rise a-step-${String(Math.min(i + 2, 8))}`}>
                <button
                  onClick={() => setOpenId(a.id)}
                  className="u-card hover:border-rule-strong block w-full px-5 py-5 text-left transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="u-eyebrow truncate">{a.company}</p>
                      <p className="mt-1.5 text-[1.125rem] leading-snug">{a.title}</p>
                    </div>
                    {/* A brand-new application has nothing to review, and saying "in
                        review" directly above "no questions yet" reads as a bug. The
                        detail header already distinguishes this case. */}
                    {/* Submitted outranks everything else on the card. An application
                        the user has already sent still has every answer approved, so it
                        was badged "ready" — reading as work still to do. */}
                    {a.submittedAt ? (
                      <Badge tone="verified">submitted</Badge>
                    ) : a.blockedCount > 0 ? (
                      <Badge tone="redline">{a.blockedCount} flagged</Badge>
                    ) : a.answerCount === 0 ? (
                      <Badge>no questions yet</Badge>
                    ) : ready ? (
                      <Badge tone="verified">ready</Badge>
                    ) : (
                      <Badge tone="caution">in review</Badge>
                    )}
                  </div>

                  <div className="border-rule mt-4 border-t pt-3">
                    <Field
                      label="Answers approved"
                      value={
                        a.answerCount === 0
                          ? 'no questions yet'
                          : `${a.approvedCount} of ${a.answerCount}`
                      }
                      tone={ready ? 'var(--verified)' : undefined}
                    />
                    {a.deadlineAt && <Field label="Closes" value={a.deadlineAt.slice(0, 10)} />}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}

function Detail({
  id,
  submittedAt,
  onBack,
}: {
  id: string;
  submittedAt: string | null;
  onBack: () => void;
}) {
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newQuestion, setNewQuestion] = useState('');
  /**
   * The two things the server says once and never says again.
   *
   * `unresolved` — the draft still had unsupported claims after the model's own revision —
   * and the style note come back on the draft and the save responses only. Neither is
   * stored with the answer, so the refresh that follows every action re-fetched a payload
   * without them and both were thrown away unread. AnswerReview renders each of them, so
   * the sentence telling someone the MODEL failed rather than they did had never once
   * reached the screen. Kept beside the answers and merged in below.
   */
  const [notes, setNotes] = useState<
    Record<string, { styleNote?: string | null; unresolved?: boolean }>
  >({});

  const refresh = useCallback(() => {
    getApplication(id)
      .then(setApp)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  useEffect(refresh, [refresh]);

  /**
   * Wraps an action so every failure surfaces as a sentence rather than a dead button.
   *
   * Returns whether it worked, because some callers need to know. The editor in
   * AnswerReview closes on save, and closing it after a FAILED save threw away whatever
   * the user had typed — the view falls back to the stored text and there is no copy of
   * the new one anywhere.
   *
   * The key is always `verb:id`. Drafting used to pass the bare answer id while its four
   * siblings passed prefixes, and the value handed to AnswerReview recognised only two of
   * the five — so a save, a reopen or a delete left every button on the card enabled and
   * a second click fired the request again.
   */
  const run = async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      refresh();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'UNVERIFIED_CLAIMS') {
        // The server refused. Refresh so the flags it just recomputed are visible.
        refresh();
      }
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!app) {
    return (
      <Page wide>
        <Button onClick={onBack}>← Applications</Button>
        {error ? (
          <Notice tone="redline">{error}</Notice>
        ) : (
          <p className="text-dim a-pulse mt-8 text-sm">Loading…</p>
        )}
      </Page>
    );
  }

  const approved = app.answers.filter((a) => a.approvedAt).length;
  const ready = app.answers.length > 0 && approved === app.answers.length;

  return (
    <Page wide>
      <div className="mb-8">
        <Button onClick={onBack}>← Applications</Button>
      </div>

      <RunningHead section={app.title} gate="G3" />

      <div className="mb-10 flex flex-wrap items-center gap-3">
        <Badge tone="accent">{app.company}</Badge>
        <Badge tone={ready ? 'verified' : 'caution'}>
          {app.answers.length === 0
            ? 'no questions yet'
            : `${approved} of ${app.answers.length} approved`}
        </Badge>
        {app.canDraft ? (
          <Badge tone="verified">{app.modelAccess.description}</Badge>
        ) : (
          <Badge tone="caution">no model — write answers yourself</Badge>
        )}
      </div>

      {error && <Notice tone="redline">{error}</Notice>}

      {/* A user who cannot draft needs to know the rest of the tool still works, or they
          will reasonably conclude it is broken and stop. */}
      {!app.canDraft && (
        <Notice tone="caution">
          <strong>Drafting is unavailable.</strong> {app.modelAccess.description} You can still
          write each answer yourself: it gets fact-checked against your profile, flagged for
          machine-sounding phrasing, and measured against your voice exactly the same way.
        </Notice>
      )}

      <Section n="01" title="Questions from the form" step={3}>
        {app.answers.length === 0 ? (
          <Empty title="No questions added yet.">
            Paste each free-text question from the application below. Reading them off the page
            directly is not something this tool does yet.
          </Empty>
        ) : (
          <div className="space-y-6">
            {app.answers.map((a) => (
              <AnswerReview
                key={a.id}
                answer={{ ...a, ...notes[a.id] }}
                canDraft={app.canDraft}
                busy={busy}
                onDraft={() =>
                  void run(`draft:${a.id}`, async () => {
                    const drafted = await draftAnswer(a.id);
                    setNotes((n) => ({
                      ...n,
                      [a.id]: { styleNote: drafted.styleNote, unresolved: drafted.unresolved },
                    }));
                  })
                }
                onSave={(text) =>
                  run(`save:${a.id}`, async () => {
                    const saved = await saveAnswer(a.id, text);
                    // The whole entry is replaced rather than merged: the user has just
                    // rewritten the text, so whatever the model failed to resolve in its
                    // own draft is no longer a statement about what is on screen.
                    setNotes((n) => ({ ...n, [a.id]: { styleNote: saved.styleNote } }));
                  })
                }
                onApprove={() => void run(`approve:${a.id}`, () => approveAnswer(a.id))}
                onUnapprove={() => void run(`un:${a.id}`, () => unapproveAnswer(a.id))}
                onDelete={() => void run(`del:${a.id}`, () => deleteAnswer(a.id))}
              />
            ))}
          </div>
        )}
      </Section>

      <Section n="02" title="Add a question" step={4}>
        <TextArea
          value={newQuestion}
          onChange={(e) => setNewQuestion(e.target.value)}
          rows={3}
          placeholder="Paste the question exactly as the form asks it."
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="solid"
            disabled={newQuestion.trim().length < 3 || busy !== null}
            onClick={() =>
              void run('add', async () => {
                await addQuestion(id, newQuestion.trim());
                setNewQuestion('');
              })
            }
          >
            Add question
          </Button>
          <span className="text-faint text-[0.9375rem]">
            If you have answered it before, the previous answer is pulled in automatically.
          </span>
        </div>

        <div className="mt-6">
          <p className="u-eyebrow mb-2.5">Common ones</p>
          <div className="flex flex-wrap gap-2">
            {COMMON_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => setNewQuestion(q)}
                className="u-card-flat hover:border-rule-strong text-dim hover:text-ink rounded-full px-3 py-1.5 text-[0.9375rem] transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section n="03" title="Fill the form" step={5}>
        <p className="text-faint u-prose mb-5 text-[1rem]">
          Sensitive fields are <em>never</em> auto-filled: government IDs, bank details, passwords,
          demographic questions, and anything you have to attest to. Each one gets listed for you
          with the reason.
        </p>
        <FillReview
          applicationId={app.id}
          applyUrl={app.applyUrl}
          canFill={app.answers.length > 0 && ready}
          blockedReason={
            app.answers.length === 0
              ? 'Add the form’s questions above and approve an answer for each one first.'
              : `${app.answers.length - approved} of ${app.answers.length} answers still need your approval (gate G3).`
          }
          submittedAt={submittedAt}
          onChanged={refresh}
        />
      </Section>
    </Page>
  );
}
