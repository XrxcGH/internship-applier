/**
 * Anthropic client with cost accounting — see docs/02-architecture.md.
 *
 * Every call is recorded in `llm_call` so the cost panel is real and a bad output can
 * be traced back to the prompt that produced it. Keys come from the OS keychain or, in
 * development, the environment.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ulid } from 'ulid';
import { db, schema } from '../db/client';
import { logger } from '../logger';

/**
 * docs/02: Opus for extraction, drafting and verification; Haiku for bulk classification.
 *
 * `classification` is wired up and unused. `apiBackend` maps the `field_classification`
 * purpose onto it, but nothing asks for that purpose — field classification is entirely
 * deterministic today and its model fallback was never built (docs/07 § Classification).
 * The entry stays because the mapping is correct for the day it is, and because deleting
 * it would leave `apiBackend` with a purpose it cannot resolve.
 */
export const MODELS = {
  extraction: 'claude-opus-5',
  drafting: 'claude-opus-5',
  verification: 'claude-opus-5',
  classification: 'claude-haiku-4-5',
} as const;

/**
 * The ledger name for a call served by the Claude Code CLI.
 *
 * Deliberately absent from PRICING below. The CLI does not report which model answered or
 * how many tokens it used, and a subscription is not billed per token, so these rows carry
 * a zero cost — which the cost panel spells out in words rather than showing "$0.00".
 */
export const CLI_MODEL = 'claude-code-cli';

/** USD per million tokens, for the cost panel. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export type LlmPurpose =
  | 'resume_extraction'
  | 'requirement_extraction'
  | 'field_classification'
  | 'answer_draft'
  | 'fact_guard'
  | 'style_critic'
  | 'rationale';

let client: Anthropic | null = null;

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'No Anthropic API key configured. Add one in Settings, or set ANTHROPIC_API_KEY for ' +
        'development. Resume extraction and answer drafting need it; everything else works without it.',
    );
    this.name = 'MissingApiKeyError';
  }
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
}

export function getClient(): Anthropic {
  if (!hasApiKey()) throw new MissingApiKeyError();
  client ??= new Anthropic();
  return client;
}

interface RecordArgs {
  purpose: LlmPurpose;
  model: string;
  usage: { input_tokens: number; output_tokens: number } & Record<string, unknown>;
  latencyMs: number;
  stopReason: string | null;
}

export function recordCall({ purpose, model, usage, latencyMs, stopReason }: RecordArgs): void {
  const price = PRICING[model] ?? { input: 0, output: 0 };
  const cacheRead = Number(usage['cache_read_input_tokens'] ?? 0);
  const cacheWrite = Number(usage['cache_creation_input_tokens'] ?? 0);

  // Cache reads bill at ~0.1x, writes at ~1.25x. Stored as micro-dollars (integer).
  const usd =
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      cacheRead * price.input * 0.1 +
      cacheWrite * price.input * 1.25) /
    1_000_000;

  try {
    db.insert(schema.llmCall)
      .values({
        id: ulid(),
        purpose,
        model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costUsd: Math.round(usd * 1_000_000),
        latencyMs,
        stopReason,
      })
      .run();
  } catch (err) {
    logger.warn({ err }, 'failed to record llm_call; continuing');
  }
}
