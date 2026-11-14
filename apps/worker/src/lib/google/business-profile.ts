import { starRatingToNumber } from '@studio/core';
import type { WorkerContext } from '../../context.js';
import { httpRequest, readJson } from '../http.js';

/**
 * Google Business Profile APIs, read-only (email design §8.3; memo §7 Tier 2): location discovery (Account Management
 * and Business Information v1) and the v4 `reviews.list` (page size 50). Scope `business.manage` only. Replies are
 * never written (out of scope). The hosts and paths are those the design names; the response shapes are parsed
 * defensively and an unrecognised shape fails with a plain message instead of storing a guess.
 */

export const ACCOUNT_MANAGEMENT_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
export const BUSINESS_INFORMATION_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
export const MY_BUSINESS_V4_BASE = 'https://mybusiness.googleapis.com/v4';
/** Memo §7: v4 `reviews.list` with page size 50. */
export const REVIEWS_PAGE_SIZE = 50;
/** Upper bounds that keep one sync small for a single shop (well under Google's 300 QPM once approved). */
export const MAX_ACCOUNTS = 20;
export const MAX_LOCATION_PAGES = 5;
export const MAX_REVIEW_PAGES = 100;
const GBP_TIMEOUT_MS = 30_000;

/** What went wrong, mapped to what the owner should do (email design §8.3 error mapping). */
export type BusinessProfileErrorKind = 'awaiting_approval' | 'api_disabled' | 'reauth' | 'no_access' | 'not_found' | 'transient' | 'unrecognised';

/** A Business Profile API failure with a plain message for the owner. */
export class BusinessProfileError extends Error {
  constructor(
    readonly kind: BusinessProfileErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BusinessProfileError';
  }
}

/** Plain message for a response Google sent in a shape we don't know. */
export const UNRECOGNISED_RESPONSE_MESSAGE = "Google's response format wasn't recognised. Nothing was stored; try again later.";

/** True when an error body says the project's quota is 0 (Google has not approved Basic API Access yet, memo §7). */
export function isQuotaZero(status: number, body: unknown): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const text = JSON.stringify(body ?? '').replace(/[\\"]/g, '');
  return /quota/i.test(text) && /(quota_limit_value\s*:\s*0\b|limit(\s+of)?\s*:?\s*0\b)/i.test(text);
}

/**
 * Maps an HTTP error from a Business Profile API. Quota 0 (429, or 403 mentioning a quota limit of 0) is
 * `awaiting_approval`, never an error; `SERVICE_DISABLED` names the API to turn on.
 */
export function mapBusinessProfileError(status: number, body: unknown, apiName: string): BusinessProfileError {
  const text = JSON.stringify(body ?? '').slice(0, 4000);
  if (isQuotaZero(status, body)) return new BusinessProfileError('awaiting_approval', "Google hasn't approved API access for this project yet.");
  if (status === 401) return new BusinessProfileError('reauth', 'Google needs you to sign in again. Reconnect Google Business Profile.');
  if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(text))
    return new BusinessProfileError('api_disabled', `Turn on the ${apiName} in your Google Cloud project, then press Check again.`);
  if (status === 403) return new BusinessProfileError('no_access', "This Google account can't manage the Business Profile. Sign in with the account that manages the studio's profile.");
  if (status === 404) return new BusinessProfileError('not_found', 'This location is no longer available; choose it again.');
  return new BusinessProfileError('transient', `Google didn't answer properly (HTTP ${status}). We'll try again.`);
}

type Ctx = Pick<WorkerContext, 'fetch' | 'logger'>;

/** GET with the access token; returns parsed JSON or throws a mapped {@link BusinessProfileError}. */
export async function gbpGet(ctx: Ctx, token: string, url: string, label: string, apiName: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await httpRequest(ctx, url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }, { label, signal, timeoutMs: GBP_TIMEOUT_MS });
  const json = await readJson(res);
  if (!res.ok) throw mapBusinessProfileError(res.status, json, apiName);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
  return json as Record<string, unknown>;
}

/** One location the signed-in account can manage. */
export interface DiscoveredLocation {
  /** `accounts/{id}`, needed for the v4 reviews path. */
  account: string;
  /** `locations/{id}`. */
  name: string;
  title: string;
  address: string;
}

const ACCOUNT_NAME = /^accounts\/[A-Za-z0-9_-]{1,100}$/;
const LOCATION_NAME = /^locations\/[A-Za-z0-9_-]{1,100}$/;

/** True for a stored `accounts/{id}` value (checked before it goes into a URL). */
export function isAccountName(v: unknown): v is string {
  return typeof v === 'string' && ACCOUNT_NAME.test(v);
}
/** True for a stored `locations/{id}` value (checked before it goes into a URL). */
export function isLocationName(v: unknown): v is string {
  return typeof v === 'string' && LOCATION_NAME.test(v);
}

function pageToken(json: Record<string, unknown>): string | null {
  const t = json['nextPageToken'];
  return typeof t === 'string' && t ? t : null;
}

/** One-line address from `storefrontAddress` (only the parts Google sent). */
export function addressLine(addr: unknown): string {
  if (!addr || typeof addr !== 'object') return '';
  const a = addr as Record<string, unknown>;
  const lines = Array.isArray(a['addressLines']) ? a['addressLines'].filter((l): l is string => typeof l === 'string') : [];
  const parts = [...lines, a['locality'], a['administrativeArea'], a['postalCode']].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return parts.join(', ').slice(0, 300);
}

/** Parses an `accounts.list` page into account names. */
export function parseAccounts(json: Record<string, unknown>): string[] {
  const list = json['accounts'];
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
  return list.map((a) => (a as { name?: unknown } | null)?.name).filter(isAccountName);
}

