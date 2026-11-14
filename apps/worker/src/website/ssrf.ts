import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBlockedAddress, isLoopbackAddress } from '@studio/core/address-ranges';

/**
 * SSRF guard for the website crawler (design §7.1). Every host is resolved before connecting; if ANY address is in a
 * private, loopback, link-local, carrier-grade NAT, benchmark, multicast or reserved range, the request is refused.
 * The connection is then made to the validated address only (the fetcher pins it), so DNS rebinding cannot swap it.
 * There is no environment variable that turns this off; tests inject a policy in code.
 */

// The ranges live in @studio/core/address-ranges, shared with the web app (which refuses them when the owner saves an
// address); re-exported here for the worker's callers.
export { isBlockedAddress, isLoopbackAddress, mappedIpv4 } from '@studio/core/address-ranges';

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
