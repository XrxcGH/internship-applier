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
export function Matches({ onOpenApplications }: { onOpenApplications?: () => void }) {
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [band, setBand] = useState<Band>('eligible_and_unknown');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MatchDetail | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Approvals made this session, so triage never has to stop to go look at them. */
  const [approved, setApproved] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await listMatches({ eligibility: band, minScore: 0, hideDecided: true });
      setRows(r.matches);
      setCounts(r.counts);
      setSelected((prev) => prev ?? r.matches[0]?.id ?? null);
    } catch (e) {
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
      if (!selected) return;
      setBusy(action);
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
        setBusy(null);
        setRejecting(false);
      }
    },
    [selected],
  );

  const reject = useCallback(
    async (tag: string, label: string) => {
      if (!selected) return;
      setBusy('rejected');
      try {
        await decide(selected, 'rejected', label, [tag]);
        setRows((prev) => {
          const i = prev.findIndex((x) => x.id === selected);
          const next = prev.filter((x) => x.id !== selected);
          setSelected(next[Math.min(i, next.length - 1)]?.id ?? null);
          return next;
        });
      } finally {
        setBusy(null);
        setRejecting(false);
      }
    },
    [selected],
  );

  // Keyboard triage. Ignored while typing in a field or while the reject sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /input|textarea|select/i.test(t.tagName)) return;
      if (rejecting) {
        if (e.key === 'Escape') setRejecting(false);
        return;
      }
      switch (e.key.toLowerCase()) {
        case 'j':
          e.preventDefault();
          move(1);
          break;
        case 'k':
          e.preventDefault();
          move(-1);
          break;
        case 'a':
          e.preventDefault();
          void act('approved');
          break;
        case 's':
          e.preventDefault();
          void act('skipped');
          break;
        case 'x':
          e.preventDefault();
          setRejecting(true);
          break;
        case 'l':
          e.preventDefault();
          void act('saved');
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
          <button
            key={value}
            onClick={() => setBand(value)}
            className={`u-data rounded-full border px-3.5 py-1.5 text-[0.75rem] tracking-wide uppercase transition-colors ${
              band === value
                ? 'border-accent text-accent bg-accent/10'
                : 'border-rule text-faint hover:text-dim hover:border-rule-strong'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="u-data text-faint ml-auto text-[0.75rem]">
          {counts['eligible'] ?? 0} eligible · {counts['unknown'] ?? 0} to check ·{' '}
          {counts['ineligible'] ?? 0} filtered
        </span>
        <Button
          size="sm"
          onClick={() => {
            setBusy('recompute');
            void recompute()
              .then(load)
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(null));
          }}
        >
          Recompute
        </Button>
      </div>

      {error && <Notice tone="redline">{error}</Notice>}
      {busy && <p className="u-data text-accent a-pulse mb-4">{busy}…</p>}

      {/* Approvals accumulate without interrupting triage — the link is there when wanted. */}
      {approved > 0 && (
        <div className="u-tint-verified mb-6 flex flex-wrap items-center justify-between gap-3 rounded px-4 py-3">
          <span className="text-dim text-[0.9375rem]">
            {approved === 1 ? '1 application created' : `${approved} applications created`}. Answers
            are waiting for your review.
          </span>
          {onOpenApplications && (
            <Button size="sm" variant="primary" onClick={onOpenApplications}>
              Review answers (G3) →
            </Button>
          )}
        </div>
      )}

      {rows.length === 0 && !error && (
        <Empty title="Nothing in the queue.">
          Run discovery, then Recompute — or widen the band above to see what was filtered out, and
          why.
        </Empty>
      )}

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
                    <span className="truncate text-[0.9375rem]">{m.title}</span>
                    <span className="u-data text-faint shrink-0 text-[0.75rem]">{m.score}</span>
                  </div>
                  <div className="text-dim mt-0.5 truncate text-[0.8125rem]">{m.company}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span
                      className="u-data text-[0.625rem] tracking-widest uppercase"
                      style={{ color: badge.color }}
                    >
                      {badge.label}
                    </span>
                    <span className="u-data text-faint text-[0.6875rem]">{locationLabel(m)}</span>
                    {days !== null && (
                      <span
                        className="u-data text-[0.6875rem]"
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
                  <dl className="u-data text-faint border-rule mt-4 flex flex-wrap gap-x-5 gap-y-1.5 border-t pt-3 text-[0.75rem]">
                    <span>{locationLabel(current)}</span>
                    <span>{termLabel(detail.posting.term)}</span>
                    <span>{payLabel(detail.posting.compensation)}</span>
                    <span>{detail.posting.positionType ?? 'type not stated'}</span>
                    <span>{detail.posting.atsVendor}</span>
                  </dl>
                  <p className="mt-5 max-w-[62ch] text-[0.9375rem] leading-relaxed">
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
                <p className="text-faint mt-4 max-w-[58ch] text-[0.8125rem] italic">
                  This score only orders the queue. It never filters anything out.
                </p>
              </Section>

              <Section n="04" title="Your call" step={6}>
                {rejecting ? (
                  <div>
                    <p className="text-dim mb-3 text-[0.9375rem]">Why not this one?</p>
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
                        Open posting ↗
                      </a>
                    </div>
                    <p className="text-faint mt-4 max-w-[60ch] text-[0.8125rem]">
                      Approving creates an application you review at gate G3. It does not submit
                      anything — you do that yourself, on the real page.
                    </p>
                  </>
                )}
              </Section>

              <details className="u-card-flat mt-8 px-5 py-4">
                <summary className="u-eyebrow hover:text-ink cursor-pointer transition-colors">
                  Full job description
                </summary>
                <div className="text-dim mt-4 max-w-[68ch] text-[0.875rem] leading-relaxed whitespace-pre-wrap">
                  {detail.posting.descriptionText.slice(0, 8000)}
                </div>
              </details>
            </>
          )}
        </div>
      </div>

      <footer className="a-rise a-step-8 mt-12">
        <hr className="u-rule mb-3" />
        <p className="u-eyebrow">j/k move · a approve · l save · s skip · x reject</p>
      </footer>
    </Page>
  );
}
