/**
 * The email linter (email design §3.3). Pure and browser-safe: the editor runs it live, the API runs it on every
 * template save, draft edit and approval, and the worker runs it again just before sending. Errors block approval
 * and sending; warnings are shown but do not block.
 *
 * Word lists are case-insensitive whole-word matches ("free" blocks a review request; "freedom" does not), each with
 * a plain-English reason the owner sees.
 */

/** The three kinds of email the app sends (memo §8 "Message classes"). */
export const MESSAGE_CLASSES = ['transactional_factual', 'review_request', 'campaign'] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];

/** Variables a template may use, written `{{name}}`. */
export const EMAIL_VARIABLES = ['first_name', 'business_name', 'visit_date', 'service_name', 'sender_name', 'review_link', 'booking_link'] as const;
export type EmailVariable = (typeof EMAIL_VARIABLES)[number];
/** Variables that stand for a link and may be used as a link target: `[text]({{review_link}})`. */
export const LINK_VARIABLES = ['review_link', 'booking_link'] as const;

/** One lint finding. `code` is stable for tests; `message` is plain English for the owner. */
export interface LintIssue {
  code: string;
  message: string;
  /** The words that triggered it, when a word list matched. */
  match?: string;
}

/** Lint outcome: errors block approval and sending; warnings do not. */
export interface LintResult {
  errors: LintIssue[];
  warnings: LintIssue[];
}

export const SUBJECT_MAX = 120;
export const BODY_MAX = 10_000;
export const LINKS_WARNING_OVER = 3;

/** A word-list entry: a regular-expression source matched as a whole word, case-insensitive. */
interface WordRule {
  pattern: string;
  message: string;
}

const FACTUAL_PROMO_MESSAGE = 'Information-only emails must not promote anything (offers, discounts, bookings). Choose "Marketing" if this is an offer.';
const FACTUAL_REMINDER_MESSAGE = 'Square already sends booking confirmations and reminders, so this app never sends them.';
const INCENTIVE_MESSAGE = "Google and the ACCC don't allow rewards for reviews, so review requests can't offer anything in return.";
const SELECTIVE_MESSAGE = 'Review requests must ask every client the same way, without steering towards good reviews or away from Google.';
const TARGET_MESSAGE = "Review requests can't mention staff targets or quotas.";

/** Promotional words that turn a factual email into a commercial one. */
const FACTUAL_PROMO: WordRule[] = [
  'offer',
  'offers',
  'discount',
  'discounts',
  '\\d+\\s*% off',
  '% off',
  'special',
  'specials',
  'deal',
  'deals',
  'promo',
  'promotion',
  'sale',
  'book now',
  'rebook',
  'voucher',
  'vouchers',
  'gift card',
  'gift cards',
  'free',
  'limited time',
  'refer a friend',
].map((pattern) => ({ pattern, message: FACTUAL_PROMO_MESSAGE }));

/** Reminder or confirmation wording (Square already sends these). */
const FACTUAL_REMINDER: WordRule[] = ['reminder', 'reminders', 'your appointment is (on|at|tomorrow)', 'see you (tomorrow|on)', 'confirm your'].map((pattern) => ({
  pattern,
  message: FACTUAL_REMINDER_MESSAGE,
}));

/** Incentive words in review requests. */
const REVIEW_INCENTIVES: WordRule[] = ['discount', 'discounts', '% off', '\\d+\\s*% off', 'voucher', 'vouchers', 'gift', 'gifts', 'free', 'prize', 'prizes', 'win', 'draw', 'reward', 'rewards', 'points', 'credit', 'in exchange', 'in return'].map(
  (pattern) => ({ pattern, message: INCENTIVE_MESSAGE }),
);

/** Selective ("gating") or diverting wording in review requests. */
const REVIEW_SELECTIVE: WordRule[] = [
  '5 star',
  '5 stars',
  'five star',
  'five stars',
  '5-star',
  'positive review',
  'positive reviews',
  'good review',
  'great review',
  'if you (were|are) happy',
  'if you enjoyed',
  'if you liked',
  'if you loved',
  "if you('re| are) satisfied",
  'unhappy',
  'not happy',
  'not satisfied',
  'contact us first',
  'let us know first',
  'before (leaving|posting)',
].map((pattern) => ({ pattern, message: SELECTIVE_MESSAGE }));

/** Staff-target wording in review requests. */
const REVIEW_TARGETS: WordRule[] = ['help .* reach', 'target', 'targets', 'quota', 'quotas'].map((pattern) => ({ pattern, message: TARGET_MESSAGE }));

/** Builds a whole-word, case-insensitive matcher (letters and digits count as word characters). */
function wholeWord(pattern: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'iu');
}

const compiled = new Map<string, RegExp>();
function matcher(pattern: string): RegExp {
  let re = compiled.get(pattern);
  if (!re) {
    re = wholeWord(pattern);
    compiled.set(pattern, re);
  }
  return re;
}

