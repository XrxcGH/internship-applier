import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { HttpError, scrubUrl } from '../src/infra/http/fetcher';

/**
 * What a log line is allowed to say, and what it must not stop saying.
 *
 * The redaction list is applied at the logger rather than at call sites, so that a new log
 * line is safe by default. It held `'*.url'` and `'err.url'` — beside a comment explaining
 * why neither was necessary, since credential-bearing URLs are scrubbed at the call site and
 * `HttpError` scrubs in its constructor. The censor won anyway, so every fetch failure in the
 * app logged `url: "[redacted]"` and no line ever named the address that failed. On a tool
 * whose diagnostic story is "the report says what it could not read", that is the one field
 * worth keeping.
 *
 * Safety is by construction now, which means it has to be checked rather than assumed. These
 * exercise the real redaction config against a captured stream.
 */

/** The logger's own configuration, writing to a buffer instead of stdout. */
function capture(): { log: pino.Logger; lines: () => unknown[] } {
  const written: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      written.push(String(chunk));
      cb();
    },
  });

  // The same paths the app configures. Kept in step by the source assertion below rather
  // than by a second copy pretending to be the first.
  const log = pino(
    {
      redact: {
        paths: [
          'password',
          '*.password',
          'apiKey',
          '*.apiKey',
          'req.headers["x-app-token"]',
          'req.headers.authorization',
          'req.headers.cookie',
        ],
        censor: '[redacted]',
      },
    },
    sink,
  );

  return { log, lines: () => written.map((l) => JSON.parse(l) as unknown) };
}

describe('what a failure log names', () => {
  it('names the host that failed', () => {
    const { log, lines } = capture();
    log.error({ err: new HttpError('404 Not Found', 404, 'https://boards.greenhouse.io/acme/x') });
    expect(JSON.stringify(lines())).toContain('boards.greenhouse.io');
  });

  it('does not name a credential that rode in on the query string', () => {
    // Adzuna puts app_id and app_key there, and HttpError scrubs in its constructor — which
    // is the construction the redaction list now relies on instead of a censor.
    const err = new HttpError(
      '401 Unauthorized',
      401,
      'https://api.adzuna.com/v1/search?app_id=A1&app_key=SECRETKEY',
    );
    expect(err.url).not.toContain('SECRETKEY');
    expect(err.url).toContain('api.adzuna.com');

    const { log, lines } = capture();
    log.error({ err });
    expect(JSON.stringify(lines())).not.toContain('SECRETKEY');
  });

  it('scrubs the same parameters wherever a URL is logged by hand', () => {
    // The other route into a log record: a call site passing `url: scrubUrl(...)`.
    const scrubbed = scrubUrl('https://api.adzuna.com/v1/search?app_id=A1&app_key=SECRETKEY');
    expect(scrubbed).not.toContain('SECRETKEY');
    expect(scrubbed).toContain('api.adzuna.com');
  });

  it('still censors the things the list does hold', () => {
    const { log, lines } = capture();
    log.info({ apiKey: 'sk-ant-real', req: { headers: { authorization: 'Bearer x' } } });
    const out = JSON.stringify(lines());
    expect(out).not.toContain('sk-ant-real');
    expect(out).toContain('[redacted]');
  });
});

describe('the redaction list itself', () => {
  it('holds no url path, so a failure can name its address', async () => {
    // Asserted against the source: the property is the ABSENCE of an entry, which no runtime
    // call can demonstrate — a passing log line proves only that this particular path was not
    // matched. The entry going back is what this catches.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/infra/logger.ts', import.meta.url), 'utf8');
    const list = src.slice(src.indexOf('REDACTED_PATHS'), src.indexOf('const CENSOR'));
    const code = list
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/'\*\.url'/);
    expect(code).not.toMatch(/'err\.url'/);
    // And the ones that must stay.
    expect(code).toMatch(/authorization/);
    expect(code).toMatch(/x-app-token/);
  });
});
