import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { validateReviewLink } from '@studio/core';
import { integrationPill } from '@/components/app/integration-pill';
import { GoogleRatingCard, ReviewLinkCard } from '@/components/reviews/review-cards';
import { ReviewsWorkspace, type ReviewsData } from '@/components/reviews/review-requests';
import { PageHeader } from '@/components/ui/page-header';
import { getEmailStatus, listClients, listTemplates } from '@/lib/email';
import { getIntegrationStatuses } from '@/lib/integrations';
import { getPlacesState, listReviewRequests } from '@/lib/reviews';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { reviewAutomationNotice } from '@/lib/shared/review-automation';

export const metadata: Metadata = { title: 'Reviews' };
export const dynamic = 'force-dynamic';

/**
 * Reviews (design §9.1): the review link, the Google rating (only from Google, labelled with its source and time),
 * requests with their status, and the automatic-requests switch. Every client is asked the same way, after a
 * genuinely completed appointment; requests are never matched to reviews.
 */
export default async function ReviewsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const isOwner = user.role === 'owner';
  const settings = await getSettings();
  const link = settings.business.googleReviewLink;
  const [places, status, integrations] = await Promise.all([getPlacesState(), getEmailStatus(), getIntegrationStatuses()]);
  const gbp = integrations.find((i) => i.id === 'google_business_profile');
  const gbpPill = gbp ? integrationPill(gbp) : { status: 'not_configured', label: 'Needs setup' };
  let data: ReviewsData = {
    requests: [],
    counts: { sentThisMonth: 0, openedThisMonth: 0 },
    clients: [],
    templates: [],
    automation: settings.reviews.automation,
    automationBlocked: null,
    emailReady: status.state === 'connected' || status.state === 'awaiting_approval',
    googleProfile: { state: gbpPill.status, label: gbpPill.label, message: gbp?.message ?? 'Not set up.' },
  };
  if (isOwner) {
    const [requests, clients, templates] = await Promise.all([listReviewRequests(), listClients({}), listTemplates()]);
    data = {
      ...data,
      requests: requests.items,
      counts: requests.counts,
      clients: clients.items,
      templates: templates.items,
      automationBlocked: reviewAutomationNotice({
        squareAsksForFeedback: settings.email.squareSends.feedbackOrReviews === true,
        automationEnabled: settings.reviews.automation.enabled,
        reviewLinkValid: validateReviewLink(link).valid,
      }),
    };
  }
  return (
    <>
      <PageHeader eyebrow="Reviews" title="Reviews" description="Ask every client after a completed appointment, the same way. Your Google rating appears here only when Google provides it." />
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <ReviewLinkCard initialUrl={link} valid={validateReviewLink(link).valid} googleUri={places.state === 'connected' ? places.writeAReviewUri : null} canEdit={isOwner} />
        <GoogleRatingCard initial={places} canEdit={isOwner} />
      </div>
      <Suspense>
        <ReviewsWorkspace data={data} canEdit={isOwner} />
      </Suspense>
    </>
  );
}
