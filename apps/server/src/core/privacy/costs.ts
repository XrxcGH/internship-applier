/**
 * What this has cost — docs/11 § M8.
 *
 * Every model call is recorded in `llm_call` at the moment it happens, so this is a read
 * over facts rather than an estimate. Costs are stored as integer micro-dollars, because
 * a float accumulating thousands of fractions of a cent drifts.
 *
 * ZERO IS A MEANINGFUL ANSWER HERE. On the Claude Code CLI path there is no per-token
 * billing at all: the calls come out of a subscription the user already pays for. The
 * panel says that in words rather than showing "$0.00", which would read like a bug.
 */
import { desc } from 'drizzle-orm';
import { db, schema } from '../../infra/db/client';

const MICRO = 1_000_000;

export interface CostByPurpose {
  purpose: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface CostSummary {
  totalUsd: number;
  totalCalls: number;
  byPurpose: CostByPurpose[];
  byModel: Array<{ model: string; calls: number; usd: number }>;
  recent: Array<{
    purpose: string;
    model: string;
    usd: number;
    latencyMs: number;
    at: string;
  }>;
  /** One sentence for the panel header. */
  note: string;
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;

export function computeCosts(): CostSummary {
  const rows = db.select().from(schema.llmCall).orderBy(desc(schema.llmCall.at)).all();

  const totalUsd = round(rows.reduce((a, r) => a + r.costUsd, 0) / MICRO);

  const group = <T extends string>(key: (r: (typeof rows)[number]) => T) => {
    const m = new Map<T, (typeof rows)[number][]>();
    for (const r of rows) {
      const k = key(r);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };

  const byPurpose = [...group((r) => r.purpose).entries()]
    .map(([purpose, list]) => ({
      purpose,
      calls: list.length,
      inputTokens: list.reduce((a, r) => a + r.inputTokens, 0),
      outputTokens: list.reduce((a, r) => a + r.outputTokens, 0),
      usd: round(list.reduce((a, r) => a + r.costUsd, 0) / MICRO),
    }))
    .sort((a, b) => b.usd - a.usd || b.calls - a.calls);

  const byModel = [...group((r) => r.model).entries()]
    .map(([model, list]) => ({
      model,
      calls: list.length,
      usd: round(list.reduce((a, r) => a + r.costUsd, 0) / MICRO),
    }))
    .sort((a, b) => b.usd - a.usd);

  let note: string;
  if (rows.length === 0) {
    note = 'No model calls yet.';
  } else if (totalUsd === 0) {
    // The CLI path reports its own cost as zero because a subscription already paid it.
    note =
      `${String(rows.length)} model calls, none of them billed per token. ` +
      'They ran through the Claude Code CLI, against a subscription you already pay for.';
  } else {
    note = `${String(rows.length)} model calls, ${formatUsd(totalUsd)} in total.`;
  }

  return {
    totalUsd,
    totalCalls: rows.length,
    byPurpose,
    byModel,
    recent: rows.slice(0, 20).map((r) => ({
      purpose: r.purpose,
      model: r.model,
      usd: round(r.costUsd / MICRO),
      latencyMs: r.latencyMs,
      at: r.at,
    })),
    note,
  };
}

/**
 * Money, at a precision that matches the amount.
 *
 * A drafting call costs about two cents, so rounding everything to $0.01 would show a
 * season's worth of work as a handful of identical rows. Small amounts get more decimals.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
