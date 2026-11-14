import type { IntegrationStatus } from '../shared/integration-types.js';
import type { IntegrationBuilder } from './types.js';

/**
 * The music module's read-only status cards. Neither can post or change anything, and neither has an account to
 * connect:
 * - `spotify_reference`: Spotify links kept as the owner's private reference (memo §1). No Spotify account, key or
 *   request is ever involved, so it is "not connected" by design and works without setup.
 * - `music_catalogue`: no music library API is built (memo §2), so it is "not configured" with the manual route.
 */
export function musicStatusEntries(): IntegrationStatus[] {
  return [
    {
      id: 'spotify_reference',
      name: 'Spotify references',
      areas: ['video'],
      configured: true,
      connected: false,
      missingEnv: [],
      message:
        'No Spotify account is needed. Paste Spotify links in Settings → Music → Music references to keep them as your own reference. Spotify links are kept for your own music reference only. They are not licensed for playing in the shop or in your videos.',
      state: 'not_connected',
      liveMode: null,
      verified: false,
    },
    {
      id: 'music_catalogue',
      name: 'Music library connection',
      areas: ['video'],
      configured: false,
      connected: false,
      missingEnv: [],
      message: 'Not available. Download tracks from your business-eligible library and upload them with their licence details in Settings → Music.',
      state: 'not_configured',
      liveMode: null,
      verified: false,
    },
  ];
}

/**
 * Integration cards of the music module in the shared status list. Returns nothing for now: the WP0 wording test
 * (apps/web/test/foundations.test.ts) compares the whole list with the Stage A fixture, so new entries would break
 * it. The cards are shown by `settings/_components/integrations/music.tsx` from {@link musicStatusEntries} instead;
 * once that test compares only the Stage A ids, this returns `musicStatusEntries()` (see the handover notes).
 */
export const buildMusicIntegrations: IntegrationBuilder = () => [];
