import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF guard for the website crawler (design §7.1). Every host is resolved before connecting; if ANY address is in a
 * private, loopback, link-local, carrier-grade NAT, benchmark, multicast or reserved range, the request is refused.
 * The connection is then made to the validated address only (the fetcher pins it), so DNS rebinding cannot swap it.
 * There is no environment variable that turns this off; tests inject a policy in code.
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
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback addresses (127.0.0.0/8, ::1, and their IPv4-mapped forms). */
export function isLoopbackAddress(address: string): boolean {
  const v4 = mappedIpv4(address) ?? address;
  if (isIP(v4) === 4) return v4.startsWith('127.');
  return address === '::1';
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

/** True when an address is in a range the crawler must never connect to. */
export function isBlockedAddress(address: string): boolean {
  const mapped = mappedIpv4(address);
  if (mapped) return BLOCKED.check(mapped, 'ipv4');
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return true;
}

/** Resolves a host name to every address (injectable for tests). */
export type HostResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

/** The system resolver (`dns.lookup` with `all: true`). */
export const systemResolver: HostResolver = async (host) => dnsLookup(host, { all: true, verbatim: true });

/** Why a host was refused. */
export class BlockedHostError extends Error {
  constructor(
    readonly host: string,
    readonly reason: 'private_address' | 'unresolvable' | 'port',
  ) {
    super(
      reason === 'port'
        ? `${host} uses a port the check never connects to`
        : reason === 'unresolvable'
          ? `${host} could not be found`
          : `${host} points to a private or reserved address, so it was not checked`,
    );
    this.name = 'BlockedHostError';
  }
}

/** What the guard may allow. `allowLoopback` exists only for tests with a local fixture server. */
export interface GuardPolicy {
  allowLoopback: boolean;
}

/**
 * Resolves `host` and returns the address to connect to (the first one), refusing the host when any of its addresses
 * is blocked. An IP literal is checked directly.
 */
export async function resolveSafeAddress(host: string, policy: GuardPolicy, resolver: HostResolver = systemResolver): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(bare)) addresses = [{ address: bare, family: isIP(bare) }];
  else {
    try {
      addresses = await resolver(bare);
    } catch {
      throw new BlockedHostError(host, 'unresolvable');
    }
  }
  if (addresses.length === 0) throw new BlockedHostError(host, 'unresolvable');
  for (const a of addresses) {
    if (policy.allowLoopback && isLoopbackAddress(a.address)) continue;
    if (isBlockedAddress(a.address)) throw new BlockedHostError(host, 'private_address');
  }
  const first = addresses[0];
  if (!first) throw new BlockedHostError(host, 'unresolvable');
  return first;
}
