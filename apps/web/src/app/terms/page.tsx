import { LegalDocument, legalMetadata } from '../privacy/legal-document';

export const metadata = legalMetadata('terms');

/** Public terms of use. 404 until the owner publishes them. */
export default function TermsPage() {
  return <LegalDocument kind="terms" />;
}
