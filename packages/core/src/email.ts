import { z } from 'zod';
import { isGenuinelyCompleted } from './completion.js';
import { EMAIL_VARIABLES, LINK_VARIABLES, MESSAGE_CLASSES, isAllowedLinkTarget, type LintResult, type MessageClass } from './email-lint.js';
import { BUSINESS_LOCALE, BUSINESS_TIMEZONE, addDaysToDate, melbourneDateOf, melbourneLocalToUtc, nextSendSlot, type SendWindow } from './time.js';

export * from './email-lint.js';

/**
 * Email rules shared by the web app and the worker (email design §3). Pure and browser-safe: no I/O, no Node APIs.
 * The worker loads facts from the database and calls {@link evaluateSendPolicy} immediately before every provider
 * call; the API calls it only to show blockers early. Nothing here sends anything.
 */

// ---------------------------------------------------------------------------------------------------------
// Classes, streams, statuses
// ---------------------------------------------------------------------------------------------------------

export const MessageClassSchema = z.enum(MESSAGE_CLASSES);

/** Review requests and campaigns are commercial (memo §8: review requests are treated as commercial). */
export const isCommercial = (c: MessageClass): boolean => c !== 'transactional_factual';
/** Postmark stream for a class: factual → Transactional, commercial → Broadcast (with one-click unsubscribe). */
export const streamFor = (c: MessageClass): 'transactional' | 'broadcast' => (isCommercial(c) ? 'broadcast' : 'transactional');

export const EMAIL_ORIGINS = ['manual', 'automation', 'campaign', 'preview'] as const;
export type EmailOrigin = (typeof EMAIL_ORIGINS)[number];
export const EMAIL_PURPOSES = ['follow_up', 'review_request', 'campaign', 'rebooking', 'custom', 'preview'] as const;
export type EmailPurpose = (typeof EMAIL_PURPOSES)[number];
/** Template purposes (a template is never a preview). */
export const TEMPLATE_PURPOSES = ['follow_up', 'review_request', 'campaign', 'rebooking', 'custom'] as const;
export type TemplatePurpose = (typeof TEMPLATE_PURPOSES)[number];

/** Every status an `email_messages` row can have. */
export const EMAIL_MESSAGE_STATUSES = ['draft', 'approved', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'cancelled'] as const;
export type EmailMessageStatus = (typeof EMAIL_MESSAGE_STATUSES)[number];
/** Statuses from which a message may still be sent (and so may still be cancelled or suppressed). */
export const PENDING_EMAIL_STATUSES = ['draft', 'approved', 'queued'] as const;

export const CAMPAIGN_STATUSES = ['draft', 'approved', 'sending', 'paused', 'sent', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Owner-facing type labels (never the internal class name). */
export const MESSAGE_CLASS_LABELS: Record<MessageClass, string> = {
  transactional_factual: 'Information only',
  review_request: 'Review request',
  campaign: 'Marketing',
};

/** Dedupe keys (unique `email_messages.dedupe_key`; review requests use the same value). Design §6.2. */
export const dedupeKeys = {
  reviewForBooking: (bookingId: string) => `review:${bookingId}`,
  reviewManual: (customerId: string, visitDate: string) => `review:manual:${customerId}:${visitDate}`,
  followUp: (bookingId: string) => `follow_up:${bookingId}`,
  campaign: (campaignId: string, customerId: string) => `campaign:${campaignId}:${customerId}`,
  manual: (messageId: string) => `manual:${messageId}`,
  preview: (messageId: string) => `preview:${messageId}`,
};

// ---------------------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------------------

/** Lower-cased, trimmed address used for consent and suppressions (consent is per address, not per client). */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** A plausible single email address (no display name, no spaces, a dotted domain). */
export function isValidEmailAddress(email: string): boolean {
  const e = email.trim();
  return e.length <= 254 && EMAIL_RE.test(e);
}

/** "j•••@gmail.com": enough for the client to recognise their address, nothing more. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.trim().split('@');
  if (!domain) return '•••';
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** The address part of a sender such as `"Studio" <hello@studio.com.au>` (or the value itself). */
export function senderAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m?.[1] ?? from).trim();
}

/** The domain of a sender such as `"Studio" <hello@studio.com.au>`, or null. */
export function senderDomain(from: string): string | null {
  const addr = senderAddress(from);
  const at = addr.lastIndexOf('@');
  return at > 0 ? addr.slice(at + 1).toLowerCase() : null;
}

// ---------------------------------------------------------------------------------------------------------
// Rendering (design §3.2)
// ---------------------------------------------------------------------------------------------------------

/** Who the email is from: the sender identification every email carries (memo §8, Spam Act s 17). */
export interface BusinessIdentity {
  businessName: string;
  addressLine: string;
  suburb: string;
  state: string;
  postcode: string;
  phone: string;
  email: string;
}

/** The identity fields that are missing (an email without them is never sent). */
export function missingIdentityFields(identity: BusinessIdentity): Array<'business name' | 'street address' | 'phone' | 'email'> {
  const out: Array<'business name' | 'street address' | 'phone' | 'email'> = [];
  if (!identity.businessName.trim()) out.push('business name');
  if (!identity.addressLine.trim() || !identity.suburb.trim() || !identity.postcode.trim()) out.push('street address');
  if (!identity.phone.trim()) out.push('phone');
  if (!identity.email.trim()) out.push('email');
  return out;
}

