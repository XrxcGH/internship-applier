/**
 * Mock application site for form-filling tests (docs/07-form-automation.md § Testing).
 *
 * Form automation is NEVER tested against a real employer's form. Doing so would put junk
 * into someone's hiring pipeline and would make the test suite depend on a page we do not
 * control. This server stands in for one.
 *
 * The pages get progressively nastier on purpose:
 *
 *   /simple   the happy path
 *   /redlines every field the filler must refuse to touch
 *   /nasty    the ways real ATS forms defeat naive automation
 *   /wizard   a multi-step form where later fields do not exist until you advance
 *   /login    a sign-in wall, which must pause the run rather than be typed into
 *
 * `/nasty` is the interesting one, and every widget on it mirrors something that actually
 * happens in the wild rather than being difficult for its own sake.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const page = (title: string, body: string, head = ''): string => /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head>
<body>${body}</body></html>`;

const INDEX = page(
  'Fixture ATS',
  /* html */ `
  <h1>Fixture ATS</h1>
  <ul>
    <li><a href="/simple">Simple form</a></li>
    <li><a href="/redlines">Redlined fields</a></li>
    <li><a href="/nasty">Hostile widgets</a></li>
    <li><a href="/wizard">Multi-step wizard</a></li>
    <li><a href="/login">Login wall</a></li>
  </ul>`,
);

const SIMPLE = page(
  'Apply — Fixture',
  /* html */ `
  <form id="apply" method="post" action="/submitted">
    <label for="first">First name</label><input id="first" name="first_name" autocomplete="given-name">
    <label for="last">Last name</label><input id="last" name="last_name" autocomplete="family-name">
    <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email">
    <label for="why">Why do you want this internship?</label>
    <textarea id="why" name="why_this_role" maxlength="1200"></textarea>
    <label for="resume">Resume</label><input id="resume" name="resume" type="file">
    <button type="submit" id="submit-application">Submit application</button>
  </form>`,
);

/** Every field here must be skipped by the filler. Asserted by the redline suite. */
const REDLINES = page(
  'Redlines — Fixture',
  /* html */ `
  <form id="redlines">
    <label for="ssn">Social Security Number</label><input id="ssn" name="ssn">
    <label for="dl">Driver's license number</label><input id="dl" name="drivers_license">
    <label for="passport">Passport number</label><input id="passport" name="passport_no">
    <label for="bank">Bank account number</label><input id="bank" name="bank_account">
    <label for="routing">Routing number</label><input id="routing" name="routing_number">
    <label for="pw">Create a password</label><input id="pw" name="password" type="password">
    <label for="sq">Security question answer</label><input id="sq" name="security_answer">

    <label for="certify"><input id="certify" name="certify" type="checkbox">
      I certify the information above is true and complete</label>
    <label for="sig">Electronic signature (type your full name)</label><input id="sig" name="signature">
    <label for="consent"><input id="consent" name="consent" type="checkbox">
      I authorize a background check</label>
    <label for="tos"><input id="tos" name="tos" type="checkbox">
      I accept the Terms of Service and Privacy Policy</label>
    <label for="marketing"><input id="marketing" name="marketing_optin" type="checkbox">
      Send me news and updates</label>

    <label for="race">Race / ethnicity</label>
    <select id="race" name="eeo_race"><option value="">Select</option><option>Decline to answer</option></select>
    <label for="gender">Gender</label>
    <select id="gender" name="eeo_gender"><option value="">Select</option><option>Decline to answer</option></select>
    <label for="vet">Protected veteran status</label>
    <select id="vet" name="veteran_status"><option value="">Select</option><option>Decline to answer</option></select>
    <label for="dis">Disability status (Form CC-305)</label>
    <select id="dis" name="disability_status"><option value="">Select</option><option>Decline to answer</option></select>

    <label for="salary-history">What was your salary at your last position?</label>
    <input id="salary-history" name="prior_salary">
    <label for="conviction">Have you ever been convicted of a felony?</label>
    <select id="conviction" name="criminal_history"><option value="">Select</option><option>No</option></select>
    <label for="emergency">Emergency contact phone number</label><input id="emergency" name="emergency_contact_phone">

    <label for="ai">Did you use AI to write any part of this application?</label>
    <select id="ai" name="ai_disclosure"><option value="">Select</option><option>Yes</option><option>No</option></select>
  </form>`,
);

/**
 * Widgets that defeat naive automation. Each one is annotated with the real-world thing
 * it stands in for, because a fixture nobody understands stops being maintained.
 */
