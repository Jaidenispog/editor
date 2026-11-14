import type {
  AuditSummary,
  Finding,
  PlatformHint,
  QueryGroup,
  Verification,
  WebsiteAuditResult,
  WebsiteChange,
  WebsiteEditSource,
  WebsiteEditStatus,
  WebsiteSettings,
} from '@studio/core';
import type { JobDto } from '@/lib/shared/dto';
import type { IntegrationStatus } from '@/lib/shared/integration-types';

/**
 * Browser-facing shapes of the Website page (plain JSON, dates as ISO strings). Built by `lib/website.ts`; never
 * contain tokens, passwords, page HTML or apply internals beyond outcome, message and verification.
 */

/** One website check in lists. */
export interface AuditSummaryDto {
  id: string;
  url: string;
  status: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: AuditSummary;
}

/** The setup checklist and page state. */
export interface WebsiteOverviewDto {
  setup: {
    website: string;
    host: string | null;
    websiteValid: boolean;
    ownershipConfirmed: boolean;
    ownershipConfirmedAt: string | null;
    /** Business details that are missing, each with what it enables. */
    missingDetails: Array<{ field: string; label: string; enables: string }>;
    profileDetailsCheckedAt: string | null;
    /** The details to compare with the Business Profile (copy button). */
    profileDetails: {
      name: string;
      address: string;
      phone: string;
      hours: string[];
    };
  };
  latestAudit: AuditSummaryDto | null;
  latestResult: WebsiteAuditResult | null;
  fixedSinceLast: string[];
  /** Set when the latest result read no page at all (with the stored reasons): it is not a clean bill of health. */
  pagesNotRead: { reasons: string[] } | null;
  activeJob: JobDto | null;
  /** Why "Check my website" is disabled, or null. */
  checkBlockedReason: string | null;
  openChanges: number;
  ai: { copyAvailable: boolean };
  connections: {
    searchConsole: IntegrationStatus | null;
    wordpress: IntegrationStatus | null;
  };
  queryGroups: Pick<WebsiteSettings, 'brandTerms' | 'placeTerms' | 'serviceTerms'>;
  platformHint: PlatformHint | null;
}

/** One prepared change as the review card shows it. */
export interface WebsiteEditDto {
  id: string;
  title: string;
  rationale: string;
  pageUrl: string;
  change: WebsiteChange;
  source: WebsiteEditSource;
  status: WebsiteEditStatus;
  statusMessage: string;
  statusReason: string | null;
  applyAvailable: { ok: boolean; reason: string | null };
  /** "WordPress at host — your public website" or "… — a staging site". */
  destination: { host: string; environment: 'live' | 'staging' } | null;
  firstLiveApply: boolean;
  instructions: { text: string; markdown: string };
  aiOptions: string[];
  aiDraftedAt: string | null;
  canDraft: boolean;
  verification: Verification | null;
  outcome: string | null;
  appliedAt: string | null;
  appliedVia: string | null;
  canUndo: boolean;
  findingKey: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Totals for one search group. Position is impression-weighted (null without impressions). */
export interface GroupTotals {
  clicks: number;
  impressions: number;
  position: number | null;
}

/** One query in a "Top searches" table. */
export interface QueryRowDto {
  query: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

/** States of the Search Console card (design §4.5). */
export type SearchPanelState = 'not_configured' | 'not_connected' | 'choose_property' | 'no_property' | 'syncing' | 'no_data' | 'connected' | 'needs_reauth' | 'error';

/** The Google search performance panel. Numbers appear only when Google returned rows. */
export interface SearchPerformanceDto {
  state: SearchPanelState;
  message: string | null;
  property: string | null;
  properties: Array<{ siteUrl: string; permission: string; readable: boolean }>;
  range: '28d' | '3m' | '16m';
  dataThrough: string | null;
  lastSyncAt: string | null;
  groups: Record<QueryGroup, GroupTotals> | null;
  notListed: { clicks: number; impressions: number } | null;
  daily: Array<{ date: string } & Record<QueryGroup | 'notListed', number>>;
  topQueries: Record<QueryGroup, QueryRowDto[]> | null;
  brandAmbiguous: boolean;
  canRefresh: boolean;
}

/** Findings of a check, as shown on the page. */
export type FindingDto = Finding;