/** Values for the template variables. */
export interface EmailVariableValues {
  firstName: string | null;
  businessName: string;
  visitDate: Date | null;
  serviceName: string | null;
  senderName: string;
  bookingLink: string | null;
}

/** Input to {@link renderEmail}. */
export interface RenderEmailInput {
  messageClass: MessageClass;
  subject: string;
  bodyMarkdown: string;
  vars: EmailVariableValues;
  identity: BusinessIdentity;
  /** The app's tracked review redirect (`{APP_URL}/r/{token}`); null when this email has none. */
  reviewLinkUrl: string | null;
  /** The app's own permanent unsubscribe page (`{APP_URL}/u/{token}`); commercial emails always have one. */
  unsubscribeUrl: string | null;
  /** Accent colour for the header and link button (`#RRGGBB`). */
  accentColour: string;
}

/** A rendered email, plus the copies stored in the database (personal token links replaced by markers). */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  storedHtml: string;
  storedText: string;
}

/** Postmark's one-click unsubscribe placeholder on Broadcast streams. */
export const POSTMARK_UNSUBSCRIBE_PLACEHOLDER = '{{{ pm:unsubscribe }}}';
export const REVIEW_LINK_MARKER = '[review link]';
export const UNSUBSCRIBE_LINK_MARKER = '[unsubscribe link]';

const escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escapes text (every value from a client, a template or the owner is data, never HTML). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => escapeMap[c] ?? c);
}

/** "Friday 14 November" in Melbourne time. */
export function formatVisitDate(d: Date): string {
  return new Intl.DateTimeFormat(BUSINESS_LOCALE, { timeZone: BUSINESS_TIMEZONE, weekday: 'long', day: 'numeric', month: 'long' }).format(d).replace(',', '');
}

function variableValue(name: string, vars: EmailVariableValues, links: { review: string | null; booking: string | null }): string | null {
  switch (name) {
    case 'first_name':
      return vars.firstName?.trim() || 'there';
    case 'business_name':
      return vars.businessName;
    case 'visit_date':
      return vars.visitDate ? formatVisitDate(vars.visitDate) : 'your last visit';
    case 'service_name':
      return vars.serviceName?.trim() || 'your appointment';
    case 'sender_name':
      return vars.senderName || vars.businessName;
    case 'review_link':
      return links.review;
    case 'booking_link':
      return links.booking;
    default:
      return null;
  }
}

interface InlineOut {
  html: string;
  text: string;
}

/** Renders one line of the Markdown subset: links, **bold**, *italic*, variables. Everything else is escaped. */
function renderInline(line: string, vars: EmailVariableValues, links: { review: string | null; booking: string | null }, accent: string): InlineOut {
  let html = '';
  let text = '';
  let last = 0;
  const linkRe = /\[([^\]\n]*)\]\(([^)\s]*)\)/g;
  const plain = (s: string): InlineOut => {
    let h = escapeHtml(s)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    let t = s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
    const sub = (input: string, escape: boolean) =>
      input.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, name: string) => {
        const v = variableValue(name, vars, links);
        if (v === null) return whole;
        return escape ? escapeHtml(v) : v;
      });
    h = sub(h, true);
    t = sub(t, false);
    return { html: h, text: t };
  };
  for (const m of line.matchAll(linkRe)) {
    const before = plain(line.slice(last, m.index));
    html += before.html;
    text += before.text;
    const label = plain(m[1] ?? '');
    const target = m[2] ?? '';
    let href: string | null = null;
    const varMatch = /^\{\{\s*([a-z_]+)\s*\}\}$/.exec(target);
    if (varMatch && (LINK_VARIABLES as readonly string[]).includes(varMatch[1] ?? '')) href = variableValue(varMatch[1] ?? '', vars, links);
    else if (isAllowedLinkTarget(target)) href = target;
    if (href) {
      html += `<a href="${escapeHtml(href)}" style="color:${accent};font-weight:600;text-decoration:underline">${label.html || escapeHtml(href)}</a>`;
      text += label.text ? `${label.text} (${href})` : href;
    } else {
      html += label.html;
      text += label.text;
    }
    last = (m.index ?? 0) + m[0].length;
  }
  const rest = plain(line.slice(last));
  return { html: html + rest.html, text: text + rest.text };
}

/** Renders the Markdown subset (paragraphs, line breaks, - lists) to HTML and plain text. */
export function renderMarkdownSubset(markdown: string, vars: EmailVariableValues, links: { review: string | null; booking: string | null }, accent = '#111111'): { html: string; text: string } {
  const blocks = markdown.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const html: string[] = [];
  const text: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines.map((l) => renderInline(l.replace(/^\s*[-*]\s+/, ''), vars, links, accent));
      html.push(`<ul style="margin:0 0 16px 20px;padding:0">${items.map((i) => `<li style="margin:0 0 6px">${i.html}</li>`).join('')}</ul>`);
      text.push(items.map((i) => `- ${i.text}`).join('\n'));
    } else {
      const parts = lines.map((l) => renderInline(l, vars, links, accent));
      html.push(`<p style="margin:0 0 16px">${parts.map((p) => p.html).join('<br>')}</p>`);
      text.push(parts.map((p) => p.text).join('\n'));
    }
  }
  return { html: html.join('\n'), text: text.join('\n\n') };
}

