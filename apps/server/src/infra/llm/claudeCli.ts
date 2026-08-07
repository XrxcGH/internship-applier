/**
 * The Claude Code CLI as a model backend — docs/14-model-access.md.
 *
 * WHY THIS EXISTS. A Claude Max subscription is not an API key, and Anthropic explicitly
 * prohibits using a subscription's OAuth token inside another product. So this backend
 * does the one thing that is not that: it runs Anthropic's own client as a subprocess on
 * the user's own machine. The CLI authenticates itself. This process never reads
 * ~/.claude, never handles a token, and never talks to api.anthropic.com.
 *
 * WHAT THIS IS FOR: a personal tool, run locally, by the person whose subscription it is.
 * WHAT IT IS NOT: a way to ship software that borrows other people's subscriptions.
 * docs/14 says so next to the policy text.
 *
 * THREE CONSTRAINTS SHAPE THE INVOCATION, and they are not obvious:
 *
 *   1. `--bare` cannot be used. It skips credential discovery and then demands an
 *      ANTHROPIC_API_KEY, which is exactly what we do not have. Tools/skills/MCP are
 *      disabled with `--allowedTools` instead.
 *
 *   2. Long text cannot go on the command line. Windows caps a command line near 8191
 *      characters and our prompts carry an evidence block plus writing samples. The
 *      system prompt goes to a temp file via `--system-prompt-file`; the user content
 *      goes on stdin, which the CLI reads as input data.
 *
 *   3. `--system-prompt-file` REPLACES Claude Code's default prompt rather than appending
 *      to it. That is what we want: the default frames the model as a coding agent
 *      working in a repository, which is the wrong voice for a job application.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../config';
import { logger } from '../logger';
import { CLI_MODEL, recordCall } from './client';
import {
  NoModelAccessError,
  type Backend,
  type GenerateRequest,
  type GenerateResult,
} from './provider';

const INSTALL_HINT =
  'Install it, then run `claude` once and sign in with your Claude account:\n\n' +
  '  irm https://claude.ai/install.ps1 | iex        (PowerShell, recommended)\n' +
  '  winget install Anthropic.ClaudeCode\n' +
  '  npm install -g @anthropic-ai/claude-code\n\n' +
  'If it is installed somewhere unusual, set CLAUDE_CLI_PATH in .env to the full path.';

/**
 * Binaries to try, in order of preference.
 *
 * The native installer produces a real `claude.exe`, which Node can spawn directly. An
 * npm global install produces a `claude.cmd` shim, and Windows cannot execute a .cmd
 * without a shell. Preferring the .exe keeps `shell: false`, so nothing we pass is ever
 * re-parsed by cmd.exe.
 */
interface Candidate {
  bin: string;
}

/**
 * Where to look, best first.
 *
 * NOTHING HERE USES A SHELL, and that is the important property. The npm install puts a
 * `claude.cmd` shim on PATH, and Node cannot execute a .cmd without `shell: true` — which
 * concatenates arguments instead of escaping them (Node's own DEP0190 warning). Measured:
 * `--json-schema {"type":"object"}` reaches the CLI mangled and is rejected as invalid
 * JSON. So the shim is skipped entirely in favour of the real executable it wraps, which
 * both the npm package and the native installer ship.
 */
function candidates(): Candidate[] {
  // Read from the environment rather than the frozen config snapshot, so setting this
  // takes effect without a restart.
  const override = process.env['CLAUDE_CLI_PATH'] ?? config.llm.cliPath;
  if (override) return [{ bin: override }];

  if (process.platform !== 'win32') return [{ bin: 'claude' }];

  const home = process.env['USERPROFILE'] ?? os.homedir();
  const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');

  return [
    // Native installer.
    { bin: path.join(home, '.local', 'bin', 'claude.exe') },
    // npm global: the executable the .cmd shim calls. Named explicitly rather than
    // trusting PATH, because a server started before the install has a stale environment.
    {
      bin: path.join(
        appData,
        'npm',
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'bin',
        'claude.exe',
      ),
    },
    { bin: 'claude.exe' },
  ];
}

/** Interpreted targets, so a JS entry point can be pointed at directly. */
const JS_ENTRY = /\.(c|m)?js$/i;

