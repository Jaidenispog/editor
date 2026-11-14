import { LegalDocument, legalMetadata } from './legal-document';

export const metadata = legalMetadata('privacy');

/** Public privacy policy (Meta Privacy Policy URL, Google consent screen, Spotify embed notice). 404 until published. */
export default function PrivacyPage() {
  return <LegalDocument kind="privacy" />;
}