/** Runs a word list over the text; returns one issue per distinct reason (with the first match). */
function scan(text: string, rules: WordRule[], code: string): LintIssue[] {
  const out: LintIssue[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.message)) continue;
    const m = matcher(rule.pattern).exec(text);
    if (m) {
      seen.add(rule.message);
      out.push({ code, message: rule.message, match: m[0] });
    }
  }
  return out;
}

const VARIABLE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const LINK_RE = /\[([^\]\n]*)\]\(([^)\s]*)\)/g;
const HTML_TAG_RE = /<\s*\/?\s*[A-Za-z!][^>]*>/;

/** Every `{{name}}` used in the text. */
export function variablesIn(text: string): string[] {
  return [...text.matchAll(VARIABLE_RE)].map((m) => (m[1] ?? '').trim());
}

/** Every Markdown link target `[text](target)` in the text. */
export function linkTargetsIn(text: string): string[] {
  return [...text.matchAll(LINK_RE)].map((m) => m[2] ?? '');
}

/** True when a link target is a link variable such as `{{review_link}}`. */
export function isLinkVariable(target: string): boolean {
  const m = /^\{\{\s*([a-z_]+)\s*\}\}$/.exec(target);
  return Boolean(m && (LINK_VARIABLES as readonly string[]).includes(m[1] ?? ''));
}

/** True when a link target is allowed: an `https://` address or a link variable. */
export function isAllowedLinkTarget(target: string): boolean {
  if (isLinkVariable(target)) return true;
  try {
    const u = new URL(target);
    return u.protocol === 'https:' && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/** Lints one email (subject and Markdown body) for its class. */
export function lintEmail(input: { messageClass: MessageClass; subject: string; bodyMarkdown: string }): LintResult {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const subject = input.subject ?? '';
  const body = input.bodyMarkdown ?? '';
  const both = `${subject}\n${body}`;

  if (!subject.trim()) errors.push({ code: 'subject_empty', message: 'Add a subject.' });
  if (subject.length > SUBJECT_MAX) errors.push({ code: 'subject_long', message: `Keep the subject to ${SUBJECT_MAX} characters or fewer.` });
  if (!body.trim()) errors.push({ code: 'body_empty', message: 'Write the email before saving it.' });
  if (body.length > BODY_MAX) errors.push({ code: 'body_long', message: `Keep the email under ${BODY_MAX.toLocaleString('en-AU')} characters.` });

  const unknown = [...new Set(variablesIn(both).filter((v) => !(EMAIL_VARIABLES as readonly string[]).includes(v)))];
  if (unknown.length) {
    errors.push({ code: 'unknown_variable', message: `Unknown ${unknown.length === 1 ? 'variable' : 'variables'}: ${unknown.map((v) => `{{${v}}}`).join(', ')}. Use the variable buttons instead.`, match: unknown.join(', ') });
  }
  const targets = linkTargetsIn(body);
  const badLinks = targets.filter((t) => !isAllowedLinkTarget(t));
  if (badLinks.length) errors.push({ code: 'bad_link', message: 'Links must start with https:// (or use a link variable such as {{review_link}}).', match: badLinks[0] ?? '' });
  if (HTML_TAG_RE.test(both)) errors.push({ code: 'raw_html', message: "HTML isn't allowed. Use **bold**, *italic*, - lists and [text](https://…) links." });

  const letters = subject.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 6 && letters === letters.toUpperCase()) warnings.push({ code: 'subject_caps', message: 'A subject in capitals can look like spam.' });
  if (targets.length > LINKS_WARNING_OVER) warnings.push({ code: 'many_links', message: 'More than three links can look like spam.' });

  const used = new Set(variablesIn(both));
  switch (input.messageClass) {
    case 'transactional_factual': {
      if (targets.length || used.has('review_link') || used.has('booking_link') || /https?:\/\//i.test(body)) {
        errors.push({ code: 'factual_link', message: 'Information-only emails cannot contain links. Use "Marketing" for anything with a link.' });
      }
      errors.push(...scan(both, FACTUAL_PROMO, 'factual_promotional'));
      errors.push(...scan(both, FACTUAL_REMINDER, 'factual_reminder'));
      break;
    }
    case 'review_request': {
      if (!used.has('review_link')) errors.push({ code: 'review_link_missing', message: 'A review request needs the {{review_link}} variable.' });
      errors.push(...scan(both, REVIEW_INCENTIVES, 'review_incentive'));
      errors.push(...scan(both, REVIEW_SELECTIVE, 'review_selective'));
      errors.push(...scan(both, REVIEW_TARGETS, 'review_target'));
      if (used.has('booking_link')) warnings.push({ code: 'review_booking_link', message: 'Keep review requests about the review only (remove the booking link).' });
      break;
    }
    case 'campaign': {
      if (!used.has('first_name')) warnings.push({ code: 'campaign_no_name', message: 'Tip: {{first_name}} makes the email feel personal.' });
      break;
    }
  }
  return { errors, warnings };
}
