import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiErrorCode } from '@ia/shared';
import { RUN_CONFLICTS } from '../src/routes/filling';

/**
 * The prefix mapping that turns a run conflict into a 409 rather than a 502.
 *
 * `RUN_CONFLICTS` matches `message.startsWith(...)` against error strings thrown in
 * core/filling/run.ts, and nothing tested the join between the two sides. Reword either and
 * the route silently degrades to the 502 the mutual-exclusion work existed to eliminate —
 * which reads to a client as "the site broke" and invites the retry that races the very run
 * being refused. Nothing would go red.
 *
 * Asserted against the strings the module ACTUALLY throws, read out of its source, rather
 * than against copies of them. A test holding its own copy would agree with itself forever.
 */

const RUN_SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/core/filling/run.ts'),
  'utf8',
);

/**
 * Every literal handed to `new Error(...)` in that module, however it was wrapped.
 *
 * Two shapes appear: a string on the same line, and a string on the next line where the
 * message was too long. A named constant (`DISCARDED_WHILE_OPENING`) is picked up from its
 * declaration instead, since the throw site only names the constant.
 */
function thrownMessages(): string[] {
  const inline = [...RUN_SOURCE.matchAll(/throw new Error\(\s*\n?\s*'([^']+)'/g)].map((m) => m[1]!);
  const consts = [...RUN_SOURCE.matchAll(/^const [A-Z_]+ =\s*\n?\s*'([^']+)'/gm)].map((m) => m[1]!);
  return [...new Set([...inline, ...consts])];
}

/** A refusal about the RUN — never about the page, which is what a 502 is for. */
const ABOUT_THE_RUN =
  /^(This application is already|No open fill run|Another application has|This fill run was)/;

describe('run conflicts map to a status the client can act on', () => {
  const messages = thrownMessages();

  it('finds the refusals the module actually produces', () => {
    // A guard on the guard: if the extraction stops matching, every assertion below would
    // pass vacuously over an empty list.
    expect(messages.length).toBeGreaterThanOrEqual(4);
  });

  it('gives every refusal about the run a conflict code', () => {
    const aboutTheRun = messages.filter((m) => ABOUT_THE_RUN.test(m));
    expect(aboutTheRun.length).toBeGreaterThanOrEqual(4);

    for (const message of aboutTheRun) {
      const hit = RUN_CONFLICTS.find((c) => message.startsWith(c.startsWith));
      expect({ message, mapped: hit !== undefined }).toEqual({ message, mapped: true });
    }
  });

  it('separates "this one is busy" from "a different one has the browser"', () => {
    // Two different questions with two different answers: the first clears when this run
    // finishes, the second only when another application's browser is closed. Collapsing
    // them would tell the user to wait for something that is never going to happen.
    const busy = messages.find((m) => m.startsWith('Another application has the browser open'));
    const same = messages.find((m) => m.startsWith('This application is already being filled'));
    expect(busy, 'the other-application refusal').toBeDefined();
    expect(same, 'the same-application refusal').toBeDefined();

    const codeFor = (m: string) => RUN_CONFLICTS.find((c) => m.startsWith(c.startsWith))?.code;
    expect(codeFor(busy!)).toBe('FILL_BROWSER_BUSY');
    expect(codeFor(same!)).toBe('FILL_IN_PROGRESS');
  });

  it('treats a run the user discarded or stopped as a conflict, not a failure', () => {
    // The user pressed the button. Answering "the site broke" would be a lie, and the 502
    // path is also the one that records the application as filled.
    for (const m of messages.filter((x) => x.startsWith('This fill run was'))) {
      expect(RUN_CONFLICTS.find((c) => m.startsWith(c.startsWith))?.code, m).toBe('NO_RUN');
    }
  });

  it('declares every code it maps to', () => {
    for (const c of RUN_CONFLICTS) {
      expect(ApiErrorCode.options, c.code).toContain(c.code);
    }
  });

  it('has no entry that matches nothing the module throws', () => {
    // A prefix left behind after a rewording is dead weight that reads as coverage.
    for (const c of RUN_CONFLICTS) {
      const matched = messages.some((m) => m.startsWith(c.startsWith));
      expect({ prefix: c.startsWith, matched }).toEqual({ prefix: c.startsWith, matched: true });
    }
  });
});