/** Parses a `locations.list` page. */
export function parseLocations(account: string, json: Record<string, unknown>): DiscoveredLocation[] {
  const list = json['locations'];
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
  const out: DiscoveredLocation[] = [];
  for (const l of list) {
    const loc = (l ?? {}) as Record<string, unknown>;
    if (!isLocationName(loc['name'])) continue;
    out.push({
      account,
      name: loc['name'],
      title: typeof loc['title'] === 'string' ? loc['title'].slice(0, 200) : '',
      address: addressLine(loc['storefrontAddress']),
    });
  }
  return out;
}

/**
 * Discovery (read-only): every account the sign-in can see, then each account's locations (`readMask` name, title and
 * storefront address). Bounded by {@link MAX_ACCOUNTS} and {@link MAX_LOCATION_PAGES}.
 */
export async function discoverLocations(ctx: Ctx, token: string, signal?: AbortSignal): Promise<DiscoveredLocation[]> {
  const accounts: string[] = [];
  let next: string | null = null;
  do {
    const url = new URL(`${ACCOUNT_MANAGEMENT_BASE}/accounts`);
    url.searchParams.set('pageSize', '20');
    if (next) url.searchParams.set('pageToken', next);
    const json = await gbpGet(ctx, token, url.toString(), 'google.gbp.accounts', 'My Business Account Management API', signal);
    accounts.push(...parseAccounts(json));
    next = pageToken(json);
  } while (next && accounts.length < MAX_ACCOUNTS);
  const locations: DiscoveredLocation[] = [];
  for (const account of accounts.slice(0, MAX_ACCOUNTS)) {
    let token2: string | null = null;
    for (let page = 0; page < MAX_LOCATION_PAGES; page++) {
      const url = new URL(`${BUSINESS_INFORMATION_BASE}/${account}/locations`);
      url.searchParams.set('readMask', 'name,title,storefrontAddress');
      url.searchParams.set('pageSize', '100');
      if (token2) url.searchParams.set('pageToken', token2);
      const json = await gbpGet(ctx, token, url.toString(), 'google.gbp.locations', 'My Business Business Information API', signal);
      locations.push(...parseLocations(account, json));
      token2 = pageToken(json);
      if (!token2) break;
    }
  }
  return locations;
}

/** One Google review, as stored (raw keeps only the fields shown: reply state and policy flag, memo §7). */
export interface ParsedReview {
  externalReviewId: string;
  rating: number | null;
  reviewerName: string;
  comment: string;
  createdAt: Date | null;
  updatedAt: Date;
  replyText: string | null;
  replyUpdatedAt: string | null;
  reviewReplyState: unknown;
  policyViolation: unknown;
}

function isoDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parses one `reviews.list` page. A review without an id or `updateTime` means the shape is not what we know. */
export function parseReviewsPage(json: Record<string, unknown>): { reviews: ParsedReview[]; nextPageToken: string | null; averageRating: number | null; totalReviewCount: number | null } {
  const list = json['reviews'];
  if (list !== undefined && !Array.isArray(list)) throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
  const reviews: ParsedReview[] = [];
  for (const item of list ?? []) {
    const r = (item ?? {}) as Record<string, unknown>;
    const id = typeof r['reviewId'] === 'string' && r['reviewId'] ? r['reviewId'] : typeof r['name'] === 'string' && r['name'] ? r['name'] : null;
    const updatedAt = isoDate(r['updateTime']);
    if (!id || !updatedAt) throw new BusinessProfileError('unrecognised', UNRECOGNISED_RESPONSE_MESSAGE);
    const reviewer = (r['reviewer'] ?? {}) as Record<string, unknown>;
    const reply = (r['reviewReply'] ?? null) as Record<string, unknown> | null;
    reviews.push({
      externalReviewId: id.slice(0, 300),
      rating: starRatingToNumber(r['starRating']),
      reviewerName: reviewer['isAnonymous'] === true ? 'Anonymous' : typeof reviewer['displayName'] === 'string' && reviewer['displayName'] ? reviewer['displayName'].slice(0, 120) : 'Anonymous',
      comment: typeof r['comment'] === 'string' ? r['comment'].slice(0, 5000) : '',
      createdAt: isoDate(r['createTime']),
      updatedAt,
      replyText: reply && typeof reply['comment'] === 'string' ? reply['comment'].slice(0, 5000) : null,
      replyUpdatedAt: reply && typeof reply['updateTime'] === 'string' ? reply['updateTime'] : null,
      reviewReplyState: r['reviewReplyState'] ?? null,
      policyViolation: r['policyViolation'] ?? null,
    });
  }
  const avg = json['averageRating'];
  const total = json['totalReviewCount'];
  return {
    reviews,
    nextPageToken: pageToken(json),
    averageRating: typeof avg === 'number' && Number.isFinite(avg) ? avg : null,
    totalReviewCount: typeof total === 'number' && Number.isInteger(total) ? total : null,
  };
}

/** Fetches one `reviews.list` page, newest update first. */
export async function fetchReviewsPage(ctx: Ctx, token: string, account: string, location: string, next: string | null, signal?: AbortSignal): Promise<ReturnType<typeof parseReviewsPage>> {
  if (!isAccountName(account) || !isLocationName(location)) throw new BusinessProfileError('not_found', 'This location is no longer available; choose it again.');
  const url = new URL(`${MY_BUSINESS_V4_BASE}/${account}/${location}/reviews`);
  url.searchParams.set('pageSize', String(REVIEWS_PAGE_SIZE));
  url.searchParams.set('orderBy', 'updateTime desc');
  if (next) url.searchParams.set('pageToken', next);
  return parseReviewsPage(await gbpGet(ctx, token, url.toString(), 'google.gbp.reviews', 'Google My Business API', signal));
}
