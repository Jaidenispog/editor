import { BlockList, isIP } from 'node:net';

/**
 * Address ranges an outbound request from the server must never reach (SSRF guard, design §7.1): private, loopback,
 * link-local, carrier-grade NAT, benchmark, documentation, multicast and reserved ranges, IPv4 and IPv6, including
 * IPv4-mapped IPv6 forms and the IPv6 ranges that embed or translate IPv4 (NAT64, 6to4, Teredo). Server-only (uses `node:net`), so it is imported by path (`@studio/core/address-ranges`) and
 * is not part of the browser-safe index. Used by the worker's crawler and WordPress transport, and by the web app to
 * refuse such addresses when the owner saves them.
 */

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
// IPv6, including every range that embeds or translates an IPv4 address (so a NAT64 gateway, a tunnel or an old
// IPv4-compatible form cannot reach an internal IPv4 address): IPv4-compatible ::/96 (covers :: and ::1),
// IPv4-translated ::ffff:0:0:0/96, NAT64 64:ff9b::/96 and its local-use 64:ff9b:1::/48, Teredo 2001::/32 and 6to4
// 2002::/16. IPv4-mapped ::ffff:0:0/96 is not listed: its IPv4 address is checked against the IPv4 list instead.
for (const [net, prefix] of [
  ['::', 96],
  ['::1', 128],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:10.0.0.1` or `::ffff:a00:1`), else null. */
export function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** True for loopback addresses (127.0.0.0/8, ::1, and their IPv4-mapped forms). */
export function isLoopbackAddress(address: string): boolean {
  const v4 = mappedIpv4(address) ?? address;
  if (isIP(v4) === 4) return v4.startsWith('127.');
  return address === '::1';
}

/** True when an address is in a range the server must never connect to (anything that is not an IP is refused too). */
export function isBlockedAddress(address: string): boolean {
  const mapped = mappedIpv4(address);
  if (mapped) return BLOCKED.check(mapped, 'ipv4');
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return true;
}

/**
 * Why a host name typed by the owner can never be a public website, or null when it may be (DNS is still checked
 * when connecting): an IP literal in a blocked range, `localhost`, a single-label name, or a local-only suffix.
 */
export function privateHostReason(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) return isBlockedAddress(host) ? 'a private or reserved address' : null;
  if (host === 'localhost' || host.endsWith('.localhost')) return 'this computer (localhost)';
  if (!host.includes('.')) return 'a local network name';
  if (/\.(local|internal|lan|home|intranet|corp|private)$/.test(host)) return 'a local network name';
  return null;
}

/** Resolves a host name to its addresses (`dns.lookup` with `all: true`; injectable for tests). */
export type AddressLookup = (host: string) => Promise<Array<{ address: string }>>;

/**
 * Why a host name the owner typed points at an address the server must never reach, after resolving it (every address
 * is checked, as the worker does when it connects), or null. A name that does not resolve (yet), or a lookup slower
 * than `timeoutMs`, gives null: the worker checks the address again, with DNS, before every connection.
 */
export async function resolvedPrivateHostReason(hostname: string, lookup: AddressLookup, timeoutMs = 3000): Promise<string | null> {
  const literal = privateHostReason(hostname);
  if (literal) return literal;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(host),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!addresses) return null;
    return addresses.some((a) => isBlockedAddress(a.address)) ? 'a private or reserved address' : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
