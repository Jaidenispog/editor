/**
 * Data shapes the email and review pages receive from the server (never tokens, never secrets). Shared by the API
 * routes, the server pages and the client components.
 */

export interface EmailMessageDto {
  id: string;
  customerId: string | null;
  customerName: string;
  toEmail: string;
  subject: string;
  purpose: string;
  messageClass: 'transactional_factual' | 'review_request' | 'campaign';
  origin: 'manual' | 'automation' | 'campaign' | 'preview';
  status: string;
  statusMessage: string;
  ownerAction: string | null;
  isSandbox: boolean;
  scheduledFor: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  campaignId: string | null;
  bookingId: string | null;
  /** The appointment it is about, in words ("Skin fade, Fri 14 Nov"), when tied to one. */
  appointment: string | null;
}

export interface GateReasonDto {
  code: string;
  message: string;
}

export interface LintDto {
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

export interface EmailMessageDetailDto {
  message: EmailMessageDto & { bodyMarkdown: string };
  /** Rendered copy (personal links shown as markers). */
  renderedHtml: string;
  timeline: Array<{ at: string; label: string }>;
  consentBasis: Record<string, unknown> | null;
  blockers: GateReasonDto[];
  lint: LintDto;
}

export interface EmailTemplateDto {
  id: string;
  name: string;
  purpose: string;
  messageClass: 'transactional_factual' | 'review_request' | 'campaign';
  subject: string;
  bodyMarkdown: string;
  builtIn: boolean;
  enabled: boolean;
  updatedAt: string;
}

export interface CampaignDto {
  id: string;
  name: string;
  subject: string;
  bodyMarkdown: string;
  audience: { lastVisitWithinDays: 90 | 180 | 365 | null };
  status: string;
  pausedReason: string;
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  bounceCount: number;
  complaintCount: number;
  approvedAt: string | null;
  createdAt: string;
}

export interface AudiencePreviewDto {
  included: number;
  excluded: number;
  byReason: Record<string, number>;
  rows: Array<{ customerId: string; name: string; email: string | null; included: boolean; reason: string | null }>;
  audienceHash: string;
  schedule: Array<{ date: string; count: number }>;
}

export type PermissionWord = 'express' | 'inferred' | 'none' | 'unsubscribed' | 'suppressed';

export interface ClientDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  fromSquare: boolean;
  permission: PermissionWord;
  permissionLabel: string;
  reviewOptOut: boolean;
  lastEmailedAt: string | null;
}

export interface ConsentDetailDto {
  state: { status: string; label: string };
  events: Array<{ id: string; kind: string; method: string; wording: string; occurredAt: string; recordedBy: string | null }>;
  suppressions: Array<{ id: string; scope: string; reason: string; source: string; createdAt: string; liftedAt: string | null }>;
  /** The current consent wording (business name filled in) and its hash, for the device and verbal modes. */
  wording: string;
  wordingHash: string;
  postmarkReactivated: boolean;
  /** Postmark still has the address on its Broadcast unsubscribe list after the client gave permission again. */
  providerStillSuppressed: boolean;
}

export interface EmailStatusDto {
  state: 'not_configured' | 'not_checked' | 'awaiting_approval' | 'connected' | 'needs_reauth' | 'error';
  liveMode: 'live' | 'sandbox' | null;
  approved: boolean | null;
  webhooks: boolean | null;
  lastCheckedAt: string | null;
  message: string;
  missingEnv: string[];
  pill: { status: string; label: string };
}

export interface AutomationDto {
  enabled: boolean;
  enabledAt: string | null;
  mode: 'approve_each' | 'send_automatically';
  templateId: string | null;
  delayHours: number;
  dailyCap: number;
}

export interface ReviewRequestDto {
  id: string;
  customerName: string;
  appointment: string;
  status: string;
  /** Sent, but the booking was cancelled, marked a no-show or "Didn't happen" afterwards (design §4.3 step 6). */
  bookingChanged: boolean;
  skipReason: string | null;
  skipLabel: string | null;
  origin: string;
  sentAt: string | null;
  firstClickedAt: string | null;
  clickCount: number;
  emailMessageId: string | null;
  messageStatus: string | null;
  isSandbox: boolean;
  createdAt: string;
}

export interface PlacesStateDto {
  state: 'not_configured' | 'no_place' | 'checking' | 'confirm' | 'connected' | 'error';
  placeId: string | null;
  candidate: { displayName: string | null; formattedAddress: string | null } | null;
  rating: number | null;
  userRatingCount: number | null;
  fetchedAt: string | null;
  writeAReviewUri: string | null;
  message: string | null;
  attribution: string;
}
