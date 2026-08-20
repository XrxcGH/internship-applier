import { lookup } from 'node:dns/promises';

/**
 * Refusing to fetch the machine this is running on, or anything else on its network.
 *
 * `politeFetch` is handed URLs from three places and a person chose none of them directly:
 * a board API's response, a model's answer to a web search, and a link pasted into the manual
 * box. It parsed each with `new URL()` and fetched whatever came out, so nothing stopped
 * `http://127.0.0.1:8787/api/profile`, a router's admin page at 192.168.1.1, or a NAS on the
 * LAN — and whatever came back was stored as a job posting's description and shown to the
 * student as one. That makes this tool a confused deputy: it holds a position on the user's
 * private network that the URL's author does not.
 *
 * The check is on the RESOLVED address, not on the spelling of the host. A name is a
 * redirection anybody can define, so `internal.example.com` pointing at 127.0.0.1 defeats any
 * amount of string matching — which is the same reason `app.ts` checks the Host header rather
 * than trusting the bind address alone.
 */

/** Every range that is not the public internet, in the form `dns.lookup` hands them back. */
function isPrivateAddress(address: string, family: number): boolean {
  if (family === 6) {
    const v6 = address.toLowerCase();
    // Loopback, unspecified, link-local (fe80::/10), and unique-local (fc00::/7).
    if (v6 === '::1' || v6 === '::') return true;
    if (
      v6.startsWith('fe8') ||
      v6.startsWith('fe9') ||
      v6.startsWith('fea') ||
      v6.startsWith('feb')
    )
      return true;
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
    // An IPv4 address wearing an IPv6 coat, which is how a dual-stack lookup often answers.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    return mapped ? isPrivateAddress(mapped[1]!, 4) : false;
  }

  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // "this network"
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local, and the cloud metadata address
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}

/** What a refusal says, so every caller reports it the same way. */
export class PrivateAddressError extends Error {
  constructor(readonly host: string) {
    super(
      `${host} resolves to an address on this machine or its local network, so it was not ` +
        'fetched. Job postings live on the public internet; a link that points inward is ' +
        'either a mistake or an attempt to make this tool read something on your behalf.',
    );
    this.name = 'PrivateAddressError';
  }
}

/**
 * Throws unless every address the host resolves to is on the public internet.
 *
 * Every address, not the first: a name that resolves to one public address and one loopback
 * address is a rebinding attempt, and picking the first would be a coin toss. A lookup that
 * fails is left alone — the fetch that follows will fail on its own and report the real
 * reason, and refusing here would turn a DNS outage into an accusation.
 */
export async function assertPublicHost(url: string): Promise<void> {
  const host = new URL(url).hostname;
  // A bracketed IPv6 literal keeps its brackets in `hostname`.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(bare, { all: true });
  } catch {
    return;
  }

  if (addresses.some((a) => isPrivateAddress(a.address, a.family))) {
    throw new PrivateAddressError(host);
  }
}

export const forTests = { isPrivateAddress };