/** Resolves a candidate to something spawnable with no shell involved. */
function commandFor(c: Candidate): { file: string; prefix: string[] } {
  return JS_ENTRY.test(c.bin)
    ? { file: process.execPath, prefix: [c.bin] }
    : { file: c.bin, prefix: [] };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function run(c: Candidate, args: string[], stdin: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      const { file, prefix } = commandFor(c);
      child = spawn(file, [...prefix, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Never a shell. See `candidates()` for what that costs and why it is worth it.
        shell: false,
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, config.llm.cliTimeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    // The child may exit before stdin drains; `close` reports the real outcome.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin, 'utf8');
  });
}

// ───────────────────────────────────────────────────────────── capability probe

let found: Candidate | null = null;
let version = '';
let failure: string | null = null;

async function probe(): Promise<Candidate | null> {
  if (found) return found;
  if (failure) return null;

  for (const c of candidates()) {
    if (path.isAbsolute(c.bin) && !existsSync(c.bin)) continue;
    const r = await run(c, ['--version'], '');
    if (r.code === 0 && /\d+\.\d+/.test(r.stdout)) {
      found = c;
      // `--version` prints "2.1.222 (Claude Code)". Keep the number; the name is already
      // in every sentence this gets interpolated into.
      version = (/[\d.]+/.exec(r.stdout)?.[0] ?? r.stdout).trim();
      logger.info({ bin: c.bin, version }, 'model calls will use the Claude Code CLI');
      return found;
    }
  }

  failure = config.llm.cliPath
    ? `CLAUDE_CLI_PATH is set to ${config.llm.cliPath}, but running it did not work.`
    : 'The `claude` command was not found on this machine.';
  return null;
}

/** Lets the app notice a CLI installed after startup, and gives tests a clean slate. */
export function resetCliProbe(): void {
  found = null;
  version = '';
  failure = null;
}

// ────────────────────────────────────────────────────────────── response parsing

/**
 * The `--output-format json` envelope.
 *
 * Every field is optional on purpose. This contract belongs to a separately released
 * program, so a field that changes shape should surface as a readable error from
 * `extractText`, not as a crash at a property access.
 */
interface CliEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: number;
  session_id?: string;
  num_turns?: number;
}

function parseEnvelope(stdout: string): CliEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CliEnvelope;
  } catch {
    // Some versions emit newline-delimited objects; the last complete one is the result.
    const lines = trimmed.split('\n').filter((l) => l.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]!) as CliEnvelope;
      } catch {
        continue;
      }
    }
    return null;
  }
}

function extractText(env: CliEnvelope): string {
  if (typeof env.result === 'string') return env.result.trim();
  if (env.result && typeof env.result === 'object') {
    const r = env.result as { text?: unknown; content?: unknown };
    if (typeof r.text === 'string') return r.text.trim();
    if (Array.isArray(r.content)) {
      return r.content
        .map((b: unknown) =>
          b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
            ? (b as { text: string }).text
            : '',
        )
        .join('')
        .trim();
    }
  }
  return '';
}

/**
 * Usage exhaustion is the failure a subscription user will actually hit, and an exit code
 * teaches them nothing. Matched on the CLI's own words: the docs do not promise a distinct
 * exit code, and they do say a failure is printed as the result on stdout.
 */
export function usageLimitMessage(text: string): string | null {
  if (!/usage limit|rate limit|limit reached|quota|try again (later|at|in)/i.test(text)) {
    return null;
  }
  return (
    'Your Claude usage limit is currently used up, so nothing could be generated. It refills ' +
    'on a rolling window. Everything else here still works: write the answer yourself and it ' +
    'gets fact-checked against your profile exactly the same way.'
  );
}

/**
 * The other failure a subscription user actually hits, and the first one they will hit.
 *
 * Verified against the real CLI: an unauthenticated run exits with `is_error: true` and
 * `result: "Not logged in · Please run /login"`. That is accurate but assumes you are
 * sitting in Claude Code, which the person reading this is not.
 */