const NASTY = page(
  'Hostile widgets — Fixture',
  /* html */ `
  <form id="nasty">
    <!-- 1. Label is only reachable via aria-labelledby, not a <label for>. -->
    <span id="lbl-legal-name">Legal first name</span>
    <input aria-labelledby="lbl-legal-name" name="q_9812" id="f-legal-first">

    <!-- 2. No label element at all. The only clue is the placeholder. -->
    <input placeholder="Email address" name="q_4471" id="f-email">

    <!-- 3. Label sits in a preceding sibling div, a very common ATS pattern. -->
    <div class="field"><div class="field__label">Mobile phone</div>
      <input name="q_5533" id="f-phone"></div>

    <!-- 4. Commits only on real key events. Stands in for rich-text editors and
         autocomplete widgets that ignore programmatic value assignment. Setting
         .value directly leaves data-committed empty, which the test asserts. -->
    <label for="f-school">University</label>
    <input id="f-school" name="school" data-committed="">

    <!-- 5. A div-based combobox. There is no <select> to work with. -->
    <label id="lbl-degree">Degree</label>
    <div id="f-degree" role="combobox" aria-labelledby="lbl-degree" aria-expanded="false"
         tabindex="0" data-value="">Select a degree</div>
    <ul id="degree-options" role="listbox" hidden>
      <li role="option" data-value="bachelor">Bachelor's</li>
      <li role="option" data-value="master">Master's</li>
    </ul>

    <!-- 6. Genuinely required, but only marked with an asterisk in the label text. -->
    <label for="f-gpa">GPA *</label><input id="f-gpa" name="gpa">

    <!-- 7. Shadow DOM. The input is not reachable from document.querySelector. -->
    <label id="lbl-portfolio">Portfolio URL</label>
    <div id="f-portfolio-host"></div>

    <!-- 8. An essay field with a character budget the filler must respect. -->
    <label for="f-essay">Tell us about a project you are proud of. (600 characters max)</label>
    <textarea id="f-essay" name="essay_project" maxlength="600"></textarea>

    <!-- 9. A redlined field hiding among ordinary ones, mislabeled to defeat
         semantic classification. Caught by the keyword blocklist instead. -->
    <label for="f-tax">Taxpayer identification number</label><input id="f-tax" name="q_7781">

    <!-- 10. A radio group whose inputs are labelled by the LEGEND, not by their own
         choice text. This is the shape that made every radio in a group resolve to the
         same question, classify identically, and get ticked in turn — the last one
         quietly unticking the rest, so which answer was submitted came down to document
         order. A rich-text essay follows, because a contenteditable box has no type
         attribute for shape detection to read. -->
    <fieldset id="auth-group">
      <legend id="lbl-auth">Are you legally authorized to work in the United States?</legend>
      <label for="f-auth-yes">Yes</label>
      <input type="radio" id="f-auth-yes" name="work_auth_radio" value="yes"
             aria-labelledby="lbl-auth">
      <label for="f-auth-no">No</label>
      <input type="radio" id="f-auth-no" name="work_auth_radio" value="no"
             aria-labelledby="lbl-auth">
    </fieldset>

    <!-- 11. A contenteditable essay field, the way several ATS vendors ship them. -->
    <label id="lbl-why">Why do you want this internship?</label>
    <div id="f-why" contenteditable="true" role="textbox" aria-labelledby="lbl-why"></div>

    <!-- 12. A honeypot and two invisible fields. All three keep a non-zero bounding box,
         so a rect-only visibility test passed them: the honeypot got filled (which is
         exactly how a form decides you are a bot — note the attractive name) and the
         other two each burned the full five-second wait before failing. -->
    <label for="f-website">Website</label>
    <input id="f-website" name="website" style="position:absolute; left:-9999px">
    <label for="f-hidden">Middle name</label>
    <input id="f-hidden" name="middle_name" style="visibility:hidden">
    <label for="f-clear">Referral code</label>
    <input id="f-clear" name="referral" style="opacity:0">

    <!-- 13. Nested iframe carrying more of the form. -->
    <iframe id="extra" src="/framed" title="Additional questions" width="400" height="200"></iframe>

    <button type="submit" id="submit-application">Submit application</button>
  </form>

  <script>
    // (4) Commits only when an input event was preceded by a real keystroke. This is how
    // autocomplete and rich-text widgets actually behave: they listen for key events and
    // ignore a value that simply appeared. Deliberately flag-based rather than timer-based
    // so the behaviour is deterministic for tests.
    const school = document.getElementById('f-school');
    let sawKey = false;
    school.addEventListener('keydown', () => { sawKey = true; });
    school.addEventListener('input', () => {
      if (sawKey) school.setAttribute('data-committed', school.value);
    });

    // (5) Combobox opens on click, commits on option click.
    const combo = document.getElementById('f-degree');
    const list = document.getElementById('degree-options');
    combo.addEventListener('click', () => {
      const open = combo.getAttribute('aria-expanded') === 'true';
      combo.setAttribute('aria-expanded', String(!open));
      list.hidden = open;
    });
    list.querySelectorAll('[role=option]').forEach((opt) => {
      opt.addEventListener('click', () => {
        combo.dataset.value = opt.dataset.value;
        combo.textContent = opt.textContent;
        combo.setAttribute('aria-expanded', 'false');
        list.hidden = true;
      });
    });

    // (7) Shadow DOM input.
    const host = document.getElementById('f-portfolio-host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="shadow-portfolio" name="portfolio" placeholder="https://">';
  </script>`,
);

