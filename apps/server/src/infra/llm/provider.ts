/**
 * Where model calls go — see docs/14-model-access.md.
 *
 * Two backends sit behind one interface:
 *
 *   `claude_cli` spawns the user's own installed `claude` binary. The CLI handles its
 *   own authentication, so this process never reads, stores, or transmits a credential.
 *   That distinction is the whole point: Anthropic prohibits using a Claude subscription's
 *   OAuth token inside another product, and this design has no way to do that even by
 *   accident. There is no code path here that opens ~/.claude.
 *
 *   `api` uses ANTHROPIC_API_KEY against the Anthropic API, billed per token.
 *
 * Everything that is not drafting or resume extraction works with NEITHER. Discovery,
 * matching, eligibility, FactGuard, StyleCritic, and the tell-scrub are all deterministic.
 * A missing model is a reduced tool, not a broken one, and `describeAccess` says so.
 */
import type { LlmPurpose } from './client';

export type ProviderKind = 'api' | 'claude_cli' | 'none';

export interface GenerateRequest {
  purpose: LlmPurpose;
  /** Instructions. On the CLI path this is appended to Claude Code's own system prompt. */
  system: string;
  user: string;
  maxTokens?: number;
  /** Ask for a validated object rather than prose. */
  schema?: { name: string; jsonSchema: Record<string, unknown> };
  /** Absolute paths to documents the model must read (resume PDFs). */
  documents?: string[];
}

export interface GenerateResult {
  text: string;
  /** Present only when `schema` was requested and the backend returned an object. */
  structured?: unknown;
  stopReason: string | null;
  provider: ProviderKind;
  /** The CLI reports its own cost; the API path computes it from usage. */
  costUsd?: number;
}

/** Thrown when no backend can serve the request. The message is shown to the user. */
export class NoModelAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoModelAccessError';
  }
}

export interface Backend {
  kind: ProviderKind;
  /** Cheap check. Must not throw. */
  available(): Promise<boolean>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** One sentence for the UI, naming what is and is not available. */
  describe(): string;
}
