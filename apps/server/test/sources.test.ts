/**
 * What the source adapters record about a posting's location.
 *
 * This exists because a wrong country is not a cosmetic error here. It reaches the
 * eligibility location rule, it reaches the queue where the user decides whether to apply,
 * and it reaches the privacy export as a fact the tool claims to know. Every parser in
 * this path is supposed to leave a field null rather than guess it; these tests hold that
 * line, because the guess was previously hardcoded in four separate places.
 */
import { describe, expect, it } from 'vitest';
import { parseLocation } from '../src/core/discovery/sources/ats';
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

  it('trusts an explicit remote flag over the text', () => {
    expect(parseLocation('New York, NY', true).remote).toBe(true);
    expect(parseLocation('Remote', false).remote).toBe(false);
  });
});

describe('reading a description out of a feed', () => {
  /**
   * Greenhouse returns its content HTML-escaped. Stripping tags first finds none to strip,
   * and the decode step then reintroduces the markup as visible text — which is what every
   * requirement parser and the model would go on to read.
   */
  it('decodes before stripping, so no markup survives into the text', () => {
    const escaped =
      '&lt;p&gt;About the role&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;';
    const text = stripHtml(decodeEntities(escaped));
    expect(text).not.toMatch(/<[a-z/]/i);
    expect(text).toMatch(/About the role/);
    expect(text).toMatch(/Python/);
  });
});
