import { useCallback, useEffect, useState } from 'react';
import {
  addSample,
  computeStyle,
  deleteSample,
  getStyle,
  listSamples,
  type SamplesResponse,
  type StyleResponse,
} from '../lib/api';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Badge, Button, Empty, Notice, TextArea } from '../components/Controls';

const ADEQUACY_TONE = {
  none: 'redline',
  thin: 'caution',
  enough: 'verified',
  plenty: 'verified',
} as const;

/**
 * Voice — the samples that make drafts sound like the user rather than like a model.
 *
 * The framing here matters. This is not "train the AI on you"; it is a measurement, and
 * the measurements are shown back in plain numbers so the user can see exactly what was
 * derived from their writing. Nothing here is inferred about the person, only about the
 * prose.
 *
 * Which is why the copy has to name the second thing on disk. Measuring stores a record of
 * its own, separate from the samples, and someone who deletes the essay they regret pasting
 * is entitled to know what happens to what was measured from it. A page that shows one of
 * the two and never mentions the other leaves them guessing.
 */
export function Voice() {
  const [samples, setSamples] = useState<SamplesResponse | null>(null);
  const [style, setStyle] = useState<StyleResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Both of these used to be fire-and-forget. On a failed fetch the samples state stayed
  // null, every branch of section 01 tested falsy, and the page rendered a heading over
  // nothing — no spinner, no error, and an unhandled rejection in the console.
  /**
   * Whether the answers are back, so an empty state speaks only for a request that finished.
   *
   * `style` starts null and section 03 keyed its empty state on `!style` alone, so the page
   * asserted "Not measured yet." and labelled its button "Measure" for a user whose style HAS
   * been measured — during every mount fetch, and permanently after a failed one, since the
   * catch only sets the error banner. The queue already learned this exact lesson and named
   * its flag `loaded`; this page had the same hole in it.
   */
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    const fail = (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    };
    void Promise.allSettled([
      listSamples().then(setSamples).catch(fail),
      getStyle().then(setStyle).catch(fail),
    ]).finally(() => setLoaded(true));
  }, []);

  useEffect(refresh, [refresh]);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const words = (draft.match(/\S+/g) ?? []).length;

  return (
    <Page>
      <RunningHead
        section="Your voice"
        lede="Paste things you have written — an essay, a long email, anything more than a few
              sentences. Drafts are matched against how you actually write, measured rather than
              guessed at."
      />

      {error && <Notice tone="redline">{error}</Notice>}

      {/* The samples and what was measured from them, side by side from lg up: the whole
          point of the second panel is to be checked against the first, and stacked, the
          check meant scrolling between them. */}
      <div className="grid items-start gap-x-12 gap-y-0 lg:grid-cols-2">
        <Section n="01" title="Samples" step={3}>
          {/* The adequacy message already covers the empty case, so the empty state is only
            shown when there is nothing else on screen saying the same thing. */}
          {samples && samples.samples.length > 0 && (
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <Badge tone={ADEQUACY_TONE[samples.adequacy.level]}>{samples.adequacy.level}</Badge>
              <span className="text-dim text-base">{samples.adequacy.message}</span>
            </div>
          )}

          {!loaded && <p className="text-dim a-pulse text-sm">Reading…</p>}
          {loaded && samples?.samples.length === 0 && (
            // The card's own title, not the adequacy message, which opens with the same four
            // words — "No samples yet." rendered directly above "No samples yet. Without them…"
            // is one fact stated twice in a row, and the second copy is the useful one. The
            // consequence is what the student needs; the count is already visible beside it.
            <Empty title="Nothing here yet.">{samples.adequacy.message}</Empty>
          )}

          {samples && samples.samples.length > 0 && (
            <ul className="space-y-3">
              {samples.samples.map((s) => (
                <li key={s.id} className="u-card-flat flex items-start gap-4 px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex items-center gap-2">
                      <Badge>{s.kind.replace(/_/g, ' ')}</Badge>
                      <span className="u-data text-faint">{s.wordCount} words</span>
                    </div>
                    <p className="text-dim truncate text-sm">{s.preview}</p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(() => deleteSample(s.id))}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {samples && samples.samples.length > 0 && (
            <p className="text-faint u-prose mt-4 text-sm">
              Removing a sample deletes the text you pasted and measures your voice again from
              whatever is left, so nothing below goes on describing writing you have taken away.
              Remove the last one and the measurement goes with it.
            </p>
          )}
        </Section>

        <Section n="02" title="Add a sample" step={4}>
          <TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={9}
            placeholder="Paste something you wrote. The less edited, the better — first drafts carry more of your rhythm than polished ones."
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              variant="solid"
              disabled={draft.trim().length < 20 || busy}
              onClick={() =>
                void run(async () => {
                  await addSample(draft.trim());
                  setDraft('');
                })
              }
            >
              Add sample
            </Button>
            <span className="u-data text-faint">
              {words} {words === 1 ? 'word' : 'words'}
            </span>
          </div>
        </Section>
      </div>

      <Section
        n="03"
        title="What was measured"
        step={5}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !samples || samples.samples.length === 0}
            onClick={() => void run(computeStyle)}
          >
            {/* 'Measure' is a claim that nothing has been measured yet, which the page
                cannot know until the fetch lands. */}
            {!loaded ? 'Measure' : style ? 'Recompute' : 'Measure'}
          </Button>
        }
      >
        {!loaded ? (
          <p className="text-dim a-pulse text-sm">Reading…</p>
        ) : !style ? (
          <Empty title="Not measured yet.">
            Add at least one sample, then measure. It runs entirely on your machine.
          </Empty>
        ) : (
          <div className="u-card-flat px-5 py-5">
            <ul className="space-y-3">
              {style.description.map((line, i) => (
                <li key={i} className="flex gap-3 text-base">
                  {/* Decoration, so it is hidden: a screen reader announced "em dash" before every
                    line of a list that already has real list semantics. */}
                  <span aria-hidden className="text-accent-dim shrink-0">
                    —
                  </span>
                  <span className="text-dim">{line}</span>
                </li>
              ))}
            </ul>
            {style.computedAt && (
              <p className="u-data text-faint border-rule mt-4 border-t pt-3 text-2xs">
                measured {style.computedAt.slice(0, 16).replace('T', ' ')}
              </p>
            )}
          </div>
        )}

        <p className="text-faint u-prose mt-5 text-base">
          Measuring keeps these numbers as a record of their own, stored separately from the samples
          they were taken from. Adding a sample does not change it on its own; measuring again does,
          and so does removing a sample. No passage of your writing is copied into it — it holds
          counts and rates, plus single words: the ones you most often open a sentence with, and
          which of a fixed list of joining words you reach for.
        </p>

        <p className="text-faint mt-5 u-prose text-base italic">
          These numbers are <strong>not scored against an AI detector</strong>, and are not trying
          to beat one. They answer a narrower question: does the draft read like the person signing
          it?
        </p>
      </Section>
    </Page>
  );
}
