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

      {list === null && <p className="text-dim a-pulse text-sm">Loading…</p>}

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
                    {a.blockedCount > 0 ? (
                      <Badge tone="redline">{a.blockedCount} flagged</Badge>
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

function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newQuestion, setNewQuestion] = useState('');

  const refresh = useCallback(() => {
    getApplication(id)
      .then(setApp)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  useEffect(refresh, [refresh]);

  /** Wraps an action so every failure surfaces as a sentence rather than a dead button. */
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'UNVERIFIED_CLAIMS') {
        // The server refused. Refresh so the flags it just recomputed are visible.
        refresh();
      }
      setError(err instanceof Error ? err.message : String(err));
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
            Open the application page and paste each free-text question below. Until form reading
            lands, this is how questions get in.
          </Empty>
        ) : (
          <div className="space-y-6">
            {app.answers.map((a) => (
              <AnswerReview
                key={a.id}
                answer={a}
                canDraft={app.canDraft}
                busy={busy === a.id ? 'draft' : busy === `approve:${a.id}` ? 'approve' : null}
                onDraft={() => void run(a.id, () => draftAnswer(a.id))}
                onSave={(text) => void run(`save:${a.id}`, () => saveAnswer(a.id, text))}
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

      <Section n="03" title="What happens next" step={5}>
        <div className="u-card-flat px-5 py-5">
          <p className="text-dim text-[1rem]">
            Once every answer is approved, this tool can fill the form for you. It stops at the
            submit button, <em>every time</em>. You read the filled page and click Submit{' '}
            <em>yourself</em>.
          </p>
          <p className="text-faint mt-3 text-[1rem]">
            Sensitive fields are <em>never</em> auto-filled: government IDs, bank details,
            passwords, demographic questions, and anything you have to attest to.
          </p>
          <div className="mt-4">
            <Button
              variant="primary"
              disabled
              title="Form filling arrives in M6. Nothing is submitted for you, ever."
            >
              Fill the form (M6)
            </Button>
          </div>
        </div>
      </Section>
    </Page>
  );
}