function identityLines(identity: BusinessIdentity): string[] {
  const place = [identity.suburb, identity.state, identity.postcode].filter((s) => s.trim()).join(' ');
  const address = [identity.addressLine.trim(), place].filter(Boolean).join(', ');
  return [identity.businessName, address, [identity.phone, identity.email].filter((s) => s.trim()).join(' · ')].filter((s) => s.trim());
}

/** Renders the whole email: body, the fixed sender-identification footer and, for commercial classes, the unsubscribe text. */
export function renderEmail(input: RenderEmailInput): RenderedEmail {
  const build = (review: string | null, unsubscribe: string | null) => {
    const links = { review, booking: input.vars.bookingLink?.trim() ? input.vars.bookingLink.trim() : null };
    const subject = input.subject.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, name: string) => {
      if (name === 'review_link' || name === 'booking_link') return '';
      return variableValue(name, input.vars, links) ?? whole;
    }).replace(/\s+/g, ' ').trim();
    const accent = /^#[0-9a-fA-F]{6}$/.test(input.accentColour) ? input.accentColour : '#111111';
    const body = renderMarkdownSubset(input.bodyMarkdown, input.vars, links, accent);
    const ident = identityLines(input.identity);
    const footerHtml: string[] = [`<p style="margin:0 0 8px">${ident.map(escapeHtml).join('<br>')}</p>`];
    const footerText: string[] = [ident.join('\n')];
    if (isCommercial(input.messageClass)) {
      const business = escapeHtml(input.identity.businessName);
      const phone = input.identity.phone.trim();
      const fallback = unsubscribe ? ` If that link ever stops working, use ${unsubscribe}, or reply to this email${phone ? ` or call ${phone}` : ''} and we'll remove you the same day.` : '';
      footerHtml.push(
        `<p style="margin:0">You're getting this because you agreed to hear from ${business}. To stop marketing emails: <a href="${POSTMARK_UNSUBSCRIBE_PLACEHOLDER}" style="color:#555">Unsubscribe</a>.${
          unsubscribe ? ` If that link ever stops working, use <a href="${escapeHtml(unsubscribe)}" style="color:#555">${escapeHtml(unsubscribe)}</a>, or reply to this email${phone ? ` or call ${escapeHtml(phone)}` : ''} and we'll remove you the same day.` : ''
        }</p>`,
      );
      footerText.push(`You're getting this because you agreed to hear from ${input.identity.businessName}. To stop marketing emails: Unsubscribe (${POSTMARK_UNSUBSCRIBE_PLACEHOLDER}).${fallback}`);
    }
    const html = [
      '<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
      `<title>${escapeHtml(subject)}</title></head>`,
      '<body style="margin:0;padding:0;background:#ffffff;color:#1f1f1f;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55">',
      '<div style="max-width:560px;margin:0 auto;padding:24px 20px">',
      `<p style="margin:0 0 20px;font-size:18px;font-weight:700;color:${accent}">${escapeHtml(input.identity.businessName)}</p>`,
      body.html,
      `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:13px;line-height:1.5;color:#666">${footerHtml.join('')}</div>`,
      '</div></body></html>',
    ].join('\n');
    const text = `${body.text}\n\n--\n${footerText.join('\n\n')}`;
    return { subject, html, text };
  };
  const real = build(input.reviewLinkUrl, input.unsubscribeUrl);
  const stored = build(input.reviewLinkUrl ? REVIEW_LINK_MARKER : null, input.unsubscribeUrl ? UNSUBSCRIBE_LINK_MARKER : null);
  return { subject: real.subject, html: real.html, text: real.text, storedHtml: stored.html, storedText: stored.text };
}

// ---------------------------------------------------------------------------------------------------------
// Consent (design §3.4)
// ---------------------------------------------------------------------------------------------------------

export const CONSENT_METHODS = [
  'in_person_device',
  'verbal_owner_recorded',
  'unsubscribe_page',
  'one_click',
  'postmark_unsubscribe',
  'reply_email',
  'phone',
  'in_person',
  'square_preference',
  'owner_other',
] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/** One consent-ledger row, as the fold needs it. */
export interface ConsentEventFact {
  id: string;
  kind: 'granted' | 'withdrawn';
  method: string;
  occurredAt: Date;
}

/** One suppression row, as the fold and the gate need it. */
export interface SuppressionFact {
  scope: 'all' | 'marketing';
  reason: string;
  createdAt: Date;
  liftedAt: Date | null;
}

/** The consent state of one address. */
export type ConsentState =
  | { status: 'express'; since: string; consentEventId: string }
  | { status: 'inferred'; visits12m: number; lastVisitAt: string }
  | { status: 'withdrawn'; at: string; source: string }
  | { status: 'none' };

const YEAR_MS = 365 * 24 * 3600_000;

/**
 * Folds the ledger (and active marketing suppressions) into one state. The latest grant against the latest
 * withdrawal wins, and a tie goes to the withdrawal. "Inferred" consent (at least 2 genuinely completed visits in the
 * last 12 months, the latest within 12 months) is only considered when the owner turned it on and the address has
 * never withdrawn (memo §8: the app's own conservative rule, off by default).
 */
