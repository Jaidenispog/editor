import type { ApplyOutcome, WebsiteChange, WebsiteChangeKind } from '@studio/core';

/**
 * A website editing adapter (design §7.4.1): code that applies an owner-approved change through an authorised
 * connection. Only WordPress exists today; other builders get copy-paste steps.
 */

/** The outcome of an adapter's read-only check. */
export interface AdapterCheck {
  ok: boolean;
  /** The user the connection acts as (e.g. `studio-assistant`). */
  identity: string | null;
  roles: string[];
  capabilities: Record<string, boolean>;
  /** `staging` when the site's host differs from the public website's host. */
  environment: 'live' | 'staging';
  supportedKinds: WebsiteChangeKind[];
  /** Plain-language problem, or null. */
  problem: string | null;
  /** A problem that needs new credentials (401), rather than a setting on the site. */
  needsReauth: boolean;
  /** Soft advice (for example "use a separate Editor user"). */
  note: string | null;
}

/** Where a change lives in the site's own content. */
export interface LocatedTarget {
  resourceType: 'page' | 'post';
  resourceId: string;
  link: string;
  /** The stored (raw) content of the page or post. */
  current: string;
  /** WordPress's `modified_gmt` when it was located (null when not given), compared again right before a write. */
  modifiedGmt: string | null;
}

/** An adapter. `check`, `locate` and `readBack` are read-only; only `write` changes anything, and only after approval. */
export interface WebsiteEditAdapter {
  readonly id: 'wordpress';
  check(signal: AbortSignal): Promise<AdapterCheck>;
  supports(change: WebsiteChange): { ok: true } | { ok: false; reason: string };
  locate(change: WebsiteChange, signal: AbortSignal): Promise<LocatedTarget | null>;
  write(target: LocatedTarget, nextContent: string, signal: AbortSignal): Promise<{ outcome: ApplyOutcome; message: string }>;
  readBack(target: LocatedTarget, signal: AbortSignal): Promise<string>;
  /** Reads the located item again (read-only), right before a write: its content and `modified_gmt`, or null if gone. */
  recheck(target: LocatedTarget, signal: AbortSignal): Promise<{ current: string; modifiedGmt: string | null } | null>;
}

/** A failure another attempt may fix (network, 5xx, 409/412): the job retries; the already-applied rule keeps it safe. */
export class TransientAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientAdapterError';
  }
}
