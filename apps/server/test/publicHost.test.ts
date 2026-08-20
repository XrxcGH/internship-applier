import { describe, expect, it } from 'vitest';
import { assertPublicHost, forTests, PrivateAddressError } from '../src/infra/http/publicHost';

const { isPrivateAddress } = forTests;

/**
 * Which addresses this tool will fetch from.
 *
 * `politeFetch` is handed URLs from three places and a person chose none of them directly: a
 * board API's response, a model's answer to a web search, and a link pasted into the manual
 * box. It fetched whatever `new URL()` accepted, so nothing stopped `http://127.0.0.1:8787`,
 * a router's admin page, or a NAS on the LAN — and what came back was stored as a job
 * posting's description and shown to the student as one. A tool that will read an address on
 * your private network because a stranger's page named it is a confused deputy.
 *
 * The range logic is exercised here directly, because `politeFetch` skips the check under
 * test — the fetcher suite runs against local servers on 127.0.0.1, which is the only honest
 * way to test an HTTP client. The decision is covered even where the call site is not.
 */
describe('which addresses count as private', () => {
  it('refuses this machine', () => {
    expect(isPrivateAddress('127.0.0.1', 4)).toBe(true);
    expect(isPrivateAddress('127.1.2.3', 4)).toBe(true);
    expect(isPrivateAddress('::1', 6)).toBe(true);
    expect(isPrivateAddress('0.0.0.0', 4)).toBe(true);
  });

  it('refuses the private ranges', () => {
    for (const a of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
      expect(isPrivateAddress(a, 4), a).toBe(true);
    }
    // Unique-local and link-local IPv6.
    expect(isPrivateAddress('fd00::1', 6)).toBe(true);
    expect(isPrivateAddress('fe80::1', 6)).toBe(true);
  });

  it('refuses link-local, which is where a cloud metadata service lives', () => {
    expect(isPrivateAddress('169.254.169.254', 4)).toBe(true);
  });

  it('refuses carrier-grade NAT and multicast', () => {
    expect(isPrivateAddress('100.64.0.1', 4)).toBe(true);
    expect(isPrivateAddress('224.0.0.1', 4)).toBe(true);
  });

  it('sees through an IPv4 address wearing an IPv6 coat', () => {
    // How a dual-stack lookup routinely answers, and the shape a range check written for
    // dotted quads alone walks straight past.
    expect(isPrivateAddress('::ffff:127.0.0.1', 6)).toBe(true);
    expect(isPrivateAddress('::ffff:192.168.0.5', 6)).toBe(true);
    expect(isPrivateAddress('::ffff:93.184.216.34', 6)).toBe(false);
  });

  it('allows the public internet, which is where job postings live', () => {
    for (const a of ['93.184.216.34', '13.107.42.14', '172.32.0.1', '192.169.0.1', '11.0.0.1']) {
      expect(isPrivateAddress(a, 4), a).toBe(false);
    }
    expect(isPrivateAddress('2606:2800:220:1:248:1893:25c8:1946', 6)).toBe(false);
  });

  it('treats something it cannot parse as private', () => {
    // The safe direction: an address this cannot read is one it cannot vouch for.
    expect(isPrivateAddress('not-an-address', 4)).toBe(true);
    expect(isPrivateAddress('1.2.3', 4)).toBe(true);
  });
});

describe('assertPublicHost', () => {
  it('refuses a literal loopback address', async () => {
    await expect(assertPublicHost('http://127.0.0.1:8787/api/profile')).rejects.toBeInstanceOf(
      PrivateAddressError,
    );
  });

  it('refuses localhost, whatever it is spelled as', async () => {
    // Resolved rather than string-matched: a name is a redirection anybody can define, so
    // matching on the spelling is defeated by `internal.example.com` pointing at 127.0.0.1.
    await expect(assertPublicHost('http://localhost:3000/')).rejects.toBeInstanceOf(
      PrivateAddressError,
    );
  });

  it('refuses a bracketed IPv6 loopback', async () => {
    await expect(assertPublicHost('http://[::1]:8787/')).rejects.toBeInstanceOf(
      PrivateAddressError,
    );
  });

  it('refuses a private LAN address', async () => {
    await expect(assertPublicHost('http://192.168.1.1/admin')).rejects.toBeInstanceOf(
      PrivateAddressError,
    );
  });

  it('says what happened in the student’s terms, not in an error code', async () => {
    const err = await assertPublicHost('http://127.0.0.1/x').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(PrivateAddressError);
    expect(err?.message).toMatch(/local network/i);
    expect(err?.message).toMatch(/public internet/i);
  });

  it('lets a name it cannot resolve through, rather than accusing it', async () => {
    // A DNS outage is not an attack, and turning one into a refusal would make every fetch
    // fail with the wrong reason. The fetch that follows reports the real one.
    await expect(
      assertPublicHost('http://this-name-does-not-resolve.invalid/'),
    ).resolves.toBeUndefined();
  });
});
