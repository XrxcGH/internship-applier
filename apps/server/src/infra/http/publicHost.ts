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

/**
 * The address as bytes, or null if it cannot be read as one.
 *
 * THE CLASSIFICATION BELOW WORKS ON THESE BYTES AND NOT ON THE TEXT, and the first version of
 * this file is why. It tested for a v4-mapped address by matching `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/` —
 * the dotted spelling — which is the one spelling that never arrives. `new URL()` re-serialises
 * an IPv6 host into compressed hex and `dns.lookup` returns a literal verbatim, so
 * `http://[::ffff:127.0.0.1]/` reaches the guard as `::ffff:7f00:1`, matches no branch, and was
 * declared public. Loopback, the whole RFC1918 space and the cloud metadata address were all
 * reachable again through the one check meant to stop them: `[::ffff:a9fe:a9fe]` is
 * 169.254.169.254. An address has many spellings and exactly one value; compare the value.
 */
function toBytes(address: string, family: number): Uint8Array | null {
  if (family === 4) return ipv4Bytes(address);

  const text = address.toLowerCase().split('%')[0] ?? ''; // a zone id is not part of the address
  const halves = text.split('::');
  if (halves.length > 2) return null;

  // A v6 address may end in dotted-quad notation; those four bytes go on the end as-is.
  const expand = (part: string): string[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const last = groups[groups.length - 1]!;
    if (!last.includes('.')) return groups;
    const quad = ipv4Bytes(last);
    if (!quad) return null;
    return [
      ...groups.slice(0, -1),
      ((quad[0]! << 8) | quad[1]!).toString(16),
      ((quad[2]! << 8) | quad[3]!).toString(16),
    ];
  };

  const head = expand(halves[0]!);
  const tail = halves.length === 2 ? expand(halves[1]!) : [];
  if (!head || !tail) return null;

  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  const groups = [
    ...head,
    ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'),
    ...tail,
  ];

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function ipv4Bytes(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    // Only plain decimal. `010` and `0x7f` are read as 127 by some resolvers and as 10 or 0 by
    // others, and an address whose value depends on who is reading it is not one to allow.
    if (!/^\d{1,3}$/.test(parts[i]!)) return null;
    const value = Number(parts[i]);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** Every IPv4 range that is not the public internet. */
function isPrivateV4(b: Uint8Array): boolean {
  const [a, second] = [b[0]!, b[1]!];
  return (
    a === 0 || // "this network"
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && second >= 16 && second <= 31) || // private
    (a === 192 && second === 168) || // private
    (a === 169 && second === 254) || // link-local, and the cloud metadata address
    (a === 100 && second >= 64 && second <= 127) || // carrier-grade NAT
    (a === 192 && second === 0) || // IETF protocol assignments, incl. 192.0.0.0/24
    (a === 198 && (second === 18 || second === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/** Every range that is not the public internet, whatever notation it arrived in. */
function isPrivateAddress(address: string, family: number): boolean {
  const bytes = toBytes(address, family);
  // Unreadable means refused. Every other failure mode in this file already errs toward not
  // fetching, and an address this cannot parse is not one whose safety it can vouch for.
  if (!bytes) return true;

  if (bytes.length === 4) return isPrivateV4(bytes);

  // The v4 address inside a v6 one, in each of the forms that carries one. All three deliver
  // packets to the embedded v4 address, so all three have to be judged as that address.
  const startsWith = (...prefix: number[]): boolean => prefix.every((v, i) => bytes[i] === v);
  const embedded = (at: number): Uint8Array => bytes.slice(at, at + 4);

  // ::ffff:0:0/96 mapped, and ::/96 compatible — minus :: and ::1, handled as v6 below.
  if (startsWith(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff)) return isPrivateV4(embedded(12));
  if (startsWith(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) && (bytes[12] ?? 0) !== 0) {
    return isPrivateV4(embedded(12));
  }
  if (startsWith(0x00, 0x64, 0xff, 0x9b)) return isPrivateV4(embedded(12)); // 64:ff9b::/96 NAT64
  if (startsWith(0x20, 0x02)) return isPrivateV4(embedded(2)); // 2002::/16 6to4

  const first = bytes[0]!;
  const second = bytes[1]!;
  if (bytes.every((byte, i) => (i === 15 ? byte <= 1 : byte === 0))) return true; // :: and ::1
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (first === 0xff) return true; // ff00::/8 multicast
  return false;
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
