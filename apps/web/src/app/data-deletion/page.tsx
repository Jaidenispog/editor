import { LegalDocument, legalMetadata } from '../privacy/legal-document';

export const metadata = legalMetadata('dataDeletion');

/** Public "Deleting your information" page (Meta User Data Deletion URL). 404 until the owner publishes it. */
export default function DataDeletionPage() {
  return <LegalDocument kind="dataDeletion" />;
}
