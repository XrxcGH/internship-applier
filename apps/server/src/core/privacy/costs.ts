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
import { CLI_MODEL } from '../../infra/llm/client';

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

  /**
   * What the total actually means, which depends on which backend spent it.
   *
   * This had two branches: a non-zero total was reported as money, and a zero total was
   * explained as "none of them billed per token — they ran through the Claude Code CLI". That
   * second branch was reached because every CLI call was written to the ledger as costing
   * exactly nothing, which was a bug rather than a fact. The CLI reports `total_cost_usd` on
   * every envelope and those figures are recorded now, so a CLI-only user has a non-zero total
   * that is NOT a bill — it is what the work would have cost, drawn against a subscription
   * they have already paid for.
   *
   * Saying "$4.10 in total" to that user would be false in the direction that matters. Saying
   * "$0" was false in the other. So the two are separated and each is named for what it is.
   */
  const cliUsd = round(
    rows.filter((r) => r.model === CLI_MODEL).reduce((a, r) => a + r.costUsd, 0) / MICRO,
  );
  const billedUsd = round(totalUsd - cliUsd);

  let note: string;
  if (rows.length === 0) {
    note = 'No model calls yet.';
  } else if (billedUsd === 0 && cliUsd === 0) {
    note = `${String(rows.length)} model calls, none of which reported a cost.`;
  } else if (billedUsd === 0) {
    note =
      `${String(rows.length)} model calls. None of it is billed to you: it ran through the ` +
      `Claude Code CLI against a subscription you already pay for, and ${formatUsd(cliUsd)} ` +
      'is what the same work would have cost through the API.';
  } else if (cliUsd === 0) {
    note = `${String(rows.length)} model calls, ${formatUsd(billedUsd)} billed to your API key.`;
  } else {
    note =
      `${String(rows.length)} model calls. ${formatUsd(billedUsd)} billed to your API key, ` +
      `plus ${formatUsd(cliUsd)} of subscription usage through the Claude Code CLI, which is ` +
      'not billed to you.';
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
