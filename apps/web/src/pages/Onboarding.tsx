import { useCallback, useRef, useState } from 'react';
import type { CandidateProfile } from '@ia/shared';
import * as api from '../lib/api';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Button, Notice, SelectField, TextField } from '../components/Controls';

type Step = 'upload' | 'confirm' | 'facts' | 'done';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('upload');
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const flagged = useCallback(
    (path: string) => profile?.needsReview.includes(path) ?? false,
    [profile],
  );

  /** Reads a dotted path out of the profile, so `clears` can check its own field. */
  function at(obj: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
  }

  const patch = useCallback((fn: (p: CandidateProfile) => CandidateProfile, clears?: string) => {
    setProfile((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      if (!clears) return next;

      /**
       * A flag clears only when the field now holds an answer.
       *
       * Any onChange used to clear it, including a change BACK to the unanswered value.
       * The work-authorization select exposes its "Select…" placeholder as a real option,
       * and home city and state accept an empty string, so a user could satisfy three of
       * the six facts G1 exists to collect by touching a control and undoing it — and
       * confirm a profile whose location and work authorization are still blank. G1 only
       * means something if it checks the value rather than the interaction.
       */
      const value = at(next, clears);
      const answered =
        typeof value === 'string' ? value.trim() !== '' && value !== 'unknown' : true;
      return answered
        ? { ...next, needsReview: next.needsReview.filter((f) => f !== clears) }
        : { ...next, needsReview: [...new Set([...next.needsReview, clears])] };
    });
  }, []);

  async function persist() {
    if (!profile) return;
    setBusy('Saving…');
    setError(null);
    try {
      setProfile(await api.saveProfile(profile));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    setBusy('Confirming…');
    setError(null);
    try {
      await api.saveProfile(profile!);
      await api.confirmProfile();
      setStep('done');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const remaining = profile?.needsReview.length ?? 0;

  return (
    <Page>
      <RunningHead
        section="Establish the file"
        gate="G1"
        lede="Your resume is read once and turned into a structured profile. Everything the reader
              was unsure about is flagged, and nothing downstream runs until you have corrected it
              yourself."
      />

      {error && <Notice tone="redline">{error}</Notice>}
      {busy && <p className="u-data text-accent mb-6">{busy}</p>}

      {step === 'upload' && (
        <UploadStep
          onExtracted={(p) => {
            setProfile(p);
            setStep('confirm');
          }}
          onError={setError}
          setBusy={setBusy}
        />
      )}

      {step === 'confirm' && profile && (
        <>
          <Section n="02" title="What the reader found" step={3}>
            <div className="divide-rule/60 divide-y">
              <TextField
                label="Full name"
                value={profile.fullName}
                flagged={flagged('fullName')}
                onChange={(e) => patch((p) => ({ ...p, fullName: e.target.value }), 'fullName')}
              />
              <TextField
                label="Email"
                type="email"
                value={profile.email}
                flagged={flagged('email')}
                onChange={(e) => patch((p) => ({ ...p, email: e.target.value }), 'email')}
              />
              <TextField
                label="Phone"
                value={profile.phone ?? ''}
                onChange={(e) => patch((p) => ({ ...p, phone: e.target.value }), 'phone')}
              />
            </div>

            <dl className="mt-8 space-y-1">
              <Summary label="Education" n={profile.education.length} />
              <Summary label="Experience" n={profile.experience.length} />
              <Summary label="Projects" n={profile.projects.length} />
              <Summary label="Skills" n={profile.skills.length} />
            </dl>
            <p className="text-faint mt-4 text-[0.9375rem] italic">
              Editing individual jobs, projects and courses is not built yet. Correct the identity
              fields here and the eligibility facts below; those are the ones matching depends on.
            </p>
          </Section>

          <div className="flex gap-3">
            <Button onClick={() => void persist()}>Save</Button>
            <Button variant="primary" onClick={() => setStep('facts')}>
              Continue
            </Button>
          </div>
        </>
      )}

      {step === 'facts' && profile && (
        <>
          <Section n="03" title="What a resume never says" step={3}>
            <p className="text-dim mb-6 u-prose text-[1rem]">
              Eligibility turns on these six facts, and none of them appear on a resume. Each one is
              stored encrypted on this machine.
            </p>

            <div className="divide-rule/60 divide-y">
              <TextField
                label="Date of birth"
                type="date"
                hint="Many postings require 18+. Used only for local filtering, never auto-filled into a form."
                value={profile.dateOfBirth ?? ''}
                flagged={flagged('dateOfBirth')}
                onChange={(e) =>
                  patch((p) => ({ ...p, dateOfBirth: e.target.value || null }), 'dateOfBirth')
                }
              />

              <SelectField
                label="Work authorization"
                hint="Drives the sponsorship and citizenship rules."
                value={profile.workAuthorization.status}
                flagged={flagged('workAuthorization.status')}
                onChange={(e) =>
                  patch(
                    (p) => ({
                      ...p,
                      workAuthorization: {
                        ...p.workAuthorization,
                        status: e.target.value as CandidateProfile['workAuthorization']['status'],
                        needsSponsorship: e.target.value === 'requires_sponsorship',
                      },
                    }),
                    'workAuthorization.status',
                  )
                }
              >
                <option value="unknown">Select…</option>
                <option value="citizen">US citizen</option>
                <option value="permanent_resident">Permanent resident</option>
                <option value="student_visa">Student visa (F-1/J-1)</option>
                <option value="work_visa">Work visa</option>
                <option value="requires_sponsorship">Will need sponsorship</option>
                <option value="other">Other</option>
              </SelectField>

              <TextField
                label="Available from"
                type="date"
                hint="A posting's term must overlap this window by at least six weeks."
                value={profile.availability.start ?? ''}
                flagged={flagged('availability.start')}
                onChange={(e) =>
                  patch(
                    (p) => ({ ...p, availability: { ...p.availability, start: e.target.value } }),
                    'availability.start',
                  )
                }
              />
              <TextField
                label="Available until"
                type="date"
                value={profile.availability.end ?? ''}
                flagged={flagged('availability.end')}
                onChange={(e) =>
                  patch(
                    (p) => ({ ...p, availability: { ...p.availability, end: e.target.value } }),
                    'availability.end',
                  )
                }
              />
              <TextField
                label="Home city"
                hint="Commute radius is measured from here. Remote postings ignore it."
                value={profile.locationPrefs.base.city}
                flagged={flagged('locationPrefs.base.city')}
                onChange={(e) =>
                  patch(
                    (p) => ({
                      ...p,
                      locationPrefs: {
                        ...p.locationPrefs,
                        base: { ...p.locationPrefs.base, city: e.target.value },
                      },
                    }),
                    'locationPrefs.base.city',
                  )
                }
              />
              <TextField
                label="State"
                value={profile.locationPrefs.base.region}
                flagged={flagged('locationPrefs.base.region')}
                onChange={(e) =>
                  patch(
                    (p) => ({
                      ...p,
                      locationPrefs: {
                        ...p.locationPrefs,
                        base: { ...p.locationPrefs.base, region: e.target.value },
                      },
                    }),
                    'locationPrefs.base.region',
                  )
                }
              />
            </div>
          </Section>

          <Section n="04" title="Sign off" step={4}>
            {remaining > 0 ? (
              <Notice tone="caution">
                {remaining} field{remaining === 1 ? '' : 's'} still flagged. Confirmation is blocked
                until each one has been looked at. That is the whole point of this gate.
                {/* Every flag needs a way to be cleared here. The extractor can flag a
                    field this wizard has no input for — anything nested in education or
                    experience — and without a control those flags could never be cleared,
                    which locked G1 shut with no way forward. */}
                <ul className="mt-3 space-y-1.5">
                  {profile.needsReview.slice(0, 12).map((f) => (
                    <li key={f} className="flex flex-wrap items-center justify-between gap-3">
                      <span className="u-data">{f}</span>
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() =>
                          void api
                            .clearReviewFlag(f)
                            .then(setProfile)
                            .catch((e: unknown) =>
                              setError(e instanceof Error ? e.message : String(e)),
                            )
                        }
                      >
                        I have checked this
                      </Button>
                    </li>
                  ))}
                </ul>
                {profile.needsReview.length > 12 && (
                  <p className="text-faint mt-2 text-[0.9375rem]">
                    and {profile.needsReview.length - 12} more
                  </p>
                )}
              </Notice>
            ) : (
              <Notice tone="verified">
                Nothing left flagged. Confirming unlocks discovery and matching.
              </Notice>
            )}

            <div className="mt-4 flex gap-3">
              <Button onClick={() => setStep('confirm')}>Back</Button>
              <Button variant="primary" disabled={remaining > 0} onClick={() => void confirm()}>
                Confirm profile
              </Button>
            </div>
          </Section>
        </>
      )}

      {step === 'done' && (
        <Section n="05" title="Confirmed" step={3}>
          <div className="u-tint-verified rounded px-5 py-6">
            <p className="a-stamp u-data text-verified mb-3 text-lg tracking-widest uppercase">
              profile established
            </p>
            <p className="text-dim">Discovery and matching are now unlocked.</p>
          </div>
        </Section>
      )}
    </Page>
  );
}

function UploadStep({
  onExtracted,
  onError,
  setBusy,
}: {
  onExtracted: (p: CandidateProfile) => void;
  onError: (m: string) => void;
  setBusy: (m: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState<string | null>(null);

  async function handle(file: File) {
    setFilename(file.name);
    onError('');
    try {
      setBusy('Storing the document…');
      const { documentId } = await api.uploadResume(file);
      setBusy('Reading it. This takes a few seconds…');
      const { profile } = await api.extractResume(documentId);
      onExtracted(profile);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section n="01" title="Your resume" step={3}>
      <button
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) void handle(f);
        }}
        className="border-rule hover:border-accent w-full border border-dashed px-6 py-14 text-center transition-colors"
      >
        <span className="u-data text-dim block">
          {filename ?? 'drop a file, or click to choose'}
        </span>
        <span className="text-faint mt-2 block text-[0.9375rem]">PDF, DOCX, TXT, or Markdown</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.txt,.md"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handle(f);
        }}
      />
      <p className="text-faint mt-5 u-prose text-[0.9375rem]">
        PDFs are read directly by the model rather than through a text-extraction library. The model
        handles scans and multi-column layouts better. <em>The file stays on this machine.</em>
      </p>
    </Section>
  );
}

function Summary({ label, n }: { label: string; n: number }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-dim text-[1rem]">{label}</dt>
      <dd className="u-data" style={{ color: n > 0 ? 'var(--ink)' : 'var(--ink-faint)' }}>
        {n === 0 ? 'none found' : `${n} entr${n === 1 ? 'y' : 'ies'}`}
      </dd>
    </div>
  );
}