export function foldConsent(
  events: readonly ConsentEventFact[],
  suppressions: readonly SuppressionFact[],
  opts: { allowInferred: boolean; completedVisits?: readonly Date[]; now: Date },
): ConsentState {
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const lastGrant = [...sorted].reverse().find((e) => e.kind === 'granted') ?? null;
  const withdrawals: Array<{ at: Date; source: string }> = sorted.filter((e) => e.kind === 'withdrawn').map((e) => ({ at: e.occurredAt, source: e.method }));
  for (const s of suppressions) if (!s.liftedAt && s.scope === 'marketing') withdrawals.push({ at: s.createdAt, source: s.reason });
  withdrawals.sort((a, b) => a.at.getTime() - b.at.getTime());
  const lastWithdrawal = withdrawals[withdrawals.length - 1] ?? null;
  if (lastGrant && (!lastWithdrawal || lastGrant.occurredAt.getTime() > lastWithdrawal.at.getTime())) {
    return { status: 'express', since: lastGrant.occurredAt.toISOString(), consentEventId: lastGrant.id };
  }
  if (lastWithdrawal) return { status: 'withdrawn', at: lastWithdrawal.at.toISOString(), source: lastWithdrawal.source };
  if (opts.allowInferred && opts.completedVisits) {
    const since = opts.now.getTime() - YEAR_MS;
    const recent = opts.completedVisits.filter((d) => d.getTime() >= since && d.getTime() <= opts.now.getTime()).sort((a, b) => b.getTime() - a.getTime());
    if (recent.length >= 2 && recent[0]) return { status: 'inferred', visits12m: recent.length, lastVisitAt: recent[0].toISOString() };
  }
  return { status: 'none' };
}

/** True when the state allows commercial email. */
export function consentAllowsMarketing(state: ConsentState): boolean {
  return state.status === 'express' || state.status === 'inferred';
}

/** Plain words for a consent state. */
export function consentLabel(state: ConsentState): string {
  switch (state.status) {
    case 'express':
      return `Express permission since ${new Intl.DateTimeFormat(BUSINESS_LOCALE, { timeZone: BUSINESS_TIMEZONE, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(state.since))}`;
    case 'inferred':
      return `Inferred from ${state.visits12m} visits in 12 months`;
    case 'withdrawn':
      return 'Unsubscribed from marketing';
    default:
      return 'No marketing permission recorded';
  }
}

/** The consent wording with `{business_name}` filled in (the substituted text is what the ledger stores). */
export function consentWordingFor(wording: string, businessName: string): string {
  return wording.replace(/\{business_name\}/g, businessName);
}

// ---------------------------------------------------------------------------------------------------------
// The send gate (design §3.5)
// ---------------------------------------------------------------------------------------------------------

export const SEND_REASON_CODES = [
  'provider_not_ready',
  'webhooks_missing',
  'business_identity_missing',
  'invalid_address',
  'preview_not_owner',
  'suppressed_all',
  'unsubscribed',
  'no_consent',
  'review_opt_out',
  'review_link_missing',
  'review_link_invalid',
  'booking_not_completed',
  'booking_cancelled',
  'booking_no_show',
  'recently_asked',
  'lint_errors',
  'automation_off',
  'outside_window',
  'daily_cap',
  'customer_daily_limit',
  'sandbox',
] as const;
export type SendReasonCode = (typeof SEND_REASON_CODES)[number];

/** What a blocking reason does to the message: stays approved for later, or ends as suppressed/cancelled/failed. */
export type BlockOutcome = 'hold' | 'suppressed' | 'cancelled' | 'failed';

/** One gate reason with its plain message. */
export interface SendReason {
  code: SendReasonCode;
  message: string;
  outcome?: BlockOutcome;
}

/** Facts about the email provider, from the latest read-only check. */
export interface ProviderReadiness {
  /** The provider is configured and its last check succeeded (token accepted, streams found). */
  ready: boolean;
  /** Webhooks found on the streams (null = could not tell; the owner may attest instead). */
  webhooksConfigured: boolean | null;
  /** The owner ticked "I added the webhook" (used only when the check could not tell). */
  webhooksAttested: boolean;
  /** The Postmark server is a Sandbox server: nothing reaches clients. */
  sandbox: boolean;
}

/** Everything the gate decides from. Loaded by the worker immediately before the provider call. */
export interface SendPolicyInput {
  messageClass: MessageClass;
  origin: EmailOrigin;
  toEmail: string;
  /** The signed-in owner's own address (only previews to it are allowed). */
  ownerEmail: string | null;
  /** The client the email is for (null for previews). */
  customer: { deleted: boolean; reviewOptOut: boolean; squareEmailUnsubscribed: boolean | null } | null;
  consent: ConsentState;
  /** Active (not lifted) suppressions for the address. */
  suppressions: readonly Pick<SuppressionFact, 'scope' | 'reason'>[];
  identity: BusinessIdentity;
  provider: ProviderReadiness;
  /** The booking this follow-up or review request is about; null when none (manual or attested). */
  booking: { status: string; completionSource: string; completedAt: Date | null } | null;
  /** A review request: the saved review link (validated here). */
  reviewLink: string | null;
  /** A review request: a request was already sent to this client within the minimum gap. */
  recentlyAsked: boolean;
  minDaysBetweenRequests: number;
  lint: Pick<LintResult, 'errors'>;
  /** For origin `automation`: whether that automation is still switched on. */
  automationEnabled: boolean | null;
  /** True when a person approved this message (approved_by set). */
  approvedByPerson: boolean;
  counters: {
    /** Sent today (Melbourne day) by this message's automation, and its cap. */
    automationSentToday: number;
    automationCap: number | null;
    /** Commercial emails sent today, and the global commercial cap. */
    commercialSentToday: number;
    commercialCap: number;
    /** Automated emails to this client today. */
    customerAutomatedToday: number;
  };
  window: SendWindow;
  now: Date;
}

