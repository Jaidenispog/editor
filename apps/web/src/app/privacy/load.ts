import 'server-only';
import { notFound } from 'next/navigation';
import { publishedLegalPage, type LegalPageKind } from '@studio/core';
import { getSettings } from '@/lib/settings';

/**
 * The published text of a legal page plus the business name, or a 404 (`notFound()`) while the owner has not
 * published it. Drafts are never returned.
 */
export async function loadPublishedLegalPage(kind: LegalPageKind): Promise<{ businessName: string; title: string; body: string; publishedAt: string }> {
  const settings = await getSettings();
  const page = publishedLegalPage(settings.legal, kind);
  if (!page) notFound();
  return { businessName: settings.brand.businessName, ...page };
}