export function notLoggedInMessage(text: string): string | null {
  if (!/not logged in|please run \/login|\bunauthorized\b|no credentials/i.test(text)) {
    return null;
  }
  return (
    'The Claude Code CLI is installed but not signed in yet.\n\n' +
    'Open a terminal, run `claude`, and sign in with your Claude account. It only needs ' +
    'doing once. Then come back and press Test.'
  );
}

// ─────────────────────────────────────────────────────────────────── the backend

/** Short, fixed, and safe on any command line. The real content arrives on stdin. */
const STDIN_DIRECTIVE =
  'The full task is provided on standard input. Read it and respond to it directly.';

/**
 * An allowlist entry that matches no tool, which is how "grant nothing" is expressed.
 *
 * See the call site: the obvious spelling, an empty string, is silently dropped when the
 * npm .cmd shim is spawned through cmd.exe on Windows.
 */
const NO_TOOLS = 'none';

/**
 * The schema, in the dialect `--json-schema` will actually take.
 *
 * Zod stamps `"$schema": "https://json-schema.org/draft/2020-12/schema"` on everything it
 * emits, and the CLI's validator has no such meta-schema registered — it rejects the whole
 * argument before the request is even made, with
 *
 *     Error: --json-schema is not a valid JSON Schema:
 *     no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
 *
 * The same schema with that one key removed is accepted. Nothing else about it changes, and
 * the API path keeps the key because the API wants it, so this strips rather than rewrites.
 * Recursive, because a nested `$defs` entry can carry its own.
 */
function forCli(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forCli);
  if (schema === null || typeof schema !== 'object') return schema;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === '$schema') continue;
    out[k] = forCli(v);
  }
  return out;
}

