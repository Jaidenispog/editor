import type { PerformanceTileId, QueryGroup } from '@studio/core';
import type { BusinessProfileState, ProfilePerformanceState } from '../integrations/business_profile.js';

/**
 * What the browser receives about Google Business Profile (reviews tab and Website performance card). Only what
 * Google returned is ever included: no placeholder or estimated numbers, no tokens, nothing from other modules.
 */

/** One Google review as shown (never typed in or edited by hand). */
export interface GoogleReviewDto {
  id: string;
  rating: number | null;
  reviewerName: string;
  comment: string;
  createdAt: string | null;
  updatedAt: string | null;
  replyText: string | null;
  /** Google's `reviewReplyState`, in plain words, when Google sent one. */
  replyState: string | null;
  /** Google's `policyViolation`, in plain words, when Google flagged the review. */
  policyFlag: string | null;
}

/** A location discovery found, for the owner's choice. */
export interface ProfileLocationDto {
  name: string;
  title: string;
  address: string;
}

/** The "Reviews on Google" tab. */
export interface GoogleReviewsDto {
  state: BusinessProfileState;
  message: string | null;
  location: { name: string; title: string } | null;
  /** Filled only while the owner has to choose. */
  locations: ProfileLocationDto[];
  reviews: GoogleReviewDto[];
  /** Google's own totals from the last sync, when it sent them. */
  totalReviewCount: number | null;
  averageRating: number | null;
  syncedAt: string | null;
  canRefresh: boolean;
}

/** The Business Profile performance card's states (website design §4.6). */
export type ProfilePanelState = 'not_configured' | 'not_connected' | 'choose_location' | 'needs_reauth' | 'error' | ProfilePerformanceState | 'syncing' | 'no_data' | 'connected';

/** One month's search keywords, grouped like Search Console queries. */
export interface ProfileKeywordDto {
  keyword: string;
  /** The exact count, or null when Google reported only "fewer than" a threshold. */
  value: number | null;
  threshold: number | null;
}

/** The Business Profile performance card. */
export interface ProfilePerformanceDto {
  state: ProfilePanelState;
  message: string | null;
  location: { name: string; title: string } | null;
  range: '28d' | '3m' | '12m';
  /** The last day with a value from Google, or null. */
  dataThrough: string | null;
  syncedAt: string | null;
  /** Per tile: the sum of what Google returned in the range, or null (shown "—") when it returned nothing. */
  totals: Record<PerformanceTileId, number | null> | null;
  /** The two parts of each views tile (mobile and desktop), shown on hover or tap. */
  viewParts: { search: { mobile: number | null; desktop: number | null }; maps: { mobile: number | null; desktop: number | null } } | null;
  keywords: { month: string; groups: Record<QueryGroup, ProfileKeywordDto[]> } | null;
  canRefresh: boolean;
}

/** A number Google returned, or "—" when it returned none (never a made-up 0). */
export function profileNumber(v: number | null | undefined): string {
  return typeof v === 'number' ? new Intl.NumberFormat('en-AU').format(v) : '—';
}

/** A keyword's count: exact, "< N" when Google gave only a threshold, or "—". */
export function keywordCount(k: ProfileKeywordDto): string {
  if (k.value !== null) return profileNumber(k.value);
  return k.threshold !== null ? `< ${profileNumber(k.threshold)}` : '—';
}
