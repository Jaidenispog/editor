import { z } from 'zod';

/**
 * Owner-edited public legal pages (`/privacy`, `/terms`, `/data-deletion`). Meta's app review (Privacy Policy and
 * User Data Deletion URLs), Google's OAuth consent screen and the Spotify embed rules all need public pages like
 * these. Nothing is served until the owner publishes a page; the suggested starting text is only a draft for the
 * owner to review, never legal advice, and is never published automatically.
 */

export const LEGAL_PAGE_KINDS = ['privacy', 'terms', 'dataDeletion'] as const;
export const LegalPageKindSchema = z.enum(LEGAL_PAGE_KINDS);
export type LegalPageKind = z.infer<typeof LegalPageKindSchema>;

/** Public path and heading of each legal page. */
export const LEGAL_PAGES: Record<LegalPageKind, { path: string; title: string }> = {
  privacy: { path: '/privacy', title: 'Privacy policy' },
  terms: { path: '/terms', title: 'Terms of use' },
  dataDeletion: { path: '/data-deletion', title: 'Deleting your information' },
};

/** Longest text a legal page may hold (plain text, paragraphs separated by blank lines). */
export const LEGAL_TEXT_MAX = 20_000;

export const LegalPageSchema = z.object({
  /** The owner's working text. Empty means the editor offers the suggested draft. */
  draft: z.string().max(LEGAL_TEXT_MAX).default(''),
  /** The text the public page shows; only changes when the owner presses Publish. */
  published: z.string().max(LEGAL_TEXT_MAX).default(''),
  /** When the owner last published (ISO 8601). Null means the public page answers "not found". */
  publishedAt: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type LegalPage = z.infer<typeof LegalPageSchema>;

const EMPTY_PAGE: LegalPage = { draft: '', published: '', publishedAt: null };

export const LegalSettingsSchema = z.object({
  privacy: LegalPageSchema.default(EMPTY_PAGE),
  terms: LegalPageSchema.default(EMPTY_PAGE),
  dataDeletion: LegalPageSchema.default(EMPTY_PAGE),
});
export type LegalSettings = z.infer<typeof LegalSettingsSchema>;

export const DEFAULT_LEGAL_SETTINGS: LegalSettings = LegalSettingsSchema.parse({});

/** Business details used to fill in the suggested drafts. */
export interface LegalDraftFacts {
  businessName: string;
  addressLine: string;
  suburb: string;
  state: string;
  postcode: string;
  email: string;
  phone: string;
  website: string;
}

function contactSentence(f: LegalDraftFacts): string {
  const ways: string[] = [];
  if (f.email.trim()) ways.push(`email ${f.email.trim()}`);
  if (f.phone.trim()) ways.push(`call ${f.phone.trim()}`);
  const place = [f.addressLine, f.suburb, f.state, f.postcode].map((s) => s.trim()).filter(Boolean).join(' ');
  if (place) ways.push(`visit us at ${place}`);
  if (ways.length === 0) return 'Ask us in the studio.';
  if (ways.length === 1) return `Please ${ways[0]}.`;
  return `Please ${ways.slice(0, -1).join(', ')} or ${ways[ways.length - 1]}.`;
}

/**
 * A plain starting draft for one legal page, filled in from the business details. The owner must read and adjust
 * it before publishing (the editor says "Review before publishing"); it describes only what this app actually does.
 */
export function suggestedLegalDraft(kind: LegalPageKind, facts: LegalDraftFacts): string {
  const name = facts.businessName.trim() || 'our studio';
  const contact = contactSentence(facts);
  switch (kind) {
    case 'privacy':
      return [
        `This page explains how ${name} handles personal information.`,
        'What we collect\nYour name, email address and phone number; your appointment history from our booking system (Square); whether you have agreed to receive emails from us; and photos or videos taken in the studio when you have agreed to them.',
        'How we use it\nTo manage your appointments, to send you messages you asked for or agreed to, to ask for a review after an appointment you attended, and to share haircut videos on our social media only with your permission.',
        'Who helps us\nWe use service providers to run the studio: our booking and payments system (Square), an email delivery service, our hosting and storage provider, and social media platforms when we post. Some of them store information outside Australia.',
        'Marketing emails\nWe only send marketing emails if you have agreed to them, and every one has an unsubscribe link that works straight away.',
        `Seeing, correcting or deleting your information\n${contact} We will tell you what we hold and correct or delete it. You can also read how to ask for deletion on our "Deleting your information" page.`,
        'Complaints\nIf you are not happy with how we handled your information, tell us first. You can also contact the Office of the Australian Information Commissioner (oaic.gov.au).',
      ].join('\n\n');
    case 'terms':
      return [
        `These terms apply when you use the website and booking links of ${name}.`,
        'Bookings\nAppointments are booked through our booking system (Square). Its own terms and the booking details shown there apply to your appointment.',
        'Photos and videos\nWe only film or photograph you with your permission, and only post it with your permission. Tell us at any time if you would like a post taken down.',
        'Reviews\nWe may ask you once for an honest review after an appointment you attended. Asking is the same for everyone and is never linked to a discount or reward.',
        `Questions\n${contact}`,
      ].join('\n\n');
    case 'dataDeletion':
      return [
        `You can ask ${name} to delete the personal information we hold about you at any time.`,
        `How to ask\n${contact} Tell us the name and email address you used with us.`,
        'What we delete\nYour contact details, your email history with us and any photos or videos of you that we hold. Information that the law requires us to keep, such as payment records held by our booking system, stays with that system under its own rules.',
        'Instagram and Facebook\nThe studio connects only its own business account to Instagram. We do not collect information from your Instagram or Facebook account. If you have asked us to remove a post that shows you, we delete it from our accounts.',
        'Confirmation\nWe reply to confirm what was deleted.',
      ].join('\n\n');
  }
}

/** The published page for a public route, or null when the owner has not published it (the route answers 404). */
export function publishedLegalPage(legal: LegalSettings, kind: LegalPageKind): { title: string; body: string; publishedAt: string } | null {
  const page = legal[kind];
  if (!page.publishedAt || !page.published.trim()) return null;
  return { title: LEGAL_PAGES[kind].title, body: page.published, publishedAt: page.publishedAt };
}
