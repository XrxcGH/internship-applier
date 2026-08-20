import { describe, expect, it } from 'vitest';
import { readPastedPosting } from '../src/core/discovery/manualPosting';

/**
 * The path for postings on sites this tool will not fetch — Handshake above all.
 *
 * Handshake, LinkedIn and Indeed prohibit automated access, and Handshake sits behind a
 * university login besides, where a ban costs the student their careers office rather than a
 * website signup. So the tool does not fetch them. What it does instead is take the text from
 * the student, who is entitled to read their own account, and run it through the same parsers
 * every other posting goes through. The properties held here are the ones that make that
 * trade honest: the URL is stored and never fetched, nothing is invented to fill a gap, and
 * the notes say plainly where the facts came from.
 */

const HANDSHAKE = 'https://app.joinhandshake.com/jobs/9876543';

function pasted(over: Partial<Parameters<typeof readPastedPosting>[0]> = {}) {
  return readPastedPosting({
    title: 'Software Engineering Intern',
    company: 'Acme Robotics',
    url: HANDSHAKE,
    text:
      'Acme Robotics is hiring a Summer 2027 software engineering intern in Los Angeles, CA. ' +
      'This is a paid 12-week internship at $45/hour. You must be currently enrolled in a ' +
      "Bachelor's program in Computer Science or a related field. Experience with Python and " +
      'C++ is required. Hybrid, 3 days a week onsite.',
    ...over,
  });
}

describe('readPastedPosting', () => {
  it('reads the same facts out of pasted text that a fetched page would give', () => {
    // The whole justification for this path: everything downstream of discovery only ever
    // worked on a title and a body of text, so pasted text loses nothing but the fetch.
    const { posting } = pasted();
    expect(posting.title).toBe('Software Engineering Intern');
    expect(posting.company).toBe('Acme Robotics');
    expect(posting.positionType).toBe('internship');
    expect(posting.term.year).toBe(2027);
    expect(posting.term.season).toBe('summer');
    expect(posting.compensation).toMatchObject({ min: 45, period: 'hour' });
    expect(posting.workArrangement).toBe('hybrid');
    expect(posting.hybridDaysOnsite).toBe(3);
  });

  it('extracts requirements, which is what the eligibility gate runs on', () => {
    const { posting } = pasted();
    expect(Object.keys(posting.requires).length).toBeGreaterThan(0);
  });

  it('stores the address as identity and as the way back, without fetching it', () => {
    // Storing an address is not visiting one. A Handshake URL is copyable out of the address
    // bar even though the page behind it refuses us, and dedupe keys on it.
    const { posting } = pasted();
    expect(posting.applyUrl).toBe(HANDSHAKE);
    expect(posting.canonicalUrl).toContain('joinhandshake.com');
  });

  it('never claims structured data it did not have', () => {
    // `usedJsonLd` drives a sentence in the UI about where the facts came from. Pasted text
    // has no structured job data by definition, and saying otherwise would put a confident
    // provenance on a posting the student typed in themselves.
    const { usedJsonLd, notes } = pasted();
    expect(usedJsonLd).toBe(false);
    expect(notes.join(' ')).toMatch(/pasted in by you/i);
  });

  it('says where it was read when the student said', () => {
    const { notes } = pasted({ readOn: 'Handshake' });
    expect(notes.join(' ')).toMatch(/Read from Handshake/);
  });

  it('warns when the paste is too short to have requirements in it', () => {
    // A partial paste sails through as a posting that "states no requirements", which reads
    // downstream as a role with nothing to check rather than one nobody checked.
    const { notes } = pasted({ text: 'Summer 2027 intern. Apply on our site. Los Angeles.' });
    expect(notes.join(' ')).toMatch(/very little text/i);
  });

  it('invents nothing to fill a silence', () => {
    // Every one of these is a field a fetched page can supply and pasted text cannot. A
    // guess here would be a fact the student never gave, wearing the same UI as one they did.
    const { posting } = pasted({ text: 'A'.repeat(300) });
    expect(posting.postedAt).toBeNull();
    expect(posting.closesAt).toBeNull();
    expect(posting.descriptionHtml).toBeNull();
    expect(posting.externalId).toBeNull();
    expect(posting.atsVendor).toBe('unknown');
    expect(posting.remoteEligibleIn).toEqual([]);
  });

  it('records a remote posting as remote without naming a city it was not given', () => {
    const { posting } = pasted({
      text:
        'This is a fully remote internship for Summer 2027. Work from anywhere in the United ' +
        'States. Paid at $30 per hour. Must be enrolled in a degree program. Python required.',
    });
    expect(posting.workArrangement).toBe('remote');
    expect(posting.locations).toEqual([{ remote: true }]);
  });

  it('leaves locations empty rather than guessing one for an on-site role', () => {
    // parseLocation needs a stated place. The student can correct a location at G2; a city
    // inferred out of prose and shown as the posting's own would be harder to notice.
    const { posting } = pasted({ text: 'On-site internship. ' + 'A'.repeat(300) });
    expect(posting.locations).toEqual([]);
  });
});
