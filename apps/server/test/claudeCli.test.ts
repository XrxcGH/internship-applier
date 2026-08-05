/**
 * The Claude Code CLI adapter, against a stand-in binary.
 *
 * The real CLI cannot be driven from a test: it needs a signed-in account, it costs the
 * developer's usage, and it would make the suite depend on a network. So this runs the
 * adapter against a script that speaks the same contract, which pins the parts that are
 * genuinely ours:
 *
 *   - the arguments we construct;
 *   - that the prompt reaches the child on STDIN, which is the failure that would not
 *     look like a failure (generation would succeed and answer the wrong question);
 *   - that the system prompt goes via a file rather than a command line, since Windows
 *     caps one near 8191 characters and our prompts carry evidence and writing samples;
 *   - that each documented failure produces a message written for a person.
 *
 * The flags themselves were verified against the real CLI (2.1.222): `--print`,
 * `--output-format json`, `--system-prompt-file`, `--max-turns`, `--allowedTools`,
 * `--add-dir`, and `--json-schema` all exist and parse. The envelope shape below is
 * copied from a real unauthenticated response.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NoModelAccessError } from '../src/infra/llm/provider';
import {
  claudeCliBackend,
  notLoggedInMessage,
  resetCliProbe,
  usageLimitMessage,
} from '../src/infra/llm/claudeCli';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';

let dir: string;
let fakeBin: string;
let logFile: string;

/**
 * A stand-in `claude`. Records how it was invoked, then answers like the real one.
 *
 * Written as a Node script invoked through the CLAUDE_CLI_PATH escape hatch, so the
 * adapter's own binary discovery is bypassed and only its argument handling is under test.
 */
function writeFakeCli(behaviour: 'ok' | 'not_logged_in' | 'usage_limit' | 'garbage' | 'crash') {
  const script = `
const fs = require('fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));

  if (process.argv.includes('--version')) { process.stdout.write('2.1.222 (Claude Code)\\n'); process.exit(0); }
  const mode = ${JSON.stringify(behaviour)};
  if (mode === 'garbage') { process.stdout.write('<html>not json</html>'); process.exit(0); }
  if (mode === 'crash') { process.stderr.write('boom'); process.exit(3); }

  const env = { type: 'result', subtype: 'success', session_id: 'x', num_turns: 1, total_cost_usd: 0.01, is_error: false, result: '' };
  if (mode === 'not_logged_in') { env.is_error = true; env.result = 'Not logged in · Please run /login'; }
  else if (mode === 'usage_limit') { env.is_error = true; env.result = 'Claude usage limit reached. Try again later.'; }
  else { env.result = 'ECHO:' + stdin.trim(); }
  process.stdout.write(JSON.stringify(env));
  process.exit(0);
});
`;
  // A .js target, which the adapter runs through node with no shell. That is the same
  // shell-free path production uses for the real executable, so a .cmd wrapper here would
  // test a route the adapter deliberately does not take.
  fakeBin = path.join(dir, 'fake-claude.js');
  writeFileSync(fakeBin, script, 'utf8');
  process.env['CLAUDE_CLI_PATH'] = fakeBin;
  resetCliProbe();
}

function invocation(): { argv: string[]; stdin: string } {
  return JSON.parse(readFileSync(logFile, 'utf8')) as { argv: string[]; stdin: string };
}

// A generated answer is written to the llm_call ledger, so the tables have to exist or
// every call in this file logs a failed insert.
beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ia-fakecli-'));
  logFile = path.join(dir, 'invocation.json');
  db.delete(schema.llmCall).run();
});

afterEach(() => {
  delete process.env['CLAUDE_CLI_PATH'];
  resetCliProbe();
  rmSync(dir, { recursive: true, force: true });
});

