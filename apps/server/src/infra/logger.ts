import { pino } from 'pino';
import { config } from '../config';

/**
 * PII redaction is applied at the logger level, not at call sites, so a new log
 * statement can't accidentally leak a resume field. See docs/10-security-privacy.md.
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
  // Some source URLs carry credentials in the query string (Adzuna app_id/app_key), and
  // both the retry log and HttpError put the URL in the record.
  'url',
  '*.url',
  'err.url',
  'req.headers["x-app-token"]',
  'req.headers.authorization',
  'req.headers.cookie',
];

export const logger = pino({
  // Tests run at `warn` so Fastify's per-request info logs stay out of the output.
  level: config.isTest ? 'warn' : config.logLevel,
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
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
