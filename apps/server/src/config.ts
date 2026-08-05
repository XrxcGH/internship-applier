import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVER_HOST: z.string().default('127.0.0.1'),
  SERVER_PORT: z.coerce.number().int().positive().default(8787),
  WEB_PORT: z.coerce.number().int().positive().default(5173),
  DATABASE_PATH: z.string().default('./data/app.db'),

  /**
   * Where model calls go. See docs/14-model-access.md.
   *
   * `auto`      — use the Claude Code CLI if it is installed, else an API key, else
   *               run with no model at all (everything except drafting and resume
   *               extraction still works).
   * `claude_cli` — spawn the user's own `claude` binary. Their subscription, their
   *               credentials; this process never sees a token.
   * `api`       — ANTHROPIC_API_KEY against the Anthropic API.
   * `none`      — refuse model calls outright, with a clear message.
   */
  LLM_PROVIDER: z.enum(['auto', 'claude_cli', 'api', 'none']).default('auto'),
  /** Override if the binary is not on PATH. */
  CLAUDE_CLI_PATH: z.string().optional(),
  /** Per-call ceiling. A hung CLI must not wedge a request forever. */
  CLAUDE_CLI_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.treeifyError(parsed.error));
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
  isTest: env.NODE_ENV === 'test',
  logLevel: env.LOG_LEVEL,

  server: {
    /** Loopback only. Never bind 0.0.0.0 — see docs/10-security-privacy.md. */
    host: env.SERVER_HOST,
    port: env.SERVER_PORT,
  },

  web: {
    origin: `http://127.0.0.1:${env.WEB_PORT}`,
  },

  llm: {
    provider: env.LLM_PROVIDER,
    cliPath: env.CLAUDE_CLI_PATH,
    cliTimeoutMs: env.CLAUDE_CLI_TIMEOUT_MS,
  },

  paths: {
    root: REPO_ROOT,
    data: path.resolve(REPO_ROOT, 'data'),
    database: path.resolve(REPO_ROOT, env.DATABASE_PATH),
    resumes: path.resolve(REPO_ROOT, 'data/resumes'),
    artifacts: path.resolve(REPO_ROOT, 'data/artifacts'),
    browserProfile: path.resolve(REPO_ROOT, 'data/browser-profile'),
    migrations: path.resolve(REPO_ROOT, 'apps/server/drizzle'),
  },

  /**
   * Random per-run token required in X-App-Token on every route. Stops other local
   * processes and stray browser pages from driving the API. Not a security boundary
   * against a compromised machine — see docs/10-security-privacy.md § Threat model.
   */
  appToken: crypto.randomUUID(),
} as const;

export type Config = typeof config;