describe('what the adapter actually runs', () => {
  it('sends the user prompt on stdin, not the command line', async () => {
    writeFakeCli('ok');
    const long = 'evidence '.repeat(2000); // Well past the Windows argv limit.
    const res = await claudeCliBackend.generate({
      purpose: 'answer_draft',
      system: 'be brief',
      user: long,
    });

    const inv = invocation();
    expect(inv.stdin).toContain('evidence');
    // The prompt must not appear in argv at any length.
    expect(inv.argv.join(' ')).not.toContain('evidence');
    // And the model's answer comes back, proving the round trip.
    expect(res.text).toContain('ECHO:');
  }, 60_000);

  it('passes the system prompt as a file, not as an argument', async () => {
    writeFakeCli('ok');
    const system = 'VOICE INSTRUCTIONS '.repeat(500);
    await claudeCliBackend.generate({ purpose: 'answer_draft', system, user: 'hi' });

    const inv = invocation();
    const i = inv.argv.indexOf('--system-prompt-file');
    expect(i, 'should use the file form').toBeGreaterThan(-1);
    expect(inv.argv.join(' ')).not.toContain('VOICE INSTRUCTIONS');
  }, 60_000);

  it('replaces the default prompt rather than appending to it', async () => {
    // Claude Code's own prompt frames the model as a coding agent in a repository, which
    // is the wrong voice for a job application.
    writeFakeCli('ok');
    await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });
    expect(invocation().argv).toContain('--system-prompt-file');
    expect(invocation().argv).not.toContain('--append-system-prompt-file');
  }, 60_000);

  it('asks for JSON output and one turn with no tools', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });

    const argv = invocation().argv;
    expect(argv).toContain('--print');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('json');
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('1');
    // 'none', not an empty string: cmd.exe drops empty argv elements when spawning the
    // .cmd shim, and a name matching no tool grants exactly as much as one.
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('none');
  }, 60_000);

  it('grants Read and only the document directory when a file must be read', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({
      purpose: 'resume_extraction',
      system: 's',
      user: 'read it',
      documents: [path.join(dir, 'resume.pdf')],
    });

    const argv = invocation().argv;
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read');
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(dir);
    // A document needs more than one turn to find and read.
    expect(Number(argv[argv.indexOf('--max-turns') + 1])).toBeGreaterThan(1);
  }, 60_000);

  /**
   * The cost panel reads the llm_call ledger and nothing else, so a backend that skips it
   * reports "No model calls yet." however much work it has done. That was the state for
   * the CLI path, which is the one most users are on.
   */
  it('records the call in the ledger, at no cost', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });

    const rows = db.select().from(schema.llmCall).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe('answer_draft');
    // A subscription is not billed per token, and the CLI does not say which model
    // answered, so the row is a count and a latency rather than a price.
    expect(rows[0]?.costUsd).toBe(0);
  }, 60_000);

  it('passes a JSON schema through when one is asked for', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({
      purpose: 'resume_extraction',
      system: 's',
      user: 'u',
      schema: { name: 'profile', jsonSchema: { type: 'object' } },
    });
    const argv = invocation().argv;
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1]!)).toEqual({ type: 'object' });
  }, 60_000);
});

describe('failures a person can act on', () => {
  const fails = async (): Promise<string> => {
    try {
      await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });
      return '(no error thrown)';
    } catch (err) {
      expect(err).toBeInstanceOf(NoModelAccessError);
      return (err as Error).message;
    }
  };

  it('tells an unsigned-in user exactly what to do', async () => {
    writeFakeCli('not_logged_in');
    const msg = await fails();
    expect(msg).toMatch(/not signed in/i);
    expect(msg).toMatch(/run `claude`/);
    // "Please run /login" is accurate but assumes you are already inside Claude Code.
    expect(msg).not.toMatch(/\/login/);
  }, 60_000);

  it('explains a used-up usage limit without treating it as a crash', async () => {
    writeFakeCli('usage_limit');
    const msg = await fails();
    expect(msg).toMatch(/usage limit/i);
    expect(msg).toMatch(/refills/i);
    // And says the rest of the app still works, so the user does not conclude it is broken.
    expect(msg).toMatch(/write the answer yourself/i);
  }, 60_000);

  /**
   * The failure text used to be matched against the whole of stdout, which on a
   * successful run is the envelope holding the model's own answer. A draft that mentioned
   * a rate limit — an entirely ordinary thing for a software intern to have worked on —
   * was thrown away and reported as an exhausted subscription.
   */
  it('does not mistake a successful answer about rate limits for a rate-limit error', async () => {
    writeFakeCli('ok');
    const res = await claudeCliBackend.generate({
      purpose: 'answer_draft',
      system: 'be brief',
      user: 'I built a rate limit for our API and handled quota exhaustion; try again later.',
    });
    expect(res.text).toContain('rate limit');
  }, 60_000);

  it('says the output was unreadable rather than returning an empty draft', async () => {
    writeFakeCli('garbage');
    const msg = await fails();
    expect(msg).toMatch(/could not read/i);
    expect(msg).toMatch(/different output format/i);
  }, 60_000);

  it('surfaces a non-zero exit with its stderr', async () => {
    writeFakeCli('crash');
    const msg = await fails();
    expect(msg).toMatch(/reported an error/i);
    expect(msg).toContain('boom');
  }, 60_000);

  it('says the CLI is missing, and how to install it', async () => {
    process.env['CLAUDE_CLI_PATH'] = path.join(dir, 'does-not-exist');
    resetCliProbe();
    const msg = await fails();
    expect(msg).toMatch(/claude\.ai\/install|npm install -g @anthropic-ai\/claude-code/);
  }, 60_000);
});

describe('the message matchers on their own', () => {
  it('recognises the real not-logged-in text', () => {
    // Copied verbatim from the CLI at 2.1.222.
    expect(notLoggedInMessage('Not logged in · Please run /login')).toBeTruthy();
    expect(notLoggedInMessage('a perfectly normal answer')).toBeNull();
  });

  it('recognises limit wording without swallowing ordinary prose', () => {
    expect(usageLimitMessage('Claude usage limit reached')).toBeTruthy();
    expect(usageLimitMessage('I have no limits on my availability')).toBeNull();
  });
});
