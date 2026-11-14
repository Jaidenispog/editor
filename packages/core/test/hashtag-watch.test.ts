import { describe, expect, it } from 'vitest';
import {
  HASHTAG_WEEKLY_LIMIT,
  InstagramHashtagItemDataSchema,
  hashtagBudget,
  hashtagCounts,
  hashtagLimitMessage,
  hashtagProblem,
  instagramCountsLine,
  instagramPostTitle,
  isInstagramPermalink,
  mayQueryHashtag,
  trendLabel,
} from '../src/index.js';

const NOW = new Date('2026-11-14T00:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('Instagram hashtag watch rules', () => {
  it('counts every hashtag queried in the last 7 days, turned off or not', () => {
    expect(hashtagCounts(null, NOW)).toBe(false);
    expect(hashtagCounts(hoursAgo(1), NOW)).toBe(true);
    expect(hashtagCounts(hoursAgo(7 * 24 - 1), NOW)).toBe(true);
    expect(hashtagCounts(hoursAgo(7 * 24), NOW)).toBe(false);
    const watches = [
      { id: 'a', lastQueriedAt: hoursAgo(2) },
      { id: 'b', lastQueriedAt: hoursAgo(200) },
      { id: 'c', lastQueriedAt: null },
      { id: 'd', lastQueriedAt: hoursAgo(30).toISOString() },
    ];
    expect(hashtagBudget(watches, NOW)).toEqual({ used: 2, limit: 30, nextFreeAt: null });
  });

  it('refuses a 31st hashtag until the oldest query is a week old, but lets a counted one be read again', () => {
    const full = Array.from({ length: HASHTAG_WEEKLY_LIMIT }, (_, i) => ({ id: `w${i}`, lastQueriedAt: hoursAgo(i === 0 ? 150 : 5) }));
    const budget = hashtagBudget(full, NOW);
    expect(budget.used).toBe(30);
    expect(budget.nextFreeAt?.toISOString()).toBe(new Date(hoursAgo(150).getTime() + 7 * 86_400_000).toISOString());
    expect(mayQueryHashtag('new', [...full, { id: 'new', lastQueriedAt: null }], NOW)).toEqual({ ok: false, nextFreeAt: budget.nextFreeAt });
    expect(mayQueryHashtag('w3', full, NOW)).toEqual({ ok: true });
    expect(mayQueryHashtag('new', full.slice(1), NOW)).toEqual({ ok: true });
    expect(hashtagLimitMessage('2026-11-18T01:00:00Z')).toBe('Instagram allows 30 hashtags a week. You can add another on 18 Nov 2026.');
  });

  it('accepts plain hashtags and refuses spaces, symbols and popularity words', () => {
    expect(hashtagProblem('#SkinFade')).toBeNull();
    expect(hashtagProblem('barber_melbourne')).toBeNull();
    expect(hashtagProblem('coupedecheveux')).toBeNull();
    expect(hashtagProblem('')).toMatch(/Type a hashtag/);
    expect(hashtagProblem('skin fade')).toMatch(/letters, numbers and underscores/);
    expect(hashtagProblem('fade!')).toMatch(/letters, numbers and underscores/);
    expect(hashtagProblem('a#b')).toMatch(/letters, numbers and underscores/);
    expect(hashtagProblem('x'.repeat(101))).toMatch(/at most 100/);
    expect(hashtagProblem('viralfade')).toMatch(/never labels anything that way/);
    expect(hashtagProblem('TrendingCuts')).toMatch(/never labels anything that way/);
  });

  it('keeps only Instagram https links for posts', () => {
    expect(isInstagramPermalink('https://www.instagram.com/p/abc/')).toBe(true);
    expect(isInstagramPermalink('https://instagram.com/reel/abc/')).toBe(true);
    expect(isInstagramPermalink('http://www.instagram.com/p/abc/')).toBe(false);
    expect(isInstagramPermalink('https://www.instagram.com.evil.com/p/abc/')).toBe(false);
    expect(isInstagramPermalink('https://user:pw@www.instagram.com/p/abc/')).toBe(false);
    expect(isInstagramPermalink('javascript:alert(1)')).toBe(false);
    const ok = { provider: 'instagram_hashtag', hashtag: 'skinfade', rank: 1, mediaType: 'VIDEO', postedAt: '2026-11-12T03:04:05.000Z', likeCount: 3, commentsCount: null, permalink: 'https://www.instagram.com/p/abc/' };
    expect(InstagramHashtagItemDataSchema.safeParse(ok).success).toBe(true);
    expect(InstagramHashtagItemDataSchema.safeParse({ ...ok, permalink: 'https://example.com/p/abc/' }).success).toBe(false);
    expect(InstagramHashtagItemDataSchema.safeParse({ ...ok, likeCount: -1 }).success).toBe(false);
  });

  it('titles posts without captions or names, and labels the group without popularity words', () => {
    expect(instagramPostTitle('#SkinFade', 'VIDEO', '2026-11-12T03:04:05.000Z')).toBe('Video under #skinfade, posted 12 Nov 2026');
    expect(instagramPostTitle('fade', 'CAROUSEL_ALBUM', null)).toBe('Carousel under #fade');
    expect(instagramPostTitle('fade', 'IMAGE', null)).toBe('Photo under #fade');
    expect(instagramPostTitle('fade', 'SOMETHING_NEW', null)).toBe('Post under #fade');
    expect(instagramCountsLine(1234, 1)).toBe('1,234 likes · 1 comment');
    expect(instagramCountsLine(null, null)).toBe('');
    expect(trendLabel({ kind: 'live', provider: 'instagram_hashtag', hashtag: 'skinfade', fetchedAt: '2026-11-13T19:05:00Z' })).toBe('Top posts under #skinfade — Instagram, fetched 14 Nov 2026, 6:05 am');
    for (const tag of ['skinfade', 'viralcuts']) expect(trendLabel({ kind: 'live', provider: 'instagram_hashtag', hashtag: tag, fetchedAt: NOW })).not.toMatch(/trending|viral/i);
  });
});
