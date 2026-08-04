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
 * Not an evasion measure. `fill()` sets a value in one shot, and React-controlled inputs,
 * autocomplete comboboxes, and rich-text editors routinely ignore that because no key
 * events fire. `pressSequentially` with a small delay is simply the input method those
 * widgets are built to accept. The fixture site's `/nasty` page reproduces the failure.
 */
export const TYPING_DELAY = { min: 40, max: 120 } as const;

export function keyDelay(): number {
  return TYPING_DELAY.min + Math.random() * (TYPING_DELAY.max - TYPING_DELAY.min);
}

export async function openSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  const profileDir = opts.profileDir ?? config.paths.browserProfile;
  await mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless ?? false,
    viewport: { width: 1280, height: 900 },
    // A visible window the user can take over at any moment.
    args: ['--disable-blink-features=AutomationControlled'],
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

const LOGIN_SIGNS = [
  'input[type=password]',
  'input[name*="password" i]',
  'button:has-text("Sign in")',
  'button:has-text("Log in")',
];

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
  // Some application pages legitimately contain an account-creation section.
  const hasPassword = await Promise.all(
    LOGIN_SIGNS.map(async (s) => (await page.locator(s).count()) > 0),
  );
  if (hasPassword.some(Boolean)) {
    const applicationish = await page
      .locator('input[name*="resume" i], input[type=file], textarea')
      .count();
    if (applicationish === 0) {
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
