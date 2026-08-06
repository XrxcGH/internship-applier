import { useCallback, useEffect, useRef, useState } from 'react';
import type { CandidateProfile } from '@ia/shared';
import * as api from '../lib/api';
import { ANSWERED_IN_WIZARD, isAnswered } from '../lib/review';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Button, Notice, SelectField, TextField } from '../components/Controls';

type Step = 'upload' | 'confirm' | 'facts' | 'done';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('upload');
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Picks up the profile that already exists, if there is one.
   *
   * Without this, "Revisit profile" dropped a confirmed user back on the dropzone with no
   * way past it except uploading their resume a second time — so correcting a home city
   * meant re-extracting the whole document.
   */
  useEffect(() => {
    let cancelled = false;
    api
      .getProfile()
      .then((p) => {
        if (cancelled || !p) return;
        // Never overtakes an upload that is already running: whatever the extractor
        // produces is newer than what was on disk when this request went out.
        setStep((s) => (s === 'upload' ? 'confirm' : s));
        setProfile((prev) => prev ?? p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      return isAnswered(at(next, clears))
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

  /**
   * Marks one flag reviewed without throwing away what is typed on this step.
   *
   * The endpoint answers with the profile as it stands ON DISK, and this screen replaces
   * its whole state with that answer. So clearing a flag straight from the wizard blanked
   * every date, city and selection entered since the last Save, brought back the flags
   * those answers had already cleared, pushed the "still flagged" count back up, and said
   * nothing at all about why. Saving first makes the profile that comes back the one the
   * user is looking at.
   */
  async function checkedOff(path: string) {
    if (!profile) return;
    setBusy('Saving…');
    setError(null);
    try {
      await api.saveProfile(profile);
      setProfile(await api.clearReviewFlag(path));
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
          busy={busy}
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

          <div className="flex flex-wrap gap-3">
            <Button disabled={busy !== null} onClick={() => void persist()}>
              Save
            </Button>
            <Button variant="primary" disabled={busy !== null} onClick={() => setStep('facts')}>
              Continue
            </Button>
            {/* The way back to the dropzone. This screen is where anyone who already has a
                profile now lands, so without it a new resume could never be uploaded a
                second time. */}
            <Button disabled={busy !== null} onClick={() => setStep('upload')}>
              Upload a different resume
            </Button>
          </div>
        </>
      )}

      {step === 'facts' && profile && (
        <>
          <Section n="03" title="What a resume never says" step={3}>
            {/* Only the date of birth on this step is encrypted. The other five facts go
                into the database as plain JSON, exactly as docs/03 marks them. Saying all
                six were encrypted put the strongest promise this app makes directly above
                the immigration-status select, which is the one control a person is most
                likely to hesitate over — and it was the promise persuading them to
                answer. If the encrypted set ever widens, this sentence widens with it. */}
            <p className="text-dim mb-6 u-prose text-[1rem]">
              Eligibility turns on these six facts, and none of them appear on a resume. All six are
              stored in the database file on this machine. Your date of birth is encrypted there,
              the way your contact details are. The other five sit in that file as plain text.
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

              {/* Clearing a date has to read as absent, not as an empty string. The profile
                  schema wants YYYY-MM-DD or nothing at all, so a date box emptied by hand
                  made the next Save — and Confirm, which saves first — come back with
                  "Profile did not match the expected shape" and no clue which field meant
                  it. Same treatment the date of birth above already gets. */}
              <TextField
                label="Available from"
                type="date"
                hint="A posting's term must overlap this window by at least six weeks."
                value={profile.availability.start ?? ''}
                flagged={flagged('availability.start')}
                onChange={(e) =>
                  patch(
                    (p) => ({
                      ...p,
                      availability: { ...p.availability, start: e.target.value || undefined },
                    }),
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
                    (p) => ({
                      ...p,
                      availability: { ...p.availability, end: e.target.value || undefined },
                    }),
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
                {/* Every flag needs a way off this list. The extractor can flag a field
                    this wizard has no input for — anything nested in education or
                    experience — and without a control those flags could never be cleared,
                    which locked G1 shut with no way forward. Anything the wizard CAN
                    answer gets pointed at its control instead; see ANSWERED_IN_WIZARD. */}
                <ul className="mt-3 space-y-1.5">
                  {profile.needsReview.slice(0, 12).map((f) => (
                    <li key={f} className="flex flex-wrap items-center justify-between gap-3">
                      <span className="u-data">{f}</span>
                      {ANSWERED_IN_WIZARD[f] ? (
                        <span className="text-faint text-[0.9375rem]">{ANSWERED_IN_WIZARD[f]}</span>
                      ) : (
                        <Button
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => void checkedOff(f)}
                        >
                          I have checked this
                        </Button>
                      )}
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
                Nothing left flagged. Confirming unlocks matching and the queue.
              </Notice>
            )}

            <div className="mt-4 flex gap-3">
              <Button disabled={busy !== null} onClick={() => setStep('confirm')}>
                Back
              </Button>
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
            {/* Not "discovery is unlocked". Confirming does unlock the queue, and there is
              no discovery screen for it to unlock, so someone who took that sentence at
              its word went looking for one. */}
            <p className="text-dim">Matching and the queue are now unlocked.</p>
          </div>
          {/* This screen leaves, rather than being left. Confirming used to navigate for
              the user, which meant the stamp above was rendered and unmounted in the same
              breath and nobody ever saw it. */}
          <div className="mt-5">
            <Button variant="primary" onClick={onDone}>
              Open the queue (G2)
            </Button>
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
  busy,
}: {
  onExtracted: (p: CandidateProfile) => void;
  onError: (m: string) => void;
  setBusy: (m: string | null) => void;
  busy: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState<string | null>(null);

  async function handle(file: File) {
    // One at a time. The dropzone stayed clickable during extraction, so two runs could
    // overlap: the first to settle cleared the "Reading it…" indicator while the second
    // was still going, and whichever finished last silently won.
    if (busy !== null) return;
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
        disabled={busy !== null}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) void handle(f);
        }}
        className="border-rule hover:border-accent w-full border border-dashed px-6 py-14 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-50"
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
      {/* "The file stays on this machine" sat one sentence after "read directly by the
          model", and the two cannot both be true: a PDF is base64-encoded whole and sent
          to the model to be read. This is the first thing a new user does, under the
          strongest privacy promise on the screen, so it says what really happens instead.
          The other formats are named too: they send their extracted text, which is the
          same promise being broken more quietly. */}
      <p className="text-faint mt-5 u-prose text-[0.9375rem]">
        PDFs are sent to the model and read there rather than through a text-extraction library,
        because that copes with scans and multi-column layouts far better. A DOCX or a text file has
        its extracted text sent instead. <em>The copy that is kept lives on this machine.</em>
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