/** The snapshot of the consent basis stored on the message at send time. */
export interface ConsentBasis {
  status: ConsentState['status'] | 'not_required' | 'preview';
  consentEventId?: string;
  visits12m?: number;
  checkedAt: string;
}

/** The gate's decision. */
export interface SendDecision {
  decision: 'send' | 'defer' | 'block';
  reasons: SendReason[];
  deferUntil?: Date;
  /** For `block`: what happens to the message. */
  outcome?: BlockOutcome;
  consentBasis: ConsentBasis;
  /** True when the provider is a Sandbox server (shown as "Test — not delivered"). */
  sandbox: boolean;
}

const REASON_MESSAGES: Record<SendReasonCode, string> = {
  provider_not_ready: "Email sending isn't set up yet.",
  webhooks_missing: "Postmark isn't telling the app about bounces and unsubscribes yet, so marketing emails are on hold.",
  business_identity_missing: "Add your business address, phone and email in Settings → Business. Every email must say who it's from.",
  invalid_address: "This email address doesn't look valid.",
  preview_not_owner: 'Previews go only to your own email address.',
  suppressed_all: 'This address bounced or reported spam. Nothing can be sent to it.',
  unsubscribed: 'This client unsubscribed from marketing emails.',
  no_consent: 'No marketing permission recorded for this address.',
  review_opt_out: 'This client asked not to get review requests.',
  review_link_missing: 'Add your Google review link in Reviews → Review link.',
  review_link_invalid: 'Add your Google review link in Reviews → Review link.',
  booking_not_completed: 'The appointment is no longer marked as completed.',
  booking_cancelled: 'The appointment is no longer marked as completed.',
  booking_no_show: 'The appointment is no longer marked as completed.',
  recently_asked: 'Already asked within the last {n} days.',
  lint_errors: 'This email has problems to fix first.',
  automation_off: 'The automation was switched off before this was sent.',
  outside_window: 'Waiting for the sending window.',
  daily_cap: 'Daily limit reached; sends tomorrow at 9:00 am.',
  customer_daily_limit: 'This client already got an automated email today; sends tomorrow.',
  sandbox: 'Test server: not delivered to the client.',
};

const OUTCOMES: Partial<Record<SendReasonCode, BlockOutcome>> = {
  provider_not_ready: 'hold',
  webhooks_missing: 'hold',
  business_identity_missing: 'failed',
  invalid_address: 'failed',
  preview_not_owner: 'failed',
  suppressed_all: 'suppressed',
  unsubscribed: 'suppressed',
  no_consent: 'failed',
  review_opt_out: 'cancelled',
  review_link_missing: 'failed',
  review_link_invalid: 'failed',
  booking_not_completed: 'cancelled',
  booking_cancelled: 'cancelled',
  booking_no_show: 'cancelled',
  recently_asked: 'cancelled',
  lint_errors: 'failed',
  automation_off: 'cancelled',
};

/** A reason with its standard message (and `{n}` filled in). */
export function sendReason(code: SendReasonCode, n?: number, detail?: string): SendReason {
  const outcome = OUTCOMES[code];
  const base = REASON_MESSAGES[code].replace('{n}', String(n ?? ''));
  return { code, message: detail ? `${base} ${detail}` : base, ...(outcome ? { outcome } : {}) };
}

