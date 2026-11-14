import { Music } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { musicStatusEntries } from '@/lib/integrations/music';
import type { IntegrationCardsProps } from './types';

/** Plain state words for the two music cards (neither has an account to connect). */
const STATE_WORDS: Record<string, { label: string; tone: 'neutral' | 'info' }> = {
  spotify_reference: { label: 'Links only · no account needed', tone: 'info' },
  music_catalogue: { label: 'Not available', tone: 'neutral' },
};

/**
 * Settings → Integrations cards of the music module: Spotify references (link-only, no account) and the music library
 * connection (not available: tracks are downloaded from the owner's library and uploaded with their licence). Both
 * are read-only; neither can post or change anything. Cards already in the shared list are not repeated.
 */
export function MusicIntegrationCards({ integrations }: IntegrationCardsProps) {
  const entries = musicStatusEntries().filter((e) => !integrations.some((i) => i.id === e.id));
  if (entries.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Music" description="Music for your videos comes from tracks you upload with their licence details." />
      <CardBody className="min-w-0 [overflow-wrap:anywhere]">
        <ul className="grid gap-3 md:grid-cols-2">
          {entries.map((e) => {
            const words = STATE_WORDS[e.id] ?? { label: 'Not available', tone: 'neutral' as const };
            return (
              <li key={e.id} className="rounded-xl border border-charcoal-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Music className="size-5 shrink-0 text-charcoal-400" aria-hidden="true" />
                    <h3 className="text-sm font-semibold text-charcoal-900">{e.name}</h3>
                  </div>
                  <Badge tone={words.tone}>{words.label}</Badge>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-charcoal-600">{e.message}</p>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