export const claudeCliBackend: Backend = {
  kind: 'claude_cli',

  async available(): Promise<boolean> {
    return (await probe()) !== null;
  },

  describe(): string {
    return found
      ? `Claude Code CLI ${version} — your subscription, no API billing`
      : 'Claude Code CLI (not installed)';
  },

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const c = await probe();
    if (!c) {
      throw new NoModelAccessError(
        `${failure ?? 'The Claude Code CLI is unavailable.'}\n\n${INSTALL_HINT}`,
      );
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), 'ia-claude-'));
    const systemFile = path.join(dir, 'system.txt');

    try {
      await writeFile(systemFile, req.system, 'utf8');

      const wantsDocuments = (req.documents?.length ?? 0) > 0;

      // `req.maxTokens` has no counterpart on this path. The CLI publishes no flag for an
      // output cap, and every flag below was checked against the real binary rather than
      // guessed, so length here is bounded by the word target the prompt already states.
      // The API path applies it as a hard limit; expect the two to differ a little.
      const args = [
        '--print',
        STDIN_DIRECTIVE,
        '--output-format',
        'json',
        // Replaces Claude Code's coding-agent prompt outright. See the header.
        '--system-prompt-file',
        systemFile,
        '--max-turns',
        wantsDocuments ? '6' : '1',
      ];

      if (wantsDocuments) {
        // A PDF cannot be passed inline; it has to be read from disk, which needs the
        // Read tool and an explicitly permitted directory. Only the directories holding
        // the requested files are granted, never the repository.
        args.push('--allowedTools', 'Read');
        for (const d of new Set(req.documents!.map((f) => path.dirname(f)))) {
          args.push('--add-dir', d);
        }
      } else {
        // NOT an empty string. `--allowedTools ""` parses fine from a shell, but an
        // empty argv element is dropped when the .cmd shim is spawned through cmd.exe,
        // and the CLI then rejects the flag as missing its argument. This is an
        // allowlist, so a name that matches no tool grants nothing — and unlike an empty
        // string it survives the trip. `--max-turns 1` bounds it regardless.
        args.push('--allowedTools', NO_TOOLS);
      }

      if (req.schema) {
        args.push('--json-schema', JSON.stringify(forCli(req.schema.jsonSchema)));
      }

      const stdin = wantsDocuments
        ? `${req.user}\n\nThe files to read:\n${req.documents!.join('\n')}\n`
        : req.user;

      const started = Date.now();
      const r = await run(c, args, stdin);

      if (r.timedOut) {
        throw new NoModelAccessError(
          `The Claude CLI did not finish within ${Math.round(config.llm.cliTimeoutMs / 1000)}s and was stopped. ` +
            'Try again, or raise CLAUDE_CLI_TIMEOUT_MS in .env.',
        );
      }

      const env = parseEnvelope(r.stdout);

      /**
       * Sign-in and usage-limit failures arrive inside a successful-looking JSON envelope
       * with is_error set, so they are matched on the text before the generic error path
       * flattens them into "the CLI reported an error: Not logged in".
       *
       * ONLY ON A FAILED RUN, though. This used to match against the whole of stdout,
       * which on a SUCCESSFUL run is the envelope containing the model's own answer — so
       * a perfectly good draft that happened to contain "rate limit", "quota" or
       * "unauthorized" was thrown away and reported to the user as an exhausted
       * subscription. An answer about a rate-limiting project is not a rate-limit error.
       */
      if (env?.is_error !== false) {
        const combined = `${env ? extractText(env) : r.stdout}\n${r.stderr}`;
        const notSignedIn = notLoggedInMessage(combined);
        if (notSignedIn) throw new NoModelAccessError(notSignedIn);

        const limit = usageLimitMessage(combined);
        if (limit) throw new NoModelAccessError(limit);
      }

      // A crash is diagnosed before a parse failure, because a crashed process produces
      // no output and "the output format must have changed" is then exactly the wrong
      // thing to tell someone. Order matters more than either message.
      if (env?.is_error === true || r.code !== 0) {
        const detail =
          (env ? extractText(env) : '') || r.stderr.trim() || `exit code ${String(r.code)}`;
        logger.error(
          { code: r.code, detail: detail.slice(0, 300) },
          'claude cli reported an error',
        );
        throw new NoModelAccessError(`The Claude CLI reported an error: ${detail}`);
      }

      if (!env) {
        logger.error(
          { code: r.code, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) },
          'could not parse Claude CLI output',
        );
        throw new NoModelAccessError(
          'The Claude CLI ran but returned something this app could not read. It may have been ' +
            'updated to a different output format.\n\n' +
            `Exit code: ${String(r.code)}\n` +
            `Output began: ${r.stdout.slice(0, 200) || '(empty)'}\n` +
            `Errors: ${r.stderr.slice(0, 200) || '(none)'}`,
        );
      }

      const text = extractText(env);
      const latencyMs = Date.now() - started;
      logger.debug(
        { purpose: req.purpose, ms: latencyMs, costUsd: env.total_cost_usd, chars: text.length },
        'claude cli call',
      );

      // The cost panel reads the llm_call ledger and nothing else, and this backend wrote
      // nothing to it. A user whose drafting all runs through the CLI — the preferred
      // backend under `auto` — opened the panel after twenty answers and read "No model
      // calls yet.", with no per-purpose counts and no way to trace a bad draft back.
      recordCall({
        purpose: req.purpose,
        model: CLI_MODEL,
        usage: { input_tokens: 0, output_tokens: 0 },
        latencyMs,
        stopReason: env.subtype ?? null,
      });

      return {
        text,
        structured: env.structured_output,
        stopReason: env.subtype ?? null,
        provider: 'claude_cli',
        costUsd: env.total_cost_usd,
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

/**
 * End-to-end check, exposed so the user can confirm the wiring rather than discovering a
 * problem mid-draft.
 *
 * It verifies the part that documentation is least explicit about: that content on stdin
 * actually reaches the model. If stdin were ignored, ordinary generation would not fail —
 * it would quietly answer the wrong question, which is far worse than an error.
 */
export async function selfTest(): Promise<{ ok: boolean; detail: string }> {
  const c = await probe();
  if (!c) return { ok: false, detail: failure ?? 'The Claude Code CLI is not installed.' };

  try {
    const res = await claudeCliBackend.generate({
      purpose: 'answer_draft',
      system: 'You are being tested. Reply with exactly the word the user gives you, nothing else.',
      user: 'The word is: haddock. Reply with that word only.',
    });
    const ok = /haddock/i.test(res.text);
    return {
      ok,
      detail: ok
        ? `Working. ${claudeCliBackend.describe()}`
        : `The CLI answered, but did not see the input sent to it. It replied: ${res.text.slice(0, 120) || '(nothing)'}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
