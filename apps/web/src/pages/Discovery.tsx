import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addManualPosting,
  availableSources,
  boardMeaning,
  durationLabel,
  getPlan,
  listRuns,
  mergeTargets,
  postingStats,
  resolveCompany,
  runHeadline,
  sourceLabel,
  splitCompanies,
  startRun,
  targetKey,
  whenLabel,
  whyCannotRun,
  type AvailableSource,
  type ManualResult,
  type QueryPlan,
  type Resolution,
  type RunSummary,
  type RunTarget,
} from '../lib/discovery';
import { recompute } from '../lib/matches';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Badge, Button, Empty, Notice, TextField } from '../components/Controls';

/**
 * Discover — docs/04, and the screen its own planner notes have been pointing at.
 *
 * Everything here was reachable over HTTP for the whole of M2 and by nothing else: the
 * queue's empty state told people to POST to `/api/discovery/run` themselves, the planner
 * wrote notes saying "Resolve it in Discover" about a screen that did not exist, and the
 * overview listed M2 as "Discovery (server only)". This is that screen.
 *
 * Two things it deliberately does not do. It does not run on its own — no schedule, no
 * background worker, nothing outbound happens on this page until a button is pressed. And it
 * does not show live progress: `runDiscovery` publishes onto the SSE stream, no client
 * listens (docs/08 § Real-time), and a bar measuring nothing would be worse than a sentence
 * saying there is nothing to measure.
 */

/** How many company names one press of "Find their boards" will probe. */
const RESOLVE_LIMIT = 8;