const FRAMED = page(
  'Additional questions',
  /* html */ `
  <form id="framed">
    <label for="f-start">Earliest start date</label><input id="f-start" name="start_date" type="date">
    <label for="f-auth">Are you legally authorized to work in the United States?</label>
    <select id="f-auth" name="work_auth">
      <option value="">Select</option><option>Yes</option><option>No</option>
    </select>
  </form>`,
);

/** Later fields do not exist in the DOM until the earlier step is completed. */
const WIZARD = page(
  'Multi-step — Fixture',
  /* html */ `
  <!-- The global header every career site has. Its "Sign in" button used to be enough,
       on its own, to make the run stop and report a login wall — and because the same
       detector re-runs on continue, that verdict could never be cleared. -->
  <header><a href="/">Careers</a> <button type="button" id="hdr-signin">Sign in</button></header>
  <form id="wizard">
    <div data-step="1">
      <label for="w-first">First name</label><input id="w-first" name="first_name">
      <button type="button" id="to-step-2">Next</button>
    </div>
    <div data-step="2" hidden></div>
    <div data-step="3" hidden></div>
  </form>
  <script>
    document.getElementById('to-step-2').addEventListener('click', () => {
      const s2 = document.querySelector('[data-step="2"]');
      s2.innerHTML = '<label for="w-email">Email</label><input id="w-email" name="email">' +
        '<button type="button" id="to-step-3">Next</button>';
      s2.hidden = false;
      document.getElementById('to-step-3').addEventListener('click', () => {
        const s3 = document.querySelector('[data-step="3"]');
        s3.innerHTML = '<label for="w-essay">Anything else?</label>' +
          '<textarea id="w-essay" name="anything_else"></textarea>' +
          '<button type="submit" id="submit-application">Submit application</button>';
        s3.hidden = false;
      });
    });
  </script>`,
);

/** A sign-in wall. The filler must pause and hand this to the user, never type into it. */
const LOGIN = page(
  'Sign in — Fixture',
  /* html */ `
  <h1>Sign in to continue your application</h1>
  <form id="login" method="post" action="/simple">
    <label for="l-email">Email</label><input id="l-email" name="email" type="email">
    <label for="l-pw">Password</label><input id="l-pw" name="password" type="password">
    <button type="submit" id="sign-in">Sign in</button>
  </form>`,
);

const ROUTES: Record<string, string> = {
  '/': INDEX,
  '/simple': SIMPLE,
  '/redlines': REDLINES,
  '/nasty': NASTY,
  '/framed': FRAMED,
  '/wizard': WIZARD,
  '/login': LOGIN,
};

export function createFixtureServer() {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';

    // A POST reaching here means something clicked submit. The G4 suite asserts this
    // counter stays at zero for the whole run.
    if (req.method === 'POST') {
      submissions.push(url);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Submitted', '<h1>Submitted</h1>'));
      return;
    }

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

/**
 * Every POST the fixture has received.
 *
 * This is the sharpest possible test of gate G4: not "did we avoid calling click()", but
 * "did a form ever actually get submitted". Asserted empty by the fill suite.
 */
export const submissions: string[] = [];

export function resetSubmissions(): void {
  submissions.length = 0;
}

export interface FixtureServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startFixtureServer(port = 0): Promise<FixtureServer> {
  const server = createFixtureServer();
  return new Promise((resolve) => {
    // Port 0 lets the OS assign a free one, so parallel test files never collide.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        // `server.close()` alone waits for keep-alive sockets to drain, and both `fetch`
        // and Playwright hold them open — so a test suite would hang here instead of
        // finishing. Dropping the sockets first is what makes teardown terminate.
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1]?.endsWith('index.ts')) {
  void startFixtureServer(4310).then(({ url }) => {
    console.log(`fixture ATS listening on ${url}`);
  });
}
