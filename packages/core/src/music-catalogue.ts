import type { MusicLicence } from './music.js';

/** One track a catalogue search returned. */
export interface CatalogueTrack {
  providerTrackId: string;
  title: string;
  artist: string;
  durationSec: number;
  bpm: number | null;
  previewUrl: string | null;
}

/**
 * A licensed music catalogue (preferences/music design §6.4). Interface only: no adapter, environment variable or
 * route ships, because production catalogue keys need sales or enterprise agreements (memo §2: "no library API is
 * built in Phase 1"). The owner downloads tracks from a business-eligible subscription and uploads them with their
 * licence passport instead. `music_tracks.source = 'catalogue'`, `catalogue_provider` and `catalogue_track_id`
 * already exist for a later adapter.
 */
export interface MusicCatalogueProvider {
  /** e.g. 'soundstripe'. */
  readonly id: string;
  readonly name: string;
  /** Business-eligible plan confirmed in writing by the owner (memo §2); the adapter refuses to run otherwise. */
  search(
    query: { text?: string; genres?: string[]; moods?: string[]; minDurationSec?: number },
    opts?: { signal?: AbortSignal },
  ): Promise<CatalogueTrack[]>;
  /** The licence passport this provider grants for one track under the owner's plan (the owner still confirms it). */
  licenceFor(providerTrackId: string): Promise<Omit<MusicLicence, 'confirmedByOwnerAt'>>;
  /** Downloads the licensed file into the worker temp dir (never a watermarked preview). */
  download(providerTrackId: string, destPath: string, opts?: { signal?: AbortSignal }): Promise<{ mimeType: string; byteSize: number }>;
}
