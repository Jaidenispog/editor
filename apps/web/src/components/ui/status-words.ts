import type { BadgeTone } from './badge';

/**
 * Tones for every status word in the app: Video Studio (jobs, assets, versions, generations) and the Stage B/C
 * modules (integrations, publishing, Square, email and reviews, website, trends). One place, so the same word
 * always looks the same. Square's own booking statuses are kept verbatim (upper case).
 */
const TONES: Record<string, BadgeTone> = {
  // Done / good
  ready: 'success',
  succeeded: 'success',
  complete: 'success',
  preview_ready: 'success',
  connected: 'success',
  planned: 'success',
  published: 'success',
  delivered: 'success',
  sent: 'success',
  applied: 'success',
  confirmed_public: 'success',
  ok: 'success',
  verified: 'success',
  cleared: 'success',
  payment_matched: 'success',
  owner_attended: 'success',
  ACCEPTED: 'success',
  // Waiting / neutral
  queued: 'neutral',
  uploaded: 'neutral',
  draft: 'neutral',
  none: 'neutral',
  approved: 'neutral',
  scheduled: 'neutral',
  skipped: 'neutral',
  proposed: 'neutral',
  upcoming: 'neutral',
  pending: 'neutral',
  not_connected: 'neutral',
  not_published: 'neutral',
  disconnected: 'neutral',
  superseded: 'neutral',
  rejected: 'neutral',
  dismissed: 'neutral',
  no_music: 'neutral',
  read_only: 'neutral',
  live: 'neutral',
  low: 'neutral',
  info: 'neutral',
  // A fact, not a to-do: nothing the owner can set up changes it (e.g. a feature that does not exist).
  unavailable: 'neutral',
  // Working
  running: 'info',
  processing: 'info',
  planning: 'info',
  rendering: 'info',
  rendering_preview: 'info',
  analysing: 'info',
  generating: 'info',
  in_progress: 'info',
  sending: 'info',
  applying: 'info',
  checking: 'info',
  medium: 'info',
  // Needs the owner
  partial: 'warning',
  needs_setup: 'warning',
  not_configured: 'warning',
  needs_reauth: 'warning',
  cancelled: 'warning',
  manual_step_required: 'warning',
  check_before_retry: 'warning',
  awaiting_approval: 'warning',
  pending_approval: 'warning',
  quota: 'warning',
  paused: 'warning',
  suppressed: 'warning',
  restricted: 'warning',
  not_visible: 'warning',
  awaiting_payment: 'warning',
  possible_match: 'warning',
  no_payment_matched: 'warning',
  owner_not_attended: 'warning',
  declined: 'warning',
  sandbox: 'warning',
  staging: 'warning',
  development_live: 'warning',
  high: 'warning',
  PENDING: 'warning',
  CANCELLED_BY_CUSTOMER: 'warning',
  CANCELLED_BY_SELLER: 'warning',
  DECLINED: 'warning',
  // Problems
  failed: 'danger',
  error: 'danger',
  bounced: 'danger',
  complained: 'danger',
  apply_failed: 'danger',
  blocked: 'danger',
  critical: 'danger',
  no_show: 'danger',
  NO_SHOW: 'danger',
};

/** Maps a status word to a colour. Unknown words are neutral. */
export function toneForStatus(status: string): BadgeTone {
  return Object.prototype.hasOwnProperty.call(TONES, status) ? (TONES[status] ?? 'neutral') : 'neutral';
}

const LABELS: Record<string, string> = {
  preview_ready: 'Preview ready',
  rendering_preview: 'Rendering preview',
  needs_setup: 'Needs setup',
  not_configured: 'Needs setup',
  not_connected: 'Not connected',
  needs_reauth: 'Reconnect needed',
  succeeded: 'Done',
  analysing: 'Analysing',
  // Integrations
  awaiting_approval: 'Waiting for Google',
  unavailable: 'Not available',
  disconnected: 'Disconnected',
  checking: 'Checking',
  live: 'Live',
  development_live: 'Live (development mode)',
  sandbox: 'Sandbox',
  staging: 'Staging site',
  read_only: 'Read-only',
  verified: 'Verified',
  // Publishing
  in_progress: 'In progress',
  manual_step_required: 'Action needed',
  check_before_retry: 'Check before retrying',
  not_published: 'Not published',
  no_music: 'No music',
  // Email and reviews
  pending_approval: 'Waiting for approval',
  complained: 'Spam complaint',
  suppressed: 'Not sent',
  // Square
  upcoming: 'Upcoming',
  awaiting_payment: 'Waiting for a payment',
  payment_matched: 'Paid (matched)',
  possible_match: 'Possible payment',
  no_payment_matched: 'No payment found',
  owner_attended: 'Attended',
  owner_not_attended: 'Didn’t attend',
  no_show: 'No-show',
  PENDING: 'Waiting for acceptance',
  ACCEPTED: 'Accepted',
  CANCELLED_BY_CUSTOMER: 'Cancelled by client',
  CANCELLED_BY_SELLER: 'Cancelled by studio',
  DECLINED: 'Declined',
  NO_SHOW: 'No-show',
  // Website
  critical: 'Urgent',
  high: 'Important',
  medium: 'Worth doing',
  low: 'Minor',
  info: 'Note',
  applying: 'Applying',
  apply_failed: 'Not applied',
  superseded: 'Out of date',
  applied: 'Done',
  not_visible: 'Not showing yet',
  confirmed_public: 'Showing on your site',
  // Trends
  ok: 'OK',
  pending: 'Waiting',
  quota: 'Daily limit reached',
};

/** Human label for a status word ("rendering_preview" → "Rendering preview"). */
export function statusLabel(status: string): string {
  if (Object.prototype.hasOwnProperty.call(LABELS, status)) return LABELS[status] ?? status;
  const words = status.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
