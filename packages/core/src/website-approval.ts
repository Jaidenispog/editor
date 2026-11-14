import { createHash } from 'node:crypto';
import type { WebsiteChange } from './website.js';

/**
 * Binding a website change to what the owner confirmed (design §4.4, §7.4.1). Server-only (uses `node:crypto`), so it
 * is imported by path (`@studio/core/website-approval`) and is not part of the browser-safe index: by the web app when
 * it records an approval, and by the worker before it writes.
 */

/** Where an approved change will be written, as the confirmation dialog showed it. */
export interface ApprovalDestination {
  /** The saved WordPress address (`config.baseUrl`). */
  baseUrl: string;
  /** The label the dialog showed: `staging` only when the connection check said so, else `live`. */
  environment: 'live' | 'staging';
}

/** The destination of the website connection row (the same rule the web app uses for the dialog). */
export function approvalDestination(conn: { config: Record<string, unknown>; capabilities: Record<string, unknown> } | null | undefined): ApprovalDestination | null {
  const baseUrl = conn?.config['baseUrl'];
  if (typeof baseUrl !== 'string' || !baseUrl) return null;
  return { baseUrl, environment: conn?.capabilities['environment'] === 'staging' ? 'staging' : 'live' };
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** The parts of a change that decide what is written where (fixed order, so the hash is stable). */
function changeParts(change: WebsiteChange): unknown[] {
  return [change.kind, change.pageUrl, 'before' in change ? change.before : null, change.after, change.kind === 'image_alt_text' ? change.imageSrc : null];
}

/** SHA-256 (hex) of a change's kind, page, before, after and image: the change a write marker belongs to. */
export function changeHash(change: WebsiteChange): string {
  return sha256(JSON.stringify(['change/v1', ...changeParts(change)]));
}

/** SHA-256 (hex) of a change together with its destination: what an owner's approval covers. */
export function approvalHash(change: WebsiteChange, destination: ApprovalDestination): string {
  return sha256(JSON.stringify(['approval/v1', ...changeParts(change), destination.baseUrl, destination.environment]));
}
