/**
 * Reminders and follow-up drafts — docs/11 § M7.
 *
 * NOTHING HERE SENDS ANYTHING. A follow-up is drafted, shown, and left in the user's hands
 * exactly the way an application answer is. This is the same line as gate G4: an email
 * going out under someone's name is theirs to send.
 *
 * It also means no mail credentials, no SMTP configuration, and no outbox — the drafts are
 * text the user copies. That is a deliberate feature rather than an unfinished piece.
 */
import type { TrackedApplication } from './status';
import { derive, GHOST_AFTER_DAYS } from './status';

export type ReminderKind = 'deadline' | 'follow_up' | 'still_open' | 'stale_offer';

export interface Reminder {
  applicationId: string;
  kind: ReminderKind;
  /** Lower sorts first. */
  urgency: number;
  headline: string;
  detail: string;
}

/** Days after submitting before a follow-up is reasonable rather than pushy. */
export const FOLLOW_UP_AFTER_DAYS = 14;

export function buildReminders(apps: TrackedApplication[], now = new Date()): Reminder[] {
  const out: Reminder[] = [];

  for (const app of apps) {
    const d = derive(app, now);

    if (d.attention === 'deadline_passed') {
      out.push({
        applicationId: app.id,
        kind: 'deadline',
        urgency: 0,
        headline: `${app.company} closed without being submitted`,
        detail:
          d.nudge ??
          'The posting closed while this was still in progress. Worth withdrawing it to clear the board.',
      });
      continue;
    }

    if (d.attention === 'deadline_soon') {
      out.push({
        applicationId: app.id,
        kind: 'deadline',
        urgency: 1,
        headline: `${app.company} closes soon`,
        detail: `${d.nudge ?? ''} ${app.title}`.trim(),
      });
      continue;
    }

    if (d.attention === 'awaiting_your_submit') {
      out.push({
        applicationId: app.id,
        kind: 'still_open',
        urgency: 2,
        headline: `${app.company} is filled and waiting for you`,
        detail: 'The form is ready. Read it on the real page and submit it yourself.',
      });
      continue;
    }

    // A follow-up becomes reasonable at two weeks and stops being useful once silence has
    // run long enough to mean no.
    if (
      app.status === 'submitted' &&
      d.daysSinceSubmitted !== null &&
      d.daysSinceSubmitted >= FOLLOW_UP_AFTER_DAYS &&
      d.daysSinceSubmitted < GHOST_AFTER_DAYS
    ) {
      out.push({
        applicationId: app.id,
        kind: 'follow_up',
        urgency: 3,
        headline: `${String(d.daysSinceSubmitted)} days since you applied to ${app.company}`,
        detail: 'Long enough that a short follow-up is reasonable. A draft is below.',
      });
    }
  }

  return out.sort((a, b) => a.urgency - b.urgency);
}

/**
 * A follow-up email, as text for the user to send themselves.
 *
 * Written short and plain on purpose. A long follow-up reads as anxious, and every
 * flourish is another thing the recipient did not ask for. No em dashes, no "I wanted to
 * reach out", no "circling back" — the same vocabulary the tell-scrub blocks in answers.
 */
export function draftFollowUp(app: TrackedApplication, now = new Date()): string {
  const d = derive(app, now);
  const days = d.daysSinceSubmitted ?? 0;
  const when = days >= 21 ? 'a few weeks ago' : 'two weeks ago';

  return [
    `Subject: Following up on my ${app.title} application`,
    '',
    'Hello,',
    '',
    `I applied for the ${app.title} role ${when} and wanted to check whether the position is still open.`,
    '',
    'I am still very interested, and happy to send anything else that would be useful.',
    '',
    'Thank you for your time.',
  ].join('\n');
}

/** A short note for a withdrawal, when the user has taken something else. */
export function draftWithdrawal(app: TrackedApplication): string {
  return [
    `Subject: Withdrawing my ${app.title} application`,
    '',
    'Hello,',
    '',
    `I am writing to withdraw my application for the ${app.title} role. I have accepted another offer.`,
    '',
    'Thank you for considering me.',
  ].join('\n');
}