/** Square statuses meaning the booking did not go ahead (memo §6: six statuses, mirrored verbatim). */
const CANCELLED_STATUSES = new Set(['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'DECLINED']);

/** Why a booking no longer counts as completed, or null when it genuinely does. */
export function bookingBlock(b: { status: string; completionSource: string; completedAt: Date | null }): 'booking_cancelled' | 'booking_no_show' | 'booking_not_completed' | null {
  if (CANCELLED_STATUSES.has(b.status)) return 'booking_cancelled';
  if (b.status === 'NO_SHOW') return 'booking_no_show';
  return isGenuinelyCompleted(b) ? null : 'booking_not_completed';
}

/** The start of the sending window on the Melbourne day after `now`. */
export function nextDayWindowStart(now: Date, window: SendWindow): Date {
  const tomorrow = addDaysToDate(melbourneDateOf(now), 1);
  const r = melbourneLocalToUtc(tomorrow, window.start);
  return r.ok ? r.instant : nextSendSlot(new Date(now.getTime() + 24 * 3600_000), window);
}

/** The single send gate (memo §8 `assertCanSend`). Collects every blocker; defers only when nothing blocks. */
export function evaluateSendPolicy(input: SendPolicyInput): SendDecision {
  const blocks: SendReason[] = [];
  const commercial = isCommercial(input.messageClass);
  const now = input.now;
  const checkedAt = now.toISOString();

  if (!input.provider.ready) blocks.push(sendReason('provider_not_ready'));
  if (commercial && input.origin !== 'preview' && input.provider.ready && input.provider.webhooksConfigured !== true && !(input.provider.webhooksConfigured === null && input.provider.webhooksAttested)) {
    blocks.push(sendReason('webhooks_missing'));
  }
  const missing = missingIdentityFields(input.identity);
  if (missing.length) blocks.push(sendReason('business_identity_missing'));
  if (!isValidEmailAddress(input.toEmail)) blocks.push(sendReason('invalid_address'));
  const active = input.suppressions;
  if (active.some((s) => s.scope === 'all')) blocks.push(sendReason('suppressed_all'));
  if (input.lint.errors.length) blocks.push(sendReason('lint_errors', undefined, input.lint.errors.map((e) => e.message).join(' ')));

  let consentBasis: ConsentBasis = { status: commercial ? input.consent.status : 'not_required', checkedAt };
  if (input.origin === 'preview') {
    consentBasis = { status: 'preview', checkedAt };
    if (!input.ownerEmail || normaliseEmail(input.ownerEmail) !== normaliseEmail(input.toEmail)) blocks.push(sendReason('preview_not_owner'));
  } else {
    if (commercial) {
      const unsub = active.some((s) => s.scope === 'marketing') || input.consent.status === 'withdrawn' || input.customer?.squareEmailUnsubscribed === true;
      if (unsub) blocks.push(sendReason('unsubscribed'));
      else if (!consentAllowsMarketing(input.consent)) blocks.push(sendReason('no_consent'));
      if (input.consent.status === 'express') consentBasis = { status: 'express', consentEventId: input.consent.consentEventId, checkedAt };
      if (input.consent.status === 'inferred') consentBasis = { status: 'inferred', visits12m: input.consent.visits12m, checkedAt };
    }
    if (input.customer?.deleted) blocks.push(sendReason('invalid_address', undefined, 'The client was deleted.'));
    if (input.messageClass === 'review_request') {
      if (input.customer?.reviewOptOut) blocks.push(sendReason('review_opt_out'));
      const link = input.reviewLink?.trim() ?? '';
      if (!link) blocks.push(sendReason('review_link_missing'));
      else if (!validateReviewLinkShape(link)) blocks.push(sendReason('review_link_invalid'));
      if (input.recentlyAsked) blocks.push(sendReason('recently_asked', input.minDaysBetweenRequests));
    }
    if (input.booking) {
      const b = bookingBlock(input.booking);
      if (b) blocks.push(sendReason(b));
    }
    if (input.origin === 'automation' && !input.approvedByPerson && input.automationEnabled !== true) blocks.push(sendReason('automation_off'));
  }

  const sandbox = input.provider.ready && input.provider.sandbox;
  if (blocks.length) {
    const outcomes = blocks.map((b) => b.outcome ?? 'failed');
    const outcome: BlockOutcome = outcomes.includes('suppressed') ? 'suppressed' : outcomes.includes('cancelled') ? 'cancelled' : outcomes.every((o) => o === 'hold') ? 'hold' : 'failed';
    return { decision: 'block', reasons: blocks, outcome, consentBasis, sandbox };
  }

  // Deferrals (only once nothing blocks).
  const defers: Array<{ reason: SendReason; until: Date }> = [];
  if (input.origin === 'automation' || input.origin === 'campaign') {
    const slot = nextSendSlot(now, input.window);
    if (slot.getTime() > now.getTime()) defers.push({ reason: sendReason('outside_window'), until: slot });
  }
  const tomorrow = nextDayWindowStart(now, input.window);
  if (input.origin === 'automation' && input.counters.automationCap !== null && input.counters.automationSentToday >= input.counters.automationCap) defers.push({ reason: sendReason('daily_cap'), until: tomorrow });
  if (commercial && input.origin !== 'preview' && input.counters.commercialSentToday >= input.counters.commercialCap) defers.push({ reason: sendReason('daily_cap'), until: tomorrow });
  if (input.origin === 'automation' && input.counters.customerAutomatedToday >= 1) defers.push({ reason: sendReason('customer_daily_limit'), until: tomorrow });
  if (defers.length) {
    const until = defers.reduce((a, b) => (b.until.getTime() > a.getTime() ? b.until : a), defers[0]?.until ?? now);
    return { decision: 'defer', reasons: defers.map((d) => d.reason), deferUntil: until, consentBasis, sandbox };
  }
  return { decision: 'send', reasons: sandbox ? [sendReason('sandbox')] : [], consentBasis, sandbox };
}

// ---------------------------------------------------------------------------------------------------------
// Review link shape (the full check with skip reasons lives in reviews.ts)
// ---------------------------------------------------------------------------------------------------------

/** Hosts an official Google review link may use (the app never builds these URLs; memo §7). */
export const REVIEW_LINK_HOSTS = ['g.page', 'search.google.com', 'www.google.com', 'google.com', 'maps.google.com', 'maps.app.goo.gl', 'www.google.com.au', 'google.com.au'] as const;

/** True when a pasted review link is https, on a Google host and at most 500 characters. */
export function validateReviewLinkShape(url: string): boolean {
  if (url.length > 500) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (REVIEW_LINK_HOSTS as readonly string[]).includes(u.hostname.toLowerCase()) && !u.username && !u.password;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Campaign helpers (design §4.4, memo §8 auto-pause)
// ---------------------------------------------------------------------------------------------------------

/** Complaint rate above 0.1% or bounce rate above 5% pauses a campaign (memo §8). */
export const AUTO_PAUSE_COMPLAINT_RATE = 0.001;
export const AUTO_PAUSE_BOUNCE_RATE = 0.05;

/** The reason to pause a campaign automatically, or null. */
export function autoPauseReason(c: { sentCount: number; bounceCount: number; complaintCount: number }): string | null {
  if (c.sentCount <= 0) return null;
  if (c.complaintCount / c.sentCount > AUTO_PAUSE_COMPLAINT_RATE) {
    return `Paused automatically: ${c.complaintCount} spam complaint${c.complaintCount === 1 ? '' : 's'} out of ${c.sentCount} sent. Check the list before resuming.`;
  }
  if (c.bounceCount / c.sentCount > AUTO_PAUSE_BOUNCE_RATE) {
    return `Paused automatically: ${c.bounceCount} bounce${c.bounceCount === 1 ? '' : 's'} out of ${c.sentCount} sent. Check the list before resuming.`;
  }
  return null;
}

/**
 * Spreads `count` sends over Melbourne days under a daily cap: day 0 is today's window (or the next window when
 * today's has closed). Returns the planned send time of each message and the per-day totals.
 */
export function spreadByDailyCap(count: number, cap: number, now: Date, window: SendWindow): { times: Date[]; schedule: Array<{ date: string; count: number }> } {
  const times: Date[] = [];
  const schedule: Array<{ date: string; count: number }> = [];
  let slot = nextSendSlot(now, window);
  let remaining = count;
  const perDay = Math.max(1, cap);
  while (remaining > 0) {
    const n = Math.min(perDay, remaining);
    for (let i = 0; i < n; i++) times.push(slot);
    schedule.push({ date: melbourneDateOf(slot), count: n });
    remaining -= n;
    slot = nextDayWindowStart(slot, window);
  }
  return { times, schedule };
}

// ---------------------------------------------------------------------------------------------------------
// Request schemas for the API routes (design §7)
// ---------------------------------------------------------------------------------------------------------

const Subject = z.string().max(200);
const Body = z.string().max(20_000);

export const CreateEmailMessageSchema = z.object({
  customerId: z.string().min(1),
  templateId: z.string().min(1).nullable().optional(),
  messageClass: z.enum(['transactional_factual', 'campaign']),
  subject: Subject,
  bodyMarkdown: Body,
});
export const UpdateEmailMessageSchema = z.object({ subject: Subject.optional(), bodyMarkdown: Body.optional() });
export const ApproveEmailSchema = z.object({ scheduledFor: z.string().datetime({ offset: true }).nullable().optional() });
export const ApproveBatchSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(100) });
export const SendAgainSchema = z.object({ confirm: z.literal(true) });
export const LintRequestSchema = z.object({ messageClass: MessageClassSchema, subject: Subject, bodyMarkdown: Body, customerId: z.string().min(1).nullable().optional() });
export const CreateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  purpose: z.enum(TEMPLATE_PURPOSES),
  messageClass: MessageClassSchema,
  subject: Subject,
  bodyMarkdown: Body,
});
export const UpdateTemplateSchema = CreateTemplateSchema.partial().extend({ enabled: z.boolean().optional() });
export const AUTOMATION_NAMES = ['follow_up', 'review_request'] as const;
export type AutomationName = (typeof AUTOMATION_NAMES)[number];
export const UpdateAutomationSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['approve_each', 'send_automatically']),
  templateId: z.string().min(1).nullable(),
  delayHours: z.number().int().min(1).max(72),
  dailyCap: z.number().int().min(1).max(100),
});
const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const UpdateEmailSettingsSchema = z
  .object({
    senderName: z.string().max(80),
    replyTo: z.string().max(120),
    consentWording: z.string().min(20).max(600),
    allowInferredConsent: z.boolean(),
    sendWindow: z.object({ start: TimeOfDay, end: TimeOfDay }).refine((w) => w.start < w.end, 'The window must start before it ends.'),
    dailyCommercialCap: z.number().int().min(1).max(500),
    squareSends: z.object({ confirmations: z.boolean().nullable(), reminders: z.boolean().nullable(), feedbackOrReviews: z.boolean().nullable() }),
    webhooksAttested: z.boolean(),
  })
  .partial();
