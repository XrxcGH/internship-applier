/**
 * Mock application site for form-filling tests (docs/07-form-automation.md § Testing).
 *
 * Form automation is NEVER tested against a real employer's form. This server stands in
 * for one, and grows in M6 to include: React-controlled inputs, shadow-DOM widgets, an
 * iframe form, a multi-step wizard, a fake login wall, a near-miss combobox, and a page
 * containing every redlined field type.
 *
 * M0 ships the skeleton plus the redline page, since the redline suite is a release gate.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const INDEX = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture ATS</title></head>
<body>
  <h1>Fixture ATS</h1>
  <ul>
    <li><a href="/simple">Simple form</a></li>
    <li><a href="/redlines">Redlined fields</a></li>
  </ul>
</body></html>`;

const SIMPLE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Apply — Fixture</title></head>
<body>
  <form id="apply" method="post" action="/submitted">
    <label for="first">First name</label><input id="first" name="first_name" autocomplete="given-name">
    <label for="last">Last name</label><input id="last" name="last_name" autocomplete="family-name">
    <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email">
    <label for="why">Why do you want this internship?</label>
    <textarea id="why" name="why_this_role" maxlength="1200"></textarea>
    <label for="resume">Resume</label><input id="resume" name="resume" type="file">
    <button type="submit" id="submit-application">Submit application</button>
  </form>
</body></html>`;

/** Every field here must be skipped by the filler. Asserted by the redline suite. */
const REDLINES = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Redlines — Fixture</title></head>
<body>
  <form id="redlines">
    <label for="ssn">Social Security Number</label><input id="ssn" name="ssn">
    <label for="dl">Driver's license number</label><input id="dl" name="drivers_license">
    <label for="bank">Bank account number</label><input id="bank" name="bank_account">
    <label for="pw">Create a password</label><input id="pw" name="password" type="password">
    <label for="certify"><input id="certify" name="certify" type="checkbox">
      I certify the information above is true and complete</label>
    <label for="consent"><input id="consent" name="consent" type="checkbox">
      I authorize a background check</label>
    <label for="race">Race / ethnicity</label>
    <select id="race" name="eeo_race"><option value="">Select</option><option>Decline to answer</option></select>
    <label for="ai">Did you use AI to write any part of this application?</label>
    <select id="ai" name="ai_disclosure"><option value="">Select</option><option>Yes</option><option>No</option></select>
  </form>
</body></html>`;

const ROUTES: Record<string, string> = {
  '/': INDEX,
  '/simple': SIMPLE,
  '/redlines': REDLINES,
};

export function createFixtureServer() {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';
    const body = ROUTES[url];
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
}

export function startFixtureServer(port = 4310): Promise<{ port: number; close: () => void }> {
  const server = createFixtureServer();
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ port, close: () => server.close() });
    });
  });
}

if (process.argv[1]?.endsWith('index.ts')) {
  void startFixtureServer().then(({ port }) => {
    console.log(`fixture ATS listening on http://127.0.0.1:${port}`);
  });
}
