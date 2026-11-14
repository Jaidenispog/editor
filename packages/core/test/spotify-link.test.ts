import { describe, expect, it } from 'vitest';
import { parseSpotifyLink, spotifyEmbedUrl } from '../src/spotify-link.js';

const ID = '4uLU6hMCjMI75M1A2tKUQC';

describe('parseSpotifyLink', () => {
  it.each(['track', 'album', 'playlist', 'artist'] as const)('reads a %s link', (type) => {
    expect(parseSpotifyLink(`https://open.spotify.com/${type}/${ID}`)).toEqual({ url: `https://open.spotify.com/${type}/${ID}`, itemType: type, externalId: ID });
  });

  it('drops query strings, fragments and the intl path, and reads spotify: URIs', () => {
    expect(parseSpotifyLink(`https://open.spotify.com/intl-de/track/${ID}?si=abc123&utm_source=copy#x`)?.url).toBe(`https://open.spotify.com/track/${ID}`);
    expect(parseSpotifyLink(`https://open.spotify.com/intl-pt-br/album/${ID}`)?.itemType).toBe('album');
    expect(parseSpotifyLink(`  spotify:playlist:${ID}  `)).toEqual({ url: `https://open.spotify.com/playlist/${ID}`, itemType: 'playlist', externalId: ID });
  });

  it.each([
    `https://open.spotify.com.evil.com/track/${ID}`,
    `https://evil.com/open.spotify.com/track/${ID}`,
    `https://notopen.spotify.com/track/${ID}`,
    `https://spotify.com/track/${ID}`,
    `http://open.spotify.com/track/${ID}`,
    `https://user@open.spotify.com/track/${ID}`,
    `https://open.spotify.com:8443/track/${ID}`,
    `https://open.spotify.com/episode/${ID}`,
    `https://open.spotify.com/track/${ID}/extra`,
    `https://open.spotify.com/track/short`,
    `spotify:track:${ID}:extra`,
    'javascript:alert(1)',
    'not a link',
    '',
  ])('refuses %s', (input) => {
    expect(parseSpotifyLink(input)).toBeNull();
  });

  it('builds the official embed address without autoplay', () => {
    expect(spotifyEmbedUrl({ itemType: 'track', externalId: ID })).toBe(`https://open.spotify.com/embed/track/${ID}`);
  });
});