export function Discovery({ onOpenQueue }: { onOpenQueue?: () => void }) {
  const [stats, setStats] = useState<{ total: number; open: number } | null>(null);
  const [sources, setSources] = useState<AvailableSource[] | null>(null);
  const [plan, setPlan] = useState<QueryPlan | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  const [companies, setCompanies] = useState('');
  const [resolutions, setResolutions] = useState<Array<{ name: string; matches: Resolution[] }>>(
    [],
  );
  const [resolveNote, setResolveNote] = useState<string | null>(null);

  const [targets, setTargets] = useState<RunTarget[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [scored, setScored] = useState<string | null>(null);

  const [manualUrl, setManualUrl] = useState('');
  const [manual, setManual] = useState<ManualResult | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The in-flight guard, as on the queue.
   *
   * `busy` disables every button that spends anything, but only from the render after it is
   * set, and a run costs a fan-out of real requests to third-party APIs. A second press
   * inside that gap started a second complete run over the same boards, and whichever
   * finished first cleared the label while the other carried on invisibly.
   */
  const busyRef = useRef(false);

  /**
   * Only the newest read is allowed to paint, exactly as the queue does with `listSeq`.
   *
   * Every one of these four fetches can be in flight more than once — "Rebuild" and "Rebuild
   * the plan with these" both call `refresh`, and a run calls it again when it finishes — and
   * responses come back in whatever order the network gives them. Without a sequence number
   * the last answer to LAND wins rather than the last one ASKED: type "Stripe", rebuild,
   * clear the field, rebuild again, and if the first answer is slower the screen settles on
   * Stripe's guessed boards and its caution note for a company that is no longer in the box.
   * The same race let a failure from an abandoned read overwrite the banner after a newer
   * read had already succeeded.
   */
  const readSeq = useRef(0);

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  /**
   * Reads the four things this screen shows that it did not just do.
   *
   * The plan is fetched with whatever companies are pinned at the time, so re-planning after
   * editing that field is this same call. It is a POST because the planner takes a filter
   * body; it changes nothing on the server.
   */
  const refresh = useCallback(
    (pinned: string[] = []) => {
      const seq = (readSeq.current += 1);
      const fresh =
        <T,>(set: (value: T) => void) =>
        (value: T): void => {
          if (seq === readSeq.current) set(value);
        };
      const failFresh = (err: unknown): void => {
        if (seq === readSeq.current) fail(err);
      };

      setError(null);
      void postingStats().then(fresh(setStats)).catch(failFresh);
      void availableSources().then(fresh(setSources)).catch(failFresh);
      void listRuns().then(fresh(setRuns)).catch(failFresh);
      void getPlan(pinned).then(fresh(setPlan)).catch(failFresh);
    },
    [fail],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Wraps one spending action in the guard, the label, and the error banner. */
  const guarded = useCallback(
    async (label: string, work: () => Promise<void>): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(label);
      setError(null);
      try {
        await work();
      } catch (err) {
        fail(err);
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [fail],
  );

  const pinned = splitCompanies(companies);
  /**
   * The companies as they are NOW, for the work that finishes later.
   *
   * `run` captures `pinned` when the button is pressed, and the field stays editable through
   * a search that can take minutes because typing in it spends nothing. So the plan rebuilt
   * when the run finished was the plan for the list as of the click: the box could read
   * "Figma" while the chips underneath it described Stripe, and it only came right if the
   * user happened to press Rebuild again.
   */
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const addTargets = (incoming: RunTarget[]): void => {
    setTargets((prev) => mergeTargets(prev, incoming));
  };

  const findBoards = (): Promise<void> =>
    guarded('Probing the boards', async () => {
      setResolutions([]);
      setResolveNote(
        pinned.length > RESOLVE_LIMIT
          ? `Probing the first ${RESOLVE_LIMIT} of ${pinned.length} names. The rest are not ` +
              'probed: take these out of the box above and press it again for the next ' +
              `${RESOLVE_LIMIT}.`
          : null,
      );
      const found: Array<{ name: string; matches: Resolution[] }> = [];
      // One name at a time. Each resolution already probes three vendors across up to three
      // slug candidates, and the fetcher rate-limits per host, so firing them together buys
      // nothing and looks to Greenhouse like a burst.
      for (const name of pinned.slice(0, RESOLVE_LIMIT)) {
        const r = await resolveCompany(name);
        found.push({ name, matches: r.matches });
        setResolutions([...found]);
      }
    });

  const run = (): Promise<void> =>
    guarded('Searching', async () => {
      setSummary(null);
      setScored(null);
      const result = await startRun(targets);
      setSummary(result);
      // The stats and the run list both moved; the plan may have too, since a board that
      // answered is a board the next plan knows about. Read through `refresh` rather than
      // fetching here, so these answers are subject to the same last-asked-wins rule as
      // every other read on the page — and with the companies as they stand NOW, not as
      // they stood when the button was pressed minutes ago.
      refresh(pinnedRef.current);
    });

  const score = (): Promise<void> =>
    guarded('Scoring', async () => {
      const r = await recompute();
      setScored(
        `${r.matched} scored — ${r.eligible} eligible, ${r.unknown} to check, ${r.ineligible} filtered.`,
      );
    });

  const paste = (): Promise<void> =>
    guarded('Reading the page', async () => {
      setManual(null);
      const r = await addManualPosting(manualUrl.trim());
      setManual(r);
      setManualUrl('');
      void postingStats().then(setStats).catch(fail);
    });

  const blocked = whyCannotRun(targets);

  return (
    <Page wide>
      <RunningHead
        section="Discover"
        lede={
          <>
            Where postings come from. Nothing on this page reaches the network until you press
            something, and nothing found here enters the queue as a decision — it arrives as a
            posting for you to judge at <strong>G2</strong>.
          </>
        }
      />

      {error && (
        <Notice tone="redline">
          {error}
          <div className="mt-3">
            <Button size="sm" disabled={busy !== null} onClick={() => refresh(pinned)}>
              Try again
            </Button>
          </div>
        </Notice>
      )}
      {/* A live region, because a search takes minutes and says nothing while it runs. A
          screen-reader user pressing Search otherwise got no announcement that anything had
          started, finished, or failed — the page simply changed under them. */}
      <div role="status" aria-live="polite">
        {busy && <p className="u-data text-accent a-pulse mb-4">{busy}…</p>}
      </div>

      <Section n="01" title="What is stored, and where this looks" step={3}>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="u-card-flat px-5 py-5">
            <h3 className="u-eyebrow mb-3">Stored here</h3>
            {stats === null && !error && <p className="text-dim a-pulse">Counting…</p>}
            {stats && (
              <>
                <p className="u-data text-[1.25rem]">
                  {stats.total} {stats.total === 1 ? 'posting' : 'postings'} · {stats.open} still
                  open
                </p>
                <p className="text-faint u-prose mt-3 text-[0.9375rem]">
                  A posting is stored the moment it is found and scored only when you ask. The queue
                  shows whatever has been scored.
                </p>
                {onOpenQueue && (
                  <div className="mt-4">
                    {/* Held while anything is running, like its twin below the summary.
                        Leaving one exit enabled meant a user could start a search, leave
                        for the queue, come back to a remounted screen with a fresh guard —
                        `busyRef` starts false again — and press Search a second time,
                        starting a concurrent run over the same boards. The server has no
                        run lock, so the guard on this page is the only one there is, and a
                        guard with a door beside it is not a guard. */}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy !== null}
                      onClick={onOpenQueue}
                    >
                      Open the queue (G2) →
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="u-card-flat px-5 py-5">
            <h3 className="u-eyebrow mb-3">Sources</h3>
            {sources === null && !error && <p className="text-dim a-pulse">Asking…</p>}
            {sources && (
              <ul className="divide-rule/60 divide-y">
                {sources.map((s) => (
                  <li key={s.name} className="flex items-center justify-between gap-4 py-2.5">
                    <span className="text-[1rem]">{sourceLabel(s.name)}</span>
                    <Badge tone={s.configured ? 'verified' : 'caution'}>
                      {!s.requiresKey ? 'no key needed' : s.configured ? 'key set' : 'no key'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-faint u-prose mt-4 text-[0.9375rem]">
              The two keyed sources read <span className="u-data">ADZUNA_APP_ID</span> /{' '}
              <span className="u-data">ADZUNA_APP_KEY</span> and{' '}
              <span className="u-data">USAJOBS_API_KEY</span> /{' '}
              <span className="u-data">USAJOBS_USER_AGENT</span> from the .env file at the root of
              this project. Both keys are free. Without them those sources are skipped, and every
              run says so out loud rather than searching less and looking the same.
            </p>
          </div>
        </div>
      </Section>

      <Section
        n="02"
        title="The plan, read out of your profile"
        step={4}
        actions={
          <Button size="sm" disabled={busy !== null} onClick={() => refresh(pinned)}>
            Rebuild
          </Button>
        }
      >
        {plan === null && !error && <p className="text-dim a-pulse">Planning…</p>}
        {plan && (
          <>
            <div className="u-card-flat divide-rule/60 divide-y px-5 py-1">
              <PlanRow label="Role families" values={plan.roleFamilies} />
              <PlanRow label="Keywords" values={plan.keywords} />
              <PlanRow label="Term" values={plan.termTokens} />
              <PlanRow label="Locations" values={plan.locations} />
            </div>

            {plan.notes.map((note) => (
              <Notice key={note} tone="caution">
                {note}
              </Notice>
            ))}

            {plan.targets.length === 0 ? (
              <Empty title="The plan has no boards in it.">
                It only knows boards a previous run resolved, plus any company you pin below. The
                community list needs neither — add it in section 04 and the queue has something in
                it a minute later.
              </Empty>
            ) : (
              <div className="mt-5">
                <ul className="flex flex-wrap gap-2">
                  {plan.targets.map((t) => (
                    <li
                      key={`${targetKey(t)}|${t.reason}`}
                      className="border-rule text-dim rounded-full border px-3.5 py-1.5"
                    >
                      <span className="u-data text-[0.75rem] tracking-wide uppercase">
                        {sourceLabel(t.source)}
                      </span>{' '}
                      <span className="text-[0.9375rem]">{t.board}</span>{' '}
                      <span className="text-faint text-[0.8125rem]">— {t.reason}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4">
                  <Button
                    variant="primary"
                    onClick={() =>
                      addTargets(
                        plan.targets.map((t) => ({
                          source: t.source,
                          board: t.board,
                          reason: t.reason,
                        })),
                      )
                    }
                  >
                    Put these {plan.targets.length} in the run
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Section>

      <Section n="03" title="Companies you want searched" step={5}>
        <div className="max-w-2xl">
          <TextField
            label="Company names"
            hint="Commas or semicolons between them. Case does not matter, and a repeat is dropped."
            value={companies}
            onChange={(e) => setCompanies(e.target.value)}
            placeholder="Figma, Stripe, Anthropic"
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button disabled={busy !== null || pinned.length === 0} onClick={() => refresh(pinned)}>
            Rebuild the plan with these
          </Button>
          <Button
            variant="primary"
            disabled={busy !== null || pinned.length === 0}
            onClick={() => void findBoards()}
          >
            Find their boards
          </Button>
          <span className="text-faint u-data text-[0.75rem]">
            {pinned.length} {pinned.length === 1 ? 'name' : 'names'}
          </span>
        </div>

        <p className="text-faint u-prose mt-4 text-[0.9375rem]">
          Rebuilding the plan guesses each name as a slug on Greenhouse, Lever and Ashby, and says
          in a note that it guessed. Finding the boards asks all three which one the company really
          uses, and how many jobs it has open today. The second is slower and it is the one that
          gives you a target worth running.
        </p>

        {resolveNote && <Notice tone="caution">{resolveNote}</Notice>}

        {resolutions.length > 0 && (
          <ul className="mt-5 space-y-3">
            {resolutions.map(({ name, matches }) => (
              <li key={name} className="u-card-flat px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-[1.0625rem]">{name}</span>
                  {matches.length === 0 && (
                    <span className="u-data text-caution text-[0.75rem] tracking-widest uppercase">
                      no board answered
                    </span>
                  )}
                </div>
                {matches.length === 0 ? (
                  <p className="text-faint u-prose mt-2 text-[0.9375rem]">
                    None of the three keyless vendors has a board under that name. The company may
                    use one this tool does not read — Workday and Taleo among them — in which case
                    paste the posting URL in section 05.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {matches.map((m) => (
                      <li
                        key={`${m.source}:${m.board}`}
                        className="flex flex-wrap items-center gap-3"
                      >
                        <span className="u-data text-[0.75rem] tracking-wide uppercase">
                          {sourceLabel(m.source)}
                        </span>
                        <span className="text-dim text-[0.9375rem]">{m.board}</span>
                        <span className="text-faint u-data text-[0.75rem]">
                          {m.jobCount} open {m.jobCount === 1 ? 'job' : 'jobs'}
                        </span>
                        <Button
                          size="sm"
                          onClick={() =>
                            addTargets([
                              {
                                source: m.source,
                                board: m.board,
                                reason: `${name}, resolved to this board`,
                              },
                            ])
                          }
                        >
                          Add
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section n="04" title="The run" step={6}>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Button
            onClick={() =>
              addTargets([
                {
                  source: 'github_list',
                  board: '',
                  reason: 'the community list for the upcoming season',
                },
              ])
            }
          >
            + Community list
          </Button>
          {(sources ?? [])
            .filter((s) => s.requiresKey && s.configured)
            .map((s) => (
              <Button
                key={s.name}
                onClick={() =>
                  addTargets([
                    {
                      source: s.name,
                      board: '',
                      reason: 'keyword search',
                      keywords: plan?.keywords ?? [],
                      location: plan?.locations[0],
                    },
                  ])
                }
              >
                + {sourceLabel(s.name)}
              </Button>
            ))}
          {targets.length > 0 && (
            <Button size="sm" onClick={() => setTargets([])}>
              Clear
            </Button>
          )}
        </div>

        {targets.length === 0 ? (
          <Empty title="Nothing queued to search.">
            Add the community list above, or a company board from section 03, or take the plan from
            section 02 whole.
          </Empty>
        ) : (
          <ul className="u-card divide-rule/50 divide-y">
            {targets.map((t) => (
              <li
                key={targetKey(t)}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <span className="u-data text-accent text-[0.75rem] tracking-wide uppercase">
                      {sourceLabel(t.source)}
                    </span>
                    <span className="text-[1rem]">
                      {t.board || <span className="text-faint">{boardMeaning(t.source)}</span>}
                    </span>
                  </div>
                  <div className="text-faint mt-0.5 text-[0.875rem]">
                    {t.reason}
                    {t.keywords && t.keywords.length > 0 && ` · ${t.keywords.join(', ')}`}
                    {t.location && ` · ${t.location}`}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() =>
                    setTargets((prev) => prev.filter((x) => targetKey(x) !== targetKey(t)))
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button
            variant="solid"
            disabled={busy !== null || blocked !== null}
            onClick={() => void run()}
          >
            {busy === 'Searching'
              ? 'Searching…'
              : `Search ${targets.length} ${targets.length === 1 ? 'target' : 'targets'}`}
          </Button>
          {blocked && <span className="text-faint text-[0.9375rem]">{blocked}</span>}
        </div>

        <p className="text-faint u-prose mt-4 text-[0.9375rem]">
          A run fetches four boards at a time and answers when the last one is done, which is
          anything from a few seconds to a couple of minutes. There is no progress on the way: the
          server publishes it and no screen in this app listens yet, so this page waits rather than
          drawing a bar it cannot fill honestly.
        </p>

        {summary && (
          <div className="mt-6">
            <div className="u-tint-verified rounded px-5 py-4">
              <p className="u-data text-[1.0625rem]">{runHeadline(summary)}</p>
              <p className="text-faint mt-1 text-[0.875rem]">
                {summary.targets} {summary.targets === 1 ? 'target' : 'targets'} in{' '}
                {durationLabel(summary.startedAt, summary.finishedAt)}
              </p>
            </div>

            {summary.skipped.length > 0 && (
              <Notice tone="caution">
                <strong>This search was not complete.</strong>
                <ul className="mt-2 space-y-1.5">
                  {summary.skipped.map((s, i) => (
                    <li key={i} className="u-prose text-[0.9375rem]">
                      {s}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}

            <ul className="u-card divide-rule/50 mt-4 divide-y">
              {summary.bySource.map((r, i) => (
                <li key={`${r.source}:${r.board}:${i}`} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="text-[1rem]">
                      <span className="u-data text-[0.75rem] tracking-wide uppercase">
                        {sourceLabel(r.source)}
                      </span>{' '}
                      {r.board}
                    </span>
                    <span className="u-data text-faint text-[0.8125rem]">
                      {r.found} found · {r.new} new
                      {r.degraded && <span className="text-caution"> · came back short</span>}
                    </span>
                  </div>
                  {[...r.errors, ...r.notes].map((line, j) => (
                    <p key={j} className="text-faint u-prose mt-1.5 text-[0.875rem]">
                      {line}
                    </p>
                  ))}
                </li>
              ))}
            </ul>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={busy !== null} onClick={() => void score()}>
                {busy === 'Scoring' ? 'Scoring…' : 'Score what is stored'}
              </Button>
              {onOpenQueue && (
                <Button disabled={busy !== null} onClick={onOpenQueue}>
                  Open the queue (G2) →
                </Button>
              )}
            </div>
            {scored && <Notice tone="verified">{scored}</Notice>}
            <p className="text-faint u-prose mt-3 text-[0.9375rem]">
              Finding a posting does not score it. Scoring reads each new posting for its
              requirements, which is the one step on this page that can spend money on a model call,
              and it is also what the queue&apos;s own Recompute button does.
            </p>
          </div>
        )}
      </Section>

      <Section n="05" title="One posting, by URL" step={7}>
        <div className="max-w-2xl">
          <TextField
            label="Paste the address of a job posting"
            hint="Any site, including ones this tool will not crawl on its own. One page, fetched because you asked."
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
        <div className="mt-4">
          <Button
            variant="primary"
            disabled={busy !== null || manualUrl.trim() === ''}
            onClick={() => void paste()}
          >
            {busy === 'Reading the page' ? 'Reading…' : 'Read it and store it'}
          </Button>
        </div>

        {manual && (
          <div className="u-card-flat mt-5 px-5 py-4">
            <p className="text-[1.0625rem]">{manual.posting.title}</p>
            <p className="text-dim">{manual.posting.company}</p>
            <p className="text-faint u-data mt-3 text-[0.8125rem]">
              {manual.usedJsonLd
                ? 'Read from the structured job data the page publishes.'
                : 'The page published no structured job data, so this was read from its text.'}
            </p>
            {manual.notes.map((n, i) => (
              <p key={i} className="text-faint u-prose mt-1.5 text-[0.875rem]">
                {n}
              </p>
            ))}
            <p className="text-faint u-prose mt-3 text-[0.9375rem]">
              Stored, and not yet scored. Press <em>Score what is stored</em> above to put it in
              front of you at G2.
            </p>
          </div>
        )}
      </Section>

      <Section n="06" title="Earlier runs" step={8}>
        {runs.length === 0 ? (
          <Empty title="No run has been recorded on this machine." />
        ) : (
          <ul className="space-y-3">
            {runs.map((r) => (
              <li key={r.runId} className="u-card-flat px-5 py-4">
                <details>
                  <summary className="hover:text-ink cursor-pointer transition-colors">
                    <span className="u-data text-[0.9375rem]">{runHeadline(r)}</span>
                    <span className="text-faint u-data ml-3 text-[0.75rem]">
                      {whenLabel(r.startedAt)} · {durationLabel(r.startedAt, r.finishedAt)} ·{' '}
                      {r.targets} {r.targets === 1 ? 'target' : 'targets'}
                      {r.skipped.length > 0 && (
                        <span className="text-caution">
                          {' '}
                          · {r.skipped.length} gap{r.skipped.length === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                  </summary>
                  <ul className="divide-rule/50 mt-3 divide-y">
                    {r.bySource.map((s, i) => (
                      <li
                        key={`${s.source}:${s.board}:${i}`}
                        className="flex flex-wrap items-baseline justify-between gap-3 py-2"
                      >
                        <span className="text-dim text-[0.9375rem]">
                          {sourceLabel(s.source)} {s.board}
                        </span>
                        <span className="u-data text-faint text-[0.8125rem]">
                          {s.found} found · {s.new} new
                        </span>
                      </li>
                    ))}
                  </ul>
                  {r.skipped.map((s, i) => (
                    <p key={i} className="text-caution u-prose mt-2 text-[0.875rem]">
                      {s}
                    </p>
                  ))}
                </details>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <footer className="a-rise a-step-8 mt-12">
        <hr className="u-rule mb-3" />
        <p className="u-eyebrow">
          official&nbsp;APIs&nbsp;and&nbsp;public&nbsp;feeds&nbsp;only&nbsp;·
          nothing&nbsp;is&nbsp;crawled&nbsp;behind&nbsp;a&nbsp;terms&nbsp;wall
        </p>
      </footer>
    </Page>
  );
}

/** One line of the plan. An empty list says so instead of leaving a blank. */
function PlanRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5">
      <span className="text-dim text-[1rem]">{label}</span>
      <span className="u-data text-right">
        {values.length > 0 ? values.join(' · ') : <span className="text-faint">none inferred</span>}
      </span>
    </div>
  );
}
