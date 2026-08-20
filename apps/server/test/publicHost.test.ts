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

  it('sees through an IPv4 address wearing an IPv6 coat, in every spelling of it', () => {
    // The dotted form is the one this test used to check, and the one that never arrives.
    // `new URL()` re-serialises an IPv6 host into compressed hex and `dns.lookup` returns a
    // literal verbatim, so `http://[::ffff:127.0.0.1]/` reaches the guard as `::ffff:7f00:1`.
    // The first version of this file matched on the dotted text, called every one of these
    // public, and handed loopback, the whole RFC1918 space and the cloud metadata address
    // back to an attacker through the single check meant to stop them.
    expect(new URL('http://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');

    for (const spelling of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::FFFF:7F00:1',
      '0:0:0:0:0:ffff:7f00:0001',
      '::127.0.0.1', // v4-compatible
      '64:ff9b::7f00:1', // NAT64
      '2002:7f00:1::', // 6to4
    ]) {
      expect(isPrivateAddress(spelling, 6), spelling).toBe(true);
    }

    expect(isPrivateAddress('::ffff:a9fe:a9fe', 6)).toBe(true); // 169.254.169.254
    expect(isPrivateAddress('::ffff:c0a8:101', 6)).toBe(true); // 192.168.1.1

    // A public address wrapped the same way is still public, or the guard would block the
    // dual-stack answer for an ordinary careers page.
    expect(isPrivateAddress('::ffff:93.184.216.34', 6)).toBe(false);
    expect(isPrivateAddress('::ffff:808:808', 6)).toBe(false); // 8.8.8.8
    expect(isPrivateAddress('2002:0808:0808::', 6)).toBe(false);
  });

  it('reads a v4 address by value, not by however it was written', () => {
    // A resolver may read a leading zero as octal and a `0x` as hex; another reads both as
    // decimal. `010.0.0.1` is 8.0.0.1 to one and 10.0.0.1 to the other. An address whose
    // value depends on who is looking at it is refused rather than guessed at.
    for (const spelling of ['010.0.0.1', '0x7f.0.0.1', '127.1', '2130706433', '1.2.3.4.5']) {
      expect(isPrivateAddress(spelling, 4), spelling).toBe(true);
    }
  });

  it('refuses a zone-qualified link-local address', () => {
    expect(isPrivateAddress('fe80::1%eth0', 6)).toBe(true);
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