export const AudienceSchema = z.object({ lastVisitWithinDays: z.union([z.literal(90), z.literal(180), z.literal(365), z.null()]).default(null) });
export const CreateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  templateId: z.string().min(1).nullable().optional(),
  subject: Subject,
  bodyMarkdown: Body,
  audience: AudienceSchema.default({ lastVisitWithinDays: null }),
});
export const UpdateCampaignSchema = CreateCampaignSchema.partial();
export const AudiencePreviewSchema = z.object({ cursor: z.string().max(100).nullable().optional(), search: z.string().max(120).optional() });
export const ApproveCampaignSchema = z.object({ audienceHash: z.string().min(8).max(128), confirmConsent: z.literal(true) });
export const CreateCustomerSchema = z.object({
  givenName: z.string().trim().min(1).max(80),
  familyName: z.string().trim().max(80).optional(),
  email: z.string().trim().max(254).refine(isValidEmailAddress, "This email address doesn't look valid."),
  phone: z.string().trim().max(40).optional(),
});
export const UpdateCustomerSchema = z.object({
  givenName: z.string().trim().min(1).max(80).optional(),
  familyName: z.string().trim().max(80).optional(),
  email: z.string().trim().max(254).refine(isValidEmailAddress, "This email address doesn't look valid.").optional(),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().max(2000).optional(),
});
export const RecordConsentSchema = z.object({
  method: z.enum(['in_person_device', 'verbal_owner_recorded']),
  wordingHash: z.string().min(16).max(128),
  clientConfirmed: z.literal(true),
  note: z.string().max(500).optional(),
});
export const RecordUnsubscribeSchema = z.object({ method: z.enum(['in_person', 'phone', 'reply_email', 'owner_other']), note: z.string().max(500).optional() });
export const ReviewOptOutSchema = z.object({ value: z.boolean() });
export const LiftSuppressionSchema = z.object({ note: z.string().trim().min(3).max(500), confirm: z.string().max(80) });
/** The typed confirmation needed to lift a spam-complaint suppression. */
export const LIFT_COMPLAINT_CONFIRMATION = 'they asked to hear from us again';

