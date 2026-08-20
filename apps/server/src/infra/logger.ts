import { pino } from 'pino';
import { config } from '../config';

/**
 * PII redaction is applied at the logger level, not at call sites, so a new log
 * statement can't accidentally leak a resume field. See docs/10-security-privacy.md.
 *
 * Two mechanisms, because neither covers the other's ground. The paths below are pino's
 * own redaction and reach into anything, including objects a serializer produced. But a
 * pino path wildcard matches exactly ONE segment, so the list stops at `{profile: {email}}`
 * and a record one level deeper — `{run: {profile: {email}}}` — printed the address, the
 * phone number and the date of birth in full. `censorPii` below closes that by walking the
 * record itself.
 */
const REDACTED_PATHS = [
  'fullName',
  'email',
  'phone',
  'dateOfBirth',
  'address',
  'profile.fullName',
  'profile.email',
  'profile.phone',
  'profile.dateOfBirth',
  'profile.address',
  '*.fullName',
  '*.email',
  '*.phone',
  '*.dateOfBirth',
  // Was missing while every other PII field had a wildcard, so a nested address slipped
  // through the one mechanism meant to make call sites safe by default.
  '*.address',
  // NO `url` PATH HERE, AND THAT IS THE POINT.
  //
  // Some source URLs carry credentials in the query string (Adzuna app_id/app_key), so this
  // list used to hold `'*.url'` and `'err.url'`. The comment beside them already explained
  // why they were unnecessary — credential-bearing URLs are scrubbed at the call site, and
  // `HttpError` scrubs in its constructor, "so the value in `err.url` is already safe before
  // this list sees it" — and then redacted the field anyway. The result: every fetch failure
  // in the app logged `url: "[redacted]"`, so no log line ever named the address that failed.
  // On a tool whose whole diagnostic story is "the run report says what it could not read",
  // that is the one field worth having.
  //
  // Safety here is by construction rather than by censor, and it is checked: `scrubUrl` is
  // the only way a URL reaches a log record — see the logger tests, which assert both that a
  // failure names its host and that an Adzuna key is gone by the time it is written.
  'req.headers["x-app-token"]',
  'req.headers.authorization',
  'req.headers.cookie',
];

const CENSOR = '[redacted]';

/** The field names that are PII wherever they turn up, at whatever depth. */
const PII_KEYS = new Set(['fullName', 'email', 'phone', 'dateOfBirth', 'address']);

/**
 * Deep enough for any record this app actually builds. Below it the whole subtree is
 * censored rather than passed through: an object nested that far is either a mistake or
 * something adversarial, and neither is worth printing a name out of.
 */
const MAX_CENSOR_DEPTH = 8;

/**
 * Only plain objects and arrays are walked.
 *
 * Anything with a real prototype — an Error, a Fastify request, a Playwright handle — is
 * left alone and handed to pino as it was. Copying those would be expensive on every single
 * log line and would break the serializers that know how to render them; the paths above
 * still cover them to the depth pino reaches. Nothing is mutated in place, because a record
 * being logged is usually still in use by the caller and replacing a field with
 * "[redacted]" would corrupt the value it is about to write to the database.
 *
 * `done` maps each original to its censored copy, and the copy is registered BEFORE its
 * children are walked. That is what makes a cycle come out as a cycle. Remembering only
 * that an object had been visited and returning the original on the second encounter put
 * the uncensored object straight back into the record, so a self-referential run object
 * printed the email address it had just censored one line above.
 */
function censorPii(value: unknown, depth: number, done: WeakMap<object, unknown>): unknown {
  if (typeof value !== 'object' || value === null) return value;

  const already = done.get(value);
  if (already !== undefined) return already;
  if (depth > MAX_CENSOR_DEPTH) return CENSOR;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    done.set(value, copy);
    for (const v of value) copy.push(censorPii(v, depth + 1, done));
    return copy;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const copy: Record<string, unknown> = {};
  done.set(value, copy);
  for (const [key, v] of Object.entries(value)) {
    copy[key] = PII_KEYS.has(key) ? CENSOR : censorPii(v, depth + 1, done);
  }
  return copy;
}

export const logger = pino({
  // Tests run at `warn` so Fastify's per-request info logs stay out of the output.
  level: config.isTest ? 'warn' : config.logLevel,
  redact: { paths: REDACTED_PATHS, censor: CENSOR },
  formatters: {
    log: (record) => censorPii(record, 0, new WeakMap()) as Record<string, unknown>,
  },
  ...(config.isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
