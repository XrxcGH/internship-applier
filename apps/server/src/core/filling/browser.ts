/**
 * Browser lifecycle — docs/07-form-automation.md § Browser.
 *
 * HEADED BY DEFAULT, and that is a product decision rather than a technical one. The user
 * watches the form being filled, on the real page, and is the one who submits it. A
 * headless run would take the human out of a loop the whole design depends on. Headless is
 * used only against the local fixture site in tests.
 *
 * PERSISTENT CONTEXT. Many ATS platforms require an account. `launchPersistentContext`
 * against data/browser-profile/ means the user signs in once per vendor and the session
 * survives restarts. No password is ever stored by this app: the profile directory belongs
 * to Chromium, and `credential_ref` holds a path, never a secret.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No fingerprint spoofing, no proxy rotation, no
 * user-agent forgery, no timing models tuned against bot detection. The browser identifies
 * as exactly what it is: Chromium, driven by automation, on the user's own machine. If a
 * site does not want that, the correct response is to stop and hand control back, which is
 * what `awaiting_user` exists for.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { config } from '../../config';
import { logger } from '../../infra/logger';

export interface SessionOptions {
  /** Headless is for the fixture site only. */
  headless?: boolean;
  /** Override the profile directory. Tests use a throwaway one. */
  profileDir?: string;
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Typing cadence, in milliseconds between keystrokes.
 *
 * Not an evasion measure, and the number is smaller than docs/07 originally specified
 * for a reason worth recording. What makes hostile widgets work is that real key events
 * fire at all — `fill()` assigns a value without them, and React-controlled inputs,
 * autocomplete comboboxes, and rich-text editors ignore that entirely. The PACING is only
 * there so a debouncing widget has time to keep up.
 *
 * The original 40-120ms was a guess, and measuring it showed the cost: the fill suite
 * spent 76 seconds almost entirely on sleeps between keystrokes. This range keeps enough
 * slack for a debounce while being four times cheaper, and the fixture's commit-on-key
 * widget still passes, which is the property that actually matters.
 */
export const TYPING_DELAY = { min: 10, max: 30 } as const;

export function keyDelay(): number {
  return TYPING_DELAY.min + Math.random() * (TYPING_DELAY.max - TYPING_DELAY.min);
}

export async function openSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  const profileDir = opts.profileDir ?? config.paths.browserProfile;
  await mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless ?? false,
    viewport: { width: 1280, height: 900 },
    // No `--disable-blink-features=AutomationControlled`. That flag's only purpose is to
    // hide `navigator.webdriver` from bot detection, which is exactly the evasion this
    // file's header and docs/07 promise not to do. It was here, and it made those
    // promises false. The browser identifies as automated because it is.
  });

  const page = context.pages()[0] ?? (await context.newPage());

  logger.info({ headless: opts.headless ?? false, profileDir }, 'browser session opened');

  return {
    context,
    page,
    close: async () => {
      await context.close().catch(() => undefined);
    },
  };
}

/**
 * Signals that the run must stop and hand control to the person.
 *
 * Login walls and bot checks are not obstacles to be worked around. The tool pauses, says
 * what it found, and waits. There is no solver, no bypass, and no third-party service.
 */
export type InterventionReason = 'login' | 'captcha' | 'unknown_field';

export interface Intervention {
  reason: InterventionReason;
  detail: string;
}

/**
 * A login wall means a PASSWORD FIELD. Nothing else is sufficient on its own.
 *
 * Sign-in button text used to sit in this list and any one of the four was enough to
 * trigger the verdict — and Playwright's has-text is a case-insensitive substring match,
 * so the sign-in link in a career site's global header stopped the run. Because the same
 * detector runs again on continue, that verdict could never be cleared: the run sat in
 * awaiting_user permanently, on a page that had no login wall at all.
 */
const PASSWORD_FIELDS = ['input[type=password]', 'input[name*="password" i]'];

const BOT_CHECK_SIGNS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="challenge" i]',
  '[class*="cf-turnstile"]',
  '#challenge-running',
];

/**
 * Looks for a reason to stop before touching anything.
 *
 * Checked before filling rather than after a failure, because typing a name into what
 * turns out to be a login form is exactly the mistake worth preventing.
 */
export async function detectIntervention(page: Page): Promise<Intervention | null> {
  for (const sel of BOT_CHECK_SIGNS) {
    if ((await page.locator(sel).count()) > 0) {
      return {
        reason: 'captcha',
        detail:
          'This page is running a bot check. Complete it yourself in the browser window, ' +
          'then continue. This tool does not solve or bypass these.',
      };
    }
  }

  // A password field is only a login wall if there is no application form around it.
  // Plenty of application pages carry an optional account-creation section.
  const passwords = await Promise.all(
    PASSWORD_FIELDS.map(async (s) => (await page.locator(s).count()) > 0),
  );
  if (passwords.some(Boolean)) {
    /**
     * What tells an application form apart from a sign-in box.
     *
     * Requiring a resume field or a textarea was too narrow — a first wizard step of
     * plain name/email/phone inputs is an application form and was not rescued. But
     * "any control at all" is too wide in the other direction, because a login box has an
     * email field. A sign-in form is two controls; an application form asks for more than
     * that even at its shortest.
     */
    const [uploads, essays, plain] = await Promise.all([
      page.locator('input[type=file]').count(),
      page.locator('textarea, [contenteditable=true]').count(),
      page
        .locator(
          'input:not([type=password]):not([type=hidden]):not([type=submit])' +
            ':not([type=button]):not([type=checkbox]), select',
        )
        .count(),
    ]);
    const applicationish = uploads > 0 || essays > 0 || plain >= 3;
    if (!applicationish) {
      return {
        reason: 'login',
        detail:
          'This site needs you signed in before it will show the application. Sign in ' +
          'yourself in the browser window that is open, then continue. This tool never ' +
          'types into a password field.',
      };
    }
  }

  return null;
}