/** Every variable name, for the editor's chips. */
export const EMAIL_VARIABLE_CHIPS = EMAIL_VARIABLES;

// ---------------------------------------------------------------------------------------------------------
// Built-in templates (design §4.5) and the campaign audience (design §4.4)
// ---------------------------------------------------------------------------------------------------------

/** One built-in template. Fixed ids so seeding is idempotent; the owner may edit them (never delete). */
export interface BuiltInTemplate {
  id: string;
  name: string;
  purpose: TemplatePurpose;
  messageClass: MessageClass;
  subject: string;
  bodyMarkdown: string;
}

/** The neutral built-in templates, seeded on first use. */
export const DEFAULT_EMAIL_TEMPLATES: readonly BuiltInTemplate[] = [
  {
    id: 'builtin-review-request',
    name: 'Google review request',
    purpose: 'review_request',
    messageClass: 'review_request',
    subject: 'A quick favour from {{business_name}}',
    bodyMarkdown:
      "Hi {{first_name}},\n\nThanks for coming in to {{business_name}} on {{visit_date}}. If you have a minute, we'd appreciate an honest review on Google. Every review helps people nearby find the right barber.\n\n[Leave a Google review]({{review_link}})\n\nThanks,\n{{sender_name}}",
  },
  {
    id: 'builtin-aftercare',
    name: 'Aftercare note',
    purpose: 'follow_up',
    messageClass: 'transactional_factual',
    subject: 'Looking after your cut',
    bodyMarkdown:
      'Hi {{first_name}},\n\nThanks for coming in on {{visit_date}}. A few tips to keep your cut looking sharp:\n\n- Wash and condition as usual; towel-dry gently.\n- Use a small amount of product and work it through from the back.\n- Most cuts hold their shape for three to four weeks.\n\nCheers,\n{{sender_name}}',
  },
  {
    id: 'builtin-thanks-rebook',
    name: 'Thanks and rebook',
    purpose: 'follow_up',
    messageClass: 'campaign',
    subject: 'Thanks for coming in, {{first_name}}',
    bodyMarkdown:
      "Hi {{first_name}},\n\nThanks for choosing {{business_name}}. When you're ready for your next cut, you can book here:\n\n[Book your next visit]({{booking_link}})\n\nSee you soon,\n{{sender_name}}",
  },
];

/** The built-in template used by an automation when the owner has not chosen one. */
export const DEFAULT_AUTOMATION_TEMPLATE_IDS = { follow_up: 'builtin-aftercare', review_request: 'builtin-review-request' } as const;

/** Why a client is left out of a campaign (shown next to each left-out row). */
export const AUDIENCE_EXCLUSIONS = ['no_permission', 'unsubscribed', 'suppressed', 'no_email', 'deleted', 'no_recent_visit'] as const;
export type AudienceExclusion = (typeof AUDIENCE_EXCLUSIONS)[number];
export const AUDIENCE_EXCLUSION_LABELS: Record<AudienceExclusion, string> = {
  no_permission: 'No permission recorded',
  unsubscribed: 'Unsubscribed',
  suppressed: 'Bounced or spam complaint',
  no_email: 'No email',
  deleted: 'Deleted client',
  no_recent_visit: 'No visit in the chosen period',
};

/** A campaign's audience filter: clients with email permission, optionally only recent visitors. */
export type CampaignAudienceFilter = { lastVisitWithinDays: 90 | 180 | 365 | null };

/** The facts about one client the audience rule reads. */
export interface AudienceCandidate {
  customerId: string;
  deleted: boolean;
  email: string | null;
  consent: ConsentState;
  activeSuppressions: readonly Pick<SuppressionFact, 'scope'>[];
  squareEmailUnsubscribed: boolean | null;
  lastCompletedVisitAt: Date | null;
}

/** Whether a client receives a campaign, or why not. Same rule for the preview and the send. */
export function classifyAudience(c: AudienceCandidate, audience: { lastVisitWithinDays: number | null }, now: Date): { included: true } | { included: false; reason: AudienceExclusion } {
  if (c.deleted) return { included: false, reason: 'deleted' };
  if (!c.email || !isValidEmailAddress(c.email)) return { included: false, reason: 'no_email' };
  if (c.activeSuppressions.some((s) => s.scope === 'all')) return { included: false, reason: 'suppressed' };
  if (c.activeSuppressions.some((s) => s.scope === 'marketing') || c.consent.status === 'withdrawn' || c.squareEmailUnsubscribed === true) return { included: false, reason: 'unsubscribed' };
  if (!consentAllowsMarketing(c.consent)) return { included: false, reason: 'no_permission' };
  if (audience.lastVisitWithinDays !== null) {
    const since = now.getTime() - audience.lastVisitWithinDays * 24 * 3600_000;
    if (!c.lastCompletedVisitAt || c.lastCompletedVisitAt.getTime() < since) return { included: false, reason: 'no_recent_visit' };
  }
  return { included: true };
}
