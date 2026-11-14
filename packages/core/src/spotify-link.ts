/** Kinds of Spotify item a reference can point to. */
export const SPOTIFY_ITEM_TYPES = ['track', 'album', 'playlist', 'artist'] as const;
export type SpotifyItemType = (typeof SPOTIFY_ITEM_TYPES)[number];

/** A pasted Spotify link reduced to what is stored: the canonical URL, the item type and its 22-character id. */
export interface SpotifyLink {
  url: string;
  itemType: SpotifyItemType;
  externalId: string;
}

/** The fixed notice shown above every list of Spotify references (memo §1, UI copy). */
export const SPOTIFY_REFERENCE_NOTICE =
  'Spotify links are kept for your own music reference only. They are not licensed for playing in the shop or in your videos.';

/** Message for anything that is not a Spotify link. */
export const NOT_A_SPOTIFY_LINK = "That isn't a Spotify link.";

const ID = /^[A-Za-z0-9]{22}$/;
const isType = (s: string | undefined): s is SpotifyItemType => (SPOTIFY_ITEM_TYPES as readonly string[]).includes(s ?? '');

/**
 * Parses `https://open.spotify.com/[intl-xx/]<type>/<id>` (query strings and fragments dropped) or a
 * `spotify:<type>:<id>` URI. Only the exact host `open.spotify.com` over https is accepted, so lookalike hosts such
 * as `open.spotify.com.evil.com` are refused. Nothing is fetched: the app never calls Spotify (memo §1).
 */
export function parseSpotifyLink(input: string): SpotifyLink | null {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 500) return null;
  let itemType: string | undefined;
  let externalId: string | undefined;
  if (/^spotify:/i.test(raw)) {
    const parts = raw.split(':');
    if (parts.length !== 3) return null;
    itemType = parts[1]?.toLowerCase();
    externalId = parts[2];
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'open.spotify.com' || url.username || url.password || url.port) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] && /^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0])) segments.shift();
    if (segments.length !== 2) return null;
    itemType = segments[0]?.toLowerCase();
    externalId = segments[1];
  }
  if (!isType(itemType) || !externalId || !ID.test(externalId)) return null;
  return { url: `https://open.spotify.com/${itemType}/${externalId}`, itemType, externalId };
}

/** The official embed address for a stored reference (shown unmodified, no autoplay parameter). */
export function spotifyEmbedUrl(link: Pick<SpotifyLink, 'itemType' | 'externalId'>): string {
  return `https://open.spotify.com/embed/${link.itemType}/${link.externalId}`;
}
