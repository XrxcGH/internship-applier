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
 */
export function Voice() {
  const [samples, setSamples] = useState<SamplesResponse | null>(null);
  const [style, setStyle] = useState<StyleResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listSamples().then(setSamples);
    void getStyle().then(setStyle);
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

      <Section n="01" title="Samples" step={3}>
        {/* The adequacy message already covers the empty case, so the empty state is only
            shown when there is nothing else on screen saying the same thing. */}
        {samples && samples.samples.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <Badge tone={ADEQUACY_TONE[samples.adequacy.level]}>{samples.adequacy.level}</Badge>
            <span className="text-dim text-[1rem]">{samples.adequacy.message}</span>
          </div>
        )}

        {samples?.samples.length === 0 && (
          <Empty title="No samples yet.">{samples.adequacy.message}</Empty>
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
                  <p className="text-dim truncate text-[0.9375rem]">{s.preview}</p>
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
            {style ? 'Recompute' : 'Measure'}
          </Button>
        }
      >
        {!style ? (
          <Empty title="Not measured yet.">
            Add at least one sample, then measure. It runs entirely on your machine.
          </Empty>
        ) : (
          <div className="u-card-flat px-5 py-5">
            <ul className="space-y-3">
              {style.description.map((line, i) => (
                <li key={i} className="flex gap-3 text-[1rem]">
                  <span className="text-accent-dim shrink-0">—</span>
                  <span className="text-dim">{line}</span>
                </li>
              ))}
            </ul>
            {style.computedAt && (
              <p className="u-data text-faint border-rule mt-4 border-t pt-3 text-[0.75rem]">
                measured {style.computedAt.slice(0, 16).replace('T', ' ')}
              </p>
            )}
          </div>
        )}

        <p className="text-faint mt-5 u-prose text-[1rem] italic">
          These numbers are <strong>not scored against an AI detector</strong>, and are not trying
          to beat one. They answer a narrower question: does the draft read like the person signing
          it?
        </p>
      </Section>
    </Page>
  );
}
