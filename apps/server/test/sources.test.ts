/**
 * What the source adapters record about a posting's location.
 *
 * This exists because a wrong country is not a cosmetic error here. It reaches the
 * eligibility location rule, it reaches the queue where the user decides whether to apply,
 * and it reaches the privacy export as a fact the tool claims to know. Every parser in
 * this path is supposed to leave a field null rather than guess it; these tests hold that
 * line, because the guess was previously hardcoded in four separate places.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { adzuna, usajobs } from '../src/core/discovery/sources/aggregators';
import { greenhouse, parseLocation } from '../src/core/discovery/sources/ats';
import { decodeEntities, stripHtml } from '../src/core/discovery/sources/types';

describe('parseLocation', () => {
  it('reads city and region without inventing a country', () => {
    expect(parseLocation('New York, NY')).toMatchObject({
      city: 'New York',
      region: 'NY',
      remote: false,
    });
    expect(parseLocation('New York, NY').country).toBeUndefined();
  });

  /**
   * The case the old `'US'` default got wrong. Greenhouse and Lever boards are used by
   * companies all over the world, and a London posting stored as American is a posting the
   * location rule reasons about incorrectly.
   */
  it('does not stamp a non-US location as American', () => {
    expect(parseLocation('London, England').country).toBeUndefined();
    expect(parseLocation('Toronto, ON').country).toBeUndefined();
    expect(parseLocation('Berlin').country).toBeUndefined();
  });

  it('keeps a country the string actually names', () => {
    expect(parseLocation('Toronto, ON, Canada').country).toBe('Canada');
    expect(parseLocation('Austin, TX, US').country).toBe('US');
  });

  /**
   * The three-part branch returned the trailing part as the country verbatim, with no
   * name-check — so "New York, NY, Hybrid" and "Austin, TX, Onsite" (an arrangement or a metro
   * area in the third slot, at least as common on real boards as a spelled-out country) filed
   * "Hybrid" as the country and the privacy export claimed it as a fact. The last part goes
   * through the same name-check the two-part branch uses; when it is not a country, it is
   * dropped, not guessed.
   */
  it('does not read a third part that is not a country as one', () => {
    expect(parseLocation('New York, NY, Hybrid').country).toBeUndefined();
    expect(parseLocation('Austin, TX, Onsite').country).toBeUndefined();
    expect(parseLocation('Brooklyn, New York, NY').country).toBeUndefined();
    expect(parseLocation('New York, NY, Hybrid')).toMatchObject({ city: 'New York', region: 'NY' });
  });

  it('reads remote out of the string and drops the word from the parts', () => {
    const remote = parseLocation('Remote');
    expect(remote.remote).toBe(true);
    expect(remote.city).toBeUndefined();

    // "New York, NY or Remote" is one Greenhouse location string, and both halves matter:
    // the eligibility rule needs the city to tell "offers remote" from "remote only".
    const both = parseLocation('New York, NY or Remote');
    expect(both.remote).toBe(true);
    expect(both.city).toBe('New York');
  });

  /**
   * "OR" is Oregon. The remote-token cleanup trims a dangling conjunction, and trimming
   * both ends at once reduced the part "OR or Remote" to nothing — so a Portland posting
   * recorded a city in no state, and the location rule had nothing to compare against.
   */
  it('does not mistake Oregon for a conjunction', () => {
    expect(parseLocation('Portland, OR')).toMatchObject({ city: 'Portland', region: 'OR' });
    expect(parseLocation('Portland, OR or Remote')).toMatchObject({
      city: 'Portland',
      region: 'OR',
      remote: true,
    });
  });

  it('keeps the geography when a part also says remote', () => {
    expect(parseLocation('Remote (US)')).toMatchObject({ country: 'US', remote: true });
    expect(parseLocation('Berlin, Germany')).toMatchObject({ city: 'Berlin', country: 'Germany' });
  });

  it('trusts an explicit remote flag over the text', () => {
    expect(parseLocation('New York, NY', true).remote).toBe(true);
    expect(parseLocation('Remote', false).remote).toBe(false);
  });
});

/**
 * The note a keyed source leaves when it skips is the only place a user finds out why federal
 * internships, or half the aggregator coverage, were missing from a run. It used to tell them
 * to add the key "in Settings" — a screen with no key field and no mention of either source —
 * so the instruction sent them looking for a box that does not exist and there was no second
 * one to fall back on.
 */
describe('what an unconfigured keyed source tells the user', () => {
  const keys = ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'USAJOBS_API_KEY', 'USAJOBS_USER_AGENT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('names the file the keys are read from, and no screen that cannot hold them', async () => {
    for (const k of keys) delete process.env[k];

    for (const source of [adzuna, usajobs]) {
      const result = await source.fetch({ board: '' });
      const note = result.notes.join(' ');
      expect(result.postings, source.kind).toEqual([]);
      expect(note, source.kind).toMatch(/\.env/);
      expect(note, source.kind).not.toMatch(/in Settings/i);
    }
  });
});

describe('reading a description out of a feed', () => {
  /**
   * What the two helpers do when they are composed in this order. It is a test of
   * `decodeEntities` and `stripHtml`, not of any adapter: the order is written here in the
   * test body, so nothing in `ats.ts` can break it and nothing here would notice if it did.
   * The adapter's own ordering is pinned below.
   */
  it('an escaped document decoded first has no markup left after stripping', () => {
    const escaped =
      '&lt;p&gt;About the role&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;';
    const text = stripHtml(decodeEntities(escaped));
    expect(text).not.toMatch(/<[a-z/]/i);
    expect(text).toMatch(/About the role/);
    expect(text).toMatch(/Python/);
  });

  /**
   * The Greenhouse adapter, driven end to end, because it is the adapter that gets this
   * wrong and the two helper tests could not see it.
   *
   * Greenhouse returns `content` HTML-escaped. Stripping the tags first finds none to strip
   * and `stripHtml`'s own decode step then puts the markup back as literal text — so every
   * requirement parser and the model read "<p>" and "<li>" as part of the job description,
   * and the queue rendered them on screen. Swapping the two calls in `ats.ts` restores that
   * bug with both composition tests above still green.
   */
  it('leaves no markup in the text a Greenhouse posting is stored with', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: 1,
                title: 'Software Engineer Intern',
                absolute_url: 'https://boards.greenhouse.io/ordering/jobs/1',
                content:
                  '&lt;p&gt;About the role&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof globalThis.fetch;

    try {
      // A board token nothing else uses, because the fetcher caches response bodies by URL.
      const { postings } = await greenhouse.fetch({ board: 'ordering-fixture' });
      const text = postings[0]?.descriptionText ?? '';
      expect(text).not.toMatch(/<[a-z/]/i);
      expect(text).toMatch(/About the role/);
      expect(text).toMatch(/Python/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
