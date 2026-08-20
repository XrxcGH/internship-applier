import { ArrowRight, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  daysUntil,
  decide,
  getMatch,
  listMatches,
  locationLabel,
  payLabel,
  recompute,
  REJECT_REASONS,
  termLabel,
  type MatchDetail,
  type MatchRow,
} from '../lib/matches';
import { queueKeyAction } from '../lib/queueKeys';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Button, Empty, Notice } from '../components/Controls';
import { RequirementChecklist, ScoreBreakdownBars } from '../components/RequirementChecklist';

type Band = 'eligible' | 'eligible_and_unknown' | 'all';

const BADGE: Record<string, { label: string; color: string }> = {
  eligible: { label: 'eligible', color: 'var(--verified)' },
  unknown: { label: 'check', color: 'var(--caution)' },
  ineligible: { label: 'filtered', color: 'var(--redline)' },
};

/**
 * The review queue — docs/08 § Matches. Gate G2 lives here.
 *
 * Keyboard-first: triaging forty postings should feel like triaging email. There is
 * deliberately no bulk-approve and no multi-select — one posting, one decision.
 */
export function Matches({
  onOpenApplications,
  onOpenDiscovery,
  onBusy,
}: {
  onOpenApplications?: () => void;
  onOpenDiscovery?: () => void;
  onBusy?: (what: string | null) => void;
}) {
  const [rows, setRows] = useState<MatchRow[]>([]);
  /**
   * Whether the first list has come back yet.
   *
   * `listMatches` walks up to twenty pages one round trip at a time, so on a full store the
   * first answer takes seconds — and for every one of them `rows` is empty, which the empty
   * state below read as "Nothing in the queue." The screen asserted the queue was empty and
   * pointed the user at Discover, over a queue that was about to fill.
   */
  const [loaded, setLoaded] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [band, setBand] = useState<Band>('eligible_and_unknown');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MatchDetail | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The in-flight guard for triage actions.
   *
   * A ref rather than the `busy` state, because the keyboard handler and the action it
   * calls are both closures captured at render: a second keypress inside one round-trip
   * would read the stale `busy` and go through anyway. A ref is current at the moment it
   * is read, which is what a guard has to be.
   */
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  /** Approvals made this session, so triage never has to stop to go look at them. */
  const [approved, setApproved] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // The nav lives above this screen and unmounting it would throw the in-flight guard away,
  // so what is running has to be visible up there. Recompute is the expensive one: it
  // re-extracts requirements with the model, at cost. See the comment on `Nav`.
  useEffect(() => onBusy?.(busy), [busy, onBusy]);

  /**
   * Only the newest list is allowed to paint.
   *
   * `listMatches` walks up to twenty pages one round trip at a time, so "all" is reliably
   * slower to come back than "eligible". Switch bands while the wider one is still walking
   * and its answer landed last: the queue filled with the rows and the counts of a band
   * nobody had selected, sitting under the chip for the band they had. The detail fetch
   * just below already guards itself this way; the list did not.
   *
   * A sequence number rather than a per-effect cancellation flag, because the "Recompute"
   * button calls this too and that call has no effect to be torn down.
   */
  const listSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = (listSeq.current += 1);
    setError(null);
    try {
      const r = await listMatches({ eligibility: band, minScore: 0, hideDecided: true });
      if (seq !== listSeq.current) return;
      setLoaded(true);
      setRows(r.matches);
      setCounts(r.counts);
      // Validated against the rows that just arrived. Keeping a selection that is not in
      // the new band left the detail pane blank beside a populated list — no message, no
      // empty state, nothing to click.
      setSelected((prev) =>
        prev !== null && r.matches.some((m) => m.id === prev) ? prev : (r.matches[0]?.id ?? null),
      );
    } catch (e) {
      if (seq !== listSeq.current) return;
      // Loaded in the sense that matters here: the fetch is over, so the empty state is no
      // longer speaking for a request still in flight. The error banner says what happened.
      setLoaded(true);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [band]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    // Cleared first. Without this the pane rendered the PREVIOUS posting's title,
    // rationale, requirements and score beside the NEW posting's location, because
    // the selected row updates synchronously and the detail only when the fetch resolves.
    // On a failed fetch the mismatch stayed on screen for the rest of the session.
    setDetail(null);
    let cancelled = false;
    getMatch(selected)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const move = useCallback(
    (delta: number) => {
      setSelected((cur) => {
        const i = rows.findIndex((r) => r.id === cur);
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + delta))];
        return next?.id ?? cur;
      });
    },
    [rows],
  );

  const act = useCallback(
    async (action: 'approved' | 'skipped' | 'saved', reason?: string, tags: string[] = []) => {
      // One decision at a time. Two 'a' presses inside one round-trip both decided the
      // same match: the banner counted two applications for one, and the second row
      // removal indexed a list the id had already left, blanking the detail pane.
      if (!selected || busyRef.current) return;
      busyRef.current = true;
      setBusy(action === 'approved' ? 'Approving' : action === 'saved' ? 'Saving' : 'Skipping');
      try {
        const r = await decide(selected, action, reason, tags);
        if (action === 'approved' && r.applicationId) setApproved((n) => n + 1);
        setRows((prev) => {
          const i = prev.findIndex((x) => x.id === selected);
          const next = prev.filter((x) => x.id !== selected);
          setSelected(next[Math.min(i, next.length - 1)]?.id ?? null);
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        busyRef.current = false;
        setBusy(null);
        setRejecting(false);
      }
    },
    [selected],
  );

  const reject = useCallback(
    async (tag: string, label: string) => {
      if (!selected || busyRef.current) return;
      busyRef.current = true;
      setBusy('Rejecting');
      try {
        await decide(selected, 'rejected', label, [tag]);
        setRows((prev) => {
          const i = prev.findIndex((x) => x.id === selected);
          const next = prev.filter((x) => x.id !== selected);
          setSelected(next[Math.min(i, next.length - 1)]?.id ?? null);
          return next;
        });
      } catch (e) {
        // The catch act() has always had. Without it a failed rejection became an
        // unhandled promise rejection, the sheet still closed, and the UI looked like it
        // had worked while the row stayed in the queue.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        busyRef.current = false;
        setBusy(null);
        setRejecting(false);
      }
    },
    [selected],
  );

  // Keyboard triage. What each press means — and the chords that mean nothing here — is
  // decided by queueKeyAction, which is tested on its own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = queueKeyAction(e, { rejecting });
      if (action === null) return;
      // Escape is left alone deliberately: it closes dialogs and leaves full screen, and
      // taking it over so the sheet can close is not worth breaking either of those.
      if (action !== 'close-sheet') e.preventDefault();
      switch (action) {
        case 'next':
          move(1);
          break;
        case 'prev':
          move(-1);
          break;
        case 'approve':
          void act('approved');
          break;
        case 'skip':
          void act('skipped');
          break;
        case 'reject':
          setRejecting(true);
          break;
        case 'save':
          void act('saved');
          break;
        case 'close-sheet':
          setRejecting(false);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, act, rejecting]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-id="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const current = rows.find((r) => r.id === selected);

  return (
    <Page wide>
      <RunningHead section="The queue" gate="G2" />

      <div className="a-rise a-step-2 mb-6 flex flex-wrap items-center gap-2.5">
        {(
          [
            ['eligible', 'Eligible'],
            ['eligible_and_unknown', 'Eligible + check'],
            ['all', 'Everything, incl. filtered'],
          ] as Array<[Band, string]>
        ).map(([value, label]) => (
          /* `aria-pressed` because which band is showing was signalled by colour alone —
             a tinted border and background, nothing else — against this repo's own standard
             that colour is never the only signal. A screen-reader user could hear the three
             options and not which one they were looking at. */
          <button
            key={value}
            onClick={() => setBand(value)}
            aria-pressed={band === value}
            className={`u-data rounded-full border px-3.5 py-1.5 text-2xs tracking-wide uppercase transition-colors ${
              band === value
                ? 'border-accent text-accent bg-accent/10'
                : 'border-rule text-faint hover:text-dim hover:border-rule-strong'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="u-data text-faint ml-auto text-2xs">
          {counts['eligible'] ?? 0} eligible · {counts['unknown'] ?? 0} to check ·{' '}
          {counts['ineligible'] ?? 0} filtered
        </span>
        {/* Guarded by the same ref as the triage actions, and greyed out while it runs.
            This was the one control on the page with neither: a recompute takes a while
            and answers nothing until it is done, so a second impatient click started a
            second full matching run — which re-extracts requirements with the model, at
            cost, for postings the first run is extracting at that moment. Whichever run
            finished first also cleared the "Recomputing…" line, so the rest carried on
            invisibly. */}
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            if (busyRef.current) return;
            busyRef.current = true;
            setBusy('Recomputing');
            void recompute()
              .then(load)
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => {
                busyRef.current = false;
                setBusy(null);
              });
          }}
        >
          Recompute
        </Button>
      </div>

      {error && <Notice tone="redline">{error}</Notice>}
      {/* A live region, as Discover has. Recompute takes as long as it takes and says
          nothing while it runs, so a screen-reader user pressing it got no announcement that
          anything had started or finished. */}
      <div role="status" aria-live="polite">
        {busy && <p className="u-data text-accent a-pulse mb-4">{busy}…</p>}
      </div>

      {/* Approvals accumulate without interrupting triage — the link is there when wanted. */}
      {approved > 0 && (
        <div className="u-tint-verified mb-6 flex flex-wrap items-center justify-between gap-3 rounded px-4 py-3">
          <span className="text-dim text-base">
            {approved === 1 ? '1 application created' : `${approved} applications created`}. Answers
            are waiting for your review.
          </span>
          {onOpenApplications && (
            <Button size="sm" variant="primary" onClick={onOpenApplications}>
              Review answers (G3)
              <ArrowRight aria-hidden size={15} />
            </Button>
          )}
        </div>
      )}

      {/* This once opened with "Run discovery" and there was no screen, button or shortcut
          anywhere in the app that ran discovery, so someone told at G1 that confirming
          unlocks discovery arrived here, pressed the only button, and got the same empty
          queue back. It then said so plainly and quoted the two endpoints to POST by hand.
          Discover exists now, so this points at it — and at the other reason the queue can
          look empty, which is postings that are stored but have never been scored. */}
      {!loaded && !error && <p className="text-dim a-pulse">Reading the queue…</p>}

      {loaded && rows.length === 0 && !error && (
        <Empty title="Nothing in the queue.">
          <p>
            Either nothing has been searched yet, or what is stored has not been scored. Discover
            does both, and it also takes a single posting URL you paste in. Recompute, above, scores
            whatever is already here — and widening the band shows what was filtered out, and why.
          </p>
          {onOpenDiscovery && (
            <div className="mt-4 flex justify-center">
              <Button variant="primary" onClick={onOpenDiscovery}>
                Go to Discover
                <ArrowRight aria-hidden size={15} />
              </Button>
            </div>
          )}
        </Empty>
      )}

      {/* The whole grid, not just the <ul>. The list carries `u-card` — border, radius,
          shadow, backdrop blur — and rendered with zero children whenever the queue is empty,
          during the first fetch, and after a failed load: a 21rem-wide, 2px-tall bordered
          sliver sitting beside an empty detail column, under the empty state that had already
          explained there was nothing. Guarding only the list would leave the grid's own gap
          behind. Applications.tsx already guards the identical shape. */}
      {rows.length > 0 && (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
          {/* list */}
          <ul
            ref={listRef}
            className="u-card divide-rule/50 max-h-[calc(100dvh-13rem)] divide-y overflow-y-auto lg:sticky lg:top-20"
          >
            {rows.map((m) => {
              const days = daysUntil(m.closesAt);
              const badge = BADGE[m.eligibility]!;
              return (
                <li key={m.id} data-id={m.id}>
                  <button
                    onClick={() => setSelected(m.id)}
                    aria-current={selected === m.id ? 'true' : undefined}
                    className={`relative w-full px-4 py-3.5 text-left transition-colors ${
                      selected === m.id ? 'bg-accent/10' : 'hover:bg-ink/[0.04]'
                    }`}
                  >
                    {selected === m.id && (
                      <span
                        className="absolute inset-y-0 left-0 w-[2px]"
                        style={{ background: 'var(--accent)' }}
                      />
                    )}
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-base">{m.title}</span>
                      <span className="u-data text-faint shrink-0 text-2xs">{m.score}</span>
                    </div>
                    <div className="text-dim mt-0.5 truncate text-sm">{m.company}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span
                        className="u-data text-2xs tracking-widest uppercase"
                        style={{ color: badge.color }}
                      >
                        {badge.label}
                      </span>
                      <span className="u-data text-faint text-2xs">{locationLabel(m)}</span>
                      {days !== null && (
                        <span
                          className="u-data text-2xs"
                          style={{ color: days < 7 ? 'var(--redline)' : 'var(--ink-faint)' }}
                        >
                          {days < 0 ? 'closed' : `${days}d left`}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* detail */}
          <div>
            {current && detail && (
              <>
                <Section n="01" title="The posting" step={3}>
                  <div className="u-card px-5 py-5">
                    <h3 className="u-display mb-1 text-3xl">{detail.posting.title}</h3>
                    <p className="text-dim">{detail.posting.company}</p>
                    {/* A <ul>, not a <dl>. These are five facts about one posting, not five
                        term/definition pairs, and a description list whose children are bare
                        spans announces itself as a definition list containing nothing. */}
                    <ul className="u-data text-faint border-rule mt-4 flex flex-wrap gap-x-5 gap-y-1.5 border-t pt-3 text-2xs">
                      <li>{locationLabel(current)}</li>
                      <li>{termLabel(detail.posting.term)}</li>
                      <li>{payLabel(detail.posting.compensation)}</li>
                      <li>{detail.posting.positionType ?? 'type not stated'}</li>
                      <li>{detail.posting.atsVendor}</li>
                    </ul>
                    <p className="mt-5 u-prose text-base leading-relaxed">
                      {detail.match.rationale}
                    </p>
                  </div>
                </Section>

                <Section n="02" title="Requirements, with the text that decided each" step={4}>
                  <RequirementChecklist
                    rules={detail.match.rules}
                    requirements={detail.requirements}
                  />
                </Section>

                <Section n="03" title={`Fit — ${detail.match.score}/100`} step={5}>
                  <ScoreBreakdownBars breakdown={detail.match.breakdown} />
                  <p className="text-faint mt-4 u-prose text-sm italic">
                    This score only orders the queue. It <strong>never</strong> filters anything
                    out.
                  </p>
                </Section>

                <Section n="04" title="Your call" step={6}>
                  {rejecting ? (
                    <div>
                      <p className="text-dim mb-3 text-base">Why not this one?</p>
                      <div className="flex flex-wrap gap-2">
                        {REJECT_REASONS.map((r) => (
                          <Button key={r.tag} onClick={() => void reject(r.tag, r.label)}>
                            {r.label}
                          </Button>
                        ))}
                        <Button onClick={() => setRejecting(false)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-3">
                        <Button variant="solid" onClick={() => void act('approved')}>
                          Approve (A)
                        </Button>
                        <Button onClick={() => void act('saved')}>Save (L)</Button>
                        <Button onClick={() => void act('skipped')}>Skip (S)</Button>
                        <Button variant="danger" onClick={() => setRejecting(true)}>
                          Reject (X)
                        </Button>
                        <a
                          href={detail.posting.applyUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="u-data border-rule text-dim hover:text-ink hover:border-rule-strong hover:bg-ink/[0.04] inline-flex items-center rounded border px-4 py-2 tracking-wide uppercase transition-colors"
                        >
                          Open posting
                          <ExternalLink aria-hidden size={14} />
                        </a>
                      </div>
                      {/* The second sentence is here because Save, Skip and Reject look like
                        three outcomes and behave like one. Each is written down as its own
                        decision on the server, and nothing in this interface reads any of
                        them back: there is no saved list, no decided view and no undo, so
                        someone who pressed Save meaning "come back to this" watched the
                        posting leave the queue for good and went looking for a screen that
                        does not exist. Say so until one does. */}
                      <p className="text-faint mt-4 u-prose text-sm">
                        Approving creates an application you review at gate G3. It does not submit
                        anything — you do that <em>yourself</em>, on the real page. Save and Skip
                        both take the posting out of the queue, as does Reject. Each is recorded as
                        its own decision, but nothing here reads any of them back yet, so treat all
                        three as final.
                      </p>
                    </>
                  )}
                </Section>

                <details className="u-card-flat mt-8 px-5 py-4">
                  <summary className="u-eyebrow hover:text-ink cursor-pointer transition-colors">
                    Full job description
                  </summary>
                  <div className="text-dim mt-4 u-prose text-sm leading-relaxed whitespace-pre-wrap">
                    {detail.posting.descriptionText.slice(0, 8000)}
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
      )}

      <footer className="a-rise a-step-8 mt-12">
        <hr className="u-rule mb-3" />
        <p className="u-eyebrow">j/k move · a approve · l save · s skip · x reject</p>
      </footer>
    </Page>
  );
}
