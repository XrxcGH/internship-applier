/**
 * Proves the browser toolchain actually works on this machine, against the fixture site
 * and never against a real employer's form.
 *
 * These are slow by the standards of the rest of the suite (a real Chromium launches), so
 * they are deliberately few: enough to know Playwright, the persistent context, the
 * fixture, and the intervention detector are all wired correctly. The behavioural fill
 * tests build on this.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, submissions, type FixtureServer } from '@ia/fixtures';
import { detectIntervention, openSession, type BrowserSession } from '../src/core/filling/browser';
import { removeTempDir } from './support/tempDir';

let fixture: FixtureServer;
let session: BrowserSession;
let profileDir: string;

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  profileDir = mkdtempSync(path.join(tmpdir(), 'ia-browser-'));
  session = await openSession({ headless: true, profileDir });
}, 120_000);

afterAll(async () => {
  await session?.close();
  await fixture?.close();
  removeTempDir(profileDir);
});

describe('browser session', () => {
  it('opens the fixture and reads its fields', async () => {
    await session.page.goto(`${fixture.url}/simple`);
    expect(await session.page.locator('#first').count()).toBe(1);
    expect(await session.page.locator('#apply input, #apply textarea').count()).toBe(5);
  }, 60_000);

  it('reaches fields inside an iframe', async () => {
    await session.page.goto(`${fixture.url}/nasty`);
    const frame = session.page.frameLocator('#extra');
    expect(await frame.locator('#f-start').count()).toBe(1);
  }, 60_000);

  it('reaches a field inside shadow DOM', async () => {
    await session.page.goto(`${fixture.url}/nasty`);
    // Playwright pierces open shadow roots, which is why the fixture uses mode: 'open'.
    expect(await session.page.locator('#shadow-portfolio').count()).toBe(1);
  }, 60_000);
});

describe('typing widgets that ignore programmatic values', () => {
  it('shows why fill() is not enough', async () => {
    await session.page.goto(`${fixture.url}/nasty`);
    const school = session.page.locator('#f-school');

    // fill() sets the value in one shot. The widget commits only on a key event, so its
    // model stays empty — the exact failure real autocomplete and rich-text fields show.
    await school.fill('Rutgers University');
    expect(await school.inputValue()).toBe('Rutgers University');
    expect(await school.getAttribute('data-committed')).toBe('');

    // Real keystrokes commit it.
    await school.fill('');
    await school.pressSequentially('Rutgers University', { delay: 5 });
    expect(await school.getAttribute('data-committed')).toBe('Rutgers University');
  }, 60_000);
});

describe('stopping instead of working around', () => {
  it('recognises a login wall', async () => {
    await session.page.goto(`${fixture.url}/login`);
    const found = await detectIntervention(session.page);
    expect(found?.reason).toBe('login');
    expect(found?.detail).toContain('never types into a password field');
  }, 60_000);

  it('does not cry login on an ordinary application page', async () => {
    await session.page.goto(`${fixture.url}/simple`);
    expect(await detectIntervention(session.page)).toBeNull();
  }, 60_000);

  /**
   * A "Sign in" button in the global header is on practically every career site, and it
   * used to be sufficient on its own — Playwright's has-text is a case-insensitive
   * substring match. Worse, the same detector runs again on continue, so the run sat in
   * awaiting_user forever on a page with no login wall at all. A password field is now
   * required, and button text is not evidence of anything.
   */
  it('is not fooled by a sign-in button in the page header', async () => {
    await session.page.goto(`${fixture.url}/wizard`);
    expect(await session.page.locator('#hdr-signin').count()).toBe(1);
    expect(await detectIntervention(session.page)).toBeNull();
  }, 60_000);
});

describe('gate G4', () => {
  it('nothing in this suite has submitted a form', () => {
    // The fixture records every POST it receives. This is a stronger check than grepping
    // for .click(): it asserts no form was actually submitted, however it happened.
    expect(submissions).toEqual([]);
  });
});
