import type { Metadata } from 'next';
import { SectionOverview } from '@/components/app/section-overview';

export const metadata: Metadata = { title: 'Publishing' };

/** Publishing section: Instagram and TikTok status and what is needed to post from the app. */
export default function PublishingPage() {
  return (
    <SectionOverview
      eyebrow="Publishing"
      title="Publishing"
      description="Post finished edits to Instagram and TikTok with a caption and cover, now or on a schedule — once your accounts are connected."
      area="publishing"
      features={[
        'Publish an exported edit as an Instagram Reel, with caption and cover frame.',
        'Send an edit to your TikTok drafts so you can add sounds and post from the TikTok app.',
        'Check the music licence before anything leaves the app, and block platforms it does not cover.',
        'Until accounts are connected: download the 1080×1920 export and post it from your phone.',
      ]}
      requirements={[
        'An Instagram professional (Business or Creator) account linked to a Facebook Page.',
        'A Meta developer app (META_APP_ID and META_APP_SECRET on the server).',
        'A TikTok developer app (TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET) if you want TikTok drafts.',
      ]}
    />
  );
}
