import type { IntegrationStatus } from '../shared/integration-types.js';
import type { IntegrationBuilder } from './types.js';

/**
 * The music module's read-only status cards. Neither can post or change anything, and neither has an account to
 * connect:
 * - `spotify_reference`: Spotify links kept as the owner's private reference (memo §1). No Spotify account, key or
 *   request is ever involved, so it is "not connected" by design, works without setup, and its pill says so
 *   ("Links only · no account needed") instead of offering to connect.
 * - `music_catalogue`: no music library API is built (memo §2), so it is "unavailable" (a neutral "Not available",
 *   not "Needs setup": no server setting would change it) and the text gives the manual route.
 */

/** Pill words of the Spotify references card: there is nothing to connect. */
export const SPOTIFY_REFERENCE_STATE_LABEL = 'Links only · no account needed';
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
      stateLabel: SPOTIFY_REFERENCE_STATE_LABEL,
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
      message:
        'Download tracks from your business-eligible library and upload them with their licence details in Settings → Music library. The app does not connect to music libraries, so there is nothing to set up here.',
      state: 'unavailable',
      liveMode: null,
      verified: false,
    },
  ];
}

/**
 * Integration cards of the music module in the shared status list (GET /api/integrations/status and the dashboard).
 * `settings/_components/integrations/music.tsx` skips ids already in that list, so each card shows once.
 */
export const buildMusicIntegrations: IntegrationBuilder = () => musicStatusEntries();
