/**
 * Picks a model backend and answers "what can this install actually do?"
 *
 * Resolution under `auto` prefers the CLI, because a user who has Claude Code signed in
 * has already paid for these calls and should not be billed twice. An API key is the
 * fallback, and no model at all is a supported state rather than an error: everything
 * except drafting and resume extraction is deterministic and runs regardless.
 */
import { config } from '../../config';
import { logger } from '../logger';
import { apiBackend } from './apiBackend';
import { claudeCliBackend } from './claudeCli';
import {
  NoModelAccessError,
  type Backend,
  type GenerateRequest,
  type GenerateResult,
  type ProviderKind,
} from './provider';

export { NoModelAccessError };
export type { GenerateRequest, GenerateResult, ProviderKind };
export { selfTest as claudeCliSelfTest, resetCliProbe } from './claudeCli';
export { jsonSchemaOf } from './apiBackend';

let resolved: Backend | null = null;

/** The backend that will serve calls, or null when there is none. */
export async function resolveBackend(): Promise<Backend | null> {
  if (resolved) return resolved;

  const choose = async (b: Backend): Promise<Backend | null> => ((await b.available()) ? b : null);

  switch (config.llm.provider) {
    case 'none':
      return null;
    case 'claude_cli':
      resolved = await choose(claudeCliBackend);
      break;
    case 'api':
      resolved = await choose(apiBackend);
      break;
    case 'auto':
      resolved = (await choose(claudeCliBackend)) ?? (await choose(apiBackend));
      break;
  }

  if (resolved) logger.info({ provider: resolved.kind }, 'model backend selected');
  return resolved;
}

/** Forget the cached choice, so installing the CLI takes effect without a restart. */
export function resetBackend(): void {
  resolved = null;
}

export interface ModelAccess {
  provider: ProviderKind;
  available: boolean;
  description: string;
  /** What is unavailable right now, in the user's terms. Empty when everything works. */
  limitations: string[];
}

export async function describeAccess(): Promise<ModelAccess> {
  const b = await resolveBackend();
  if (!b) {
    return {
      provider: 'none',
      available: false,
      description:
        config.llm.provider === 'none'
          ? 'Model calls are switched off (LLM_PROVIDER=none).'
          : 'No model access configured.',
      limitations: [
        'Resume reading is unavailable, so profile fields must be entered by hand.',
        'Answer drafting is unavailable, so answers must be written by hand.',
        'Everything else works: matching, eligibility, fact-checking, and the writing checks all run on this machine without a model.',
      ],
    };
  }
  return {
    provider: b.kind,
    available: true,
    description: b.describe(),
    limitations: [],
  };
}

/**
 * The single entry point for model calls.
 *
 * Throws `NoModelAccessError` with a message written for the user rather than returning
 * a null that every caller would have to remember to check.
 */
export async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const b = await resolveBackend();
  if (!b) {
    const access = await describeAccess();
    throw new NoModelAccessError(
      `${access.description}\n\n` +
        'To draft answers you need one of:\n' +
        '  - the Claude Code CLI installed and signed in (uses your Claude subscription), or\n' +
        '  - ANTHROPIC_API_KEY set (billed per token).\n\n' +
        'You can also write the answer yourself. It still gets fact-checked against your profile.',
    );
  }

  try {
    return await b.generate(req);
  } catch (err) {
    /**
     * Fall through when the chosen backend just discovered it cannot serve requests AT ALL.
     *
     * The CLI version-probes clean but is signed out; that only surfaces on a real call,
     * which latches it unavailable. Under `auto`, a working ANTHROPIC_API_KEY was resolved
     * as the fallback but never reached, so the user hit a "sign in to the CLI" wall with a
     * billed key that would have worked sitting right there. Re-resolving now skips the
     * now-unavailable CLI and lands on the API.
     *
     * Only when the backend has flipped to unavailable — a transient failure (a usage limit,
     * a timeout) leaves it available, so it does NOT fall through and billing never moves to
     * the API without the user's setup asking for it.
     */
    if (err instanceof NoModelAccessError && !(await b.available())) {
      resetBackend();
      const next = await resolveBackend();
      if (next && next.kind !== b.kind) return next.generate(req);
    }
    throw err;
  }
}
