import { describe, expect, it } from 'vitest';
import { buildPublishingIntegrations } from '../src/lib/integrations/publishing';
import { publishingRefId } from '../src/lib/jobs/publishing';
import { defaultRefId } from '../src/lib/jobs';
import { addVideo, buildCreateRequest, draftProblems, initialDraft } from '../src/components/publishing/composer-state';
import type { EligibilityItemDto } from '../src/lib/shared/publishing-dto';

const env = { META_APP_ID: 'a', META_APP_SECRET: 's', META_LOGIN_CONFIG_ID: 'c' } as never;
const noFacts = { connections: [], socialAccounts: [] };
const find = (list: ReturnType<typeof buildPublishingIntegrations>, id: string) => list.find((i) => i.id === id)!;

describe('publishing integration cards (design §5.3)', () => {
  it('always says manual posting works, and names the missing Meta settings', () => {
    const list = buildPublishingIntegrations({} as never, noFacts);
    const ig = find(list, 'instagram');
    expect(ig).toMatchObject({ state: 'not_configured', configured: false, connected: false, missingEnv: ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID'], liveMode: null, verified: false });
    expect(ig.message).toMatch(/^Post it yourself works now/);
    const tt = find(list, 'tiktok');
    expect(tt).toMatchObject({ state: 'unavailable', configured: false, connected: false, missingEnv: [] });
    expect(tt.message).toMatch(/^Post it yourself works now/);
    // No TikTok developer app is asked for any more.
    expect(JSON.stringify(list)).not.toContain('TIKTOK_CLIENT');
  });

  it('walks through not connected, connected-not-verified, verified, reconnect and error', () => {
    expect(find(buildPublishingIntegrations(env, noFacts), 'instagram').state).toBe('not_connected');
    const conn = (status: string, lastError: string | null = null) => ({ connections: [{ provider: 'meta', status, displayName: '', lastError }], socialAccounts: [] as Array<{ platform: string; status: string; username: string; capabilities?: Record<string, unknown> }> });
    const connected = conn('connected');
    connected.socialAccounts.push({ platform: 'instagram', status: 'connected', username: 'ivanhoe', capabilities: {} });
    const a = find(buildPublishingIntegrations(env, connected), 'instagram');
    expect(a).toMatchObject({ state: 'connected', connected: true, liveMode: 'development_live', verified: false, detail: '@ivanhoe' });
    expect(a.message).toMatch(/off until your first verification post/);
    expect(a.message).toMatch(/posts are real and public/);
    connected.socialAccounts[0]!.capabilities = { verifiedDirectAt: '2026-11-14T00:00:00Z' };
    expect(find(buildPublishingIntegrations(env, connected), 'instagram')).toMatchObject({ state: 'connected', verified: true });
    expect(find(buildPublishingIntegrations(env, conn('needs_reauth', 'Token expired')), 'instagram')).toMatchObject({ state: 'needs_reauth', connected: false });
    const err = find(buildPublishingIntegrations(env, conn('error', "Instagram didn't tell us which account to use.")), 'instagram');
    expect(err.state).toBe('error');
    expect(err.message).toContain("Instagram didn't tell us which account to use.");
    expect(find(buildPublishingIntegrations(env, conn('disconnected')), 'instagram').state).toBe('not_connected');
  });
});

describe('publishing job ref ids', () => {
  it('match the worker: post for prepare, target for target and poll', () => {
    expect(publishingRefId('publish.prepare', { postId: 'p' })).toBe('p');
    expect(publishingRefId('publish.target', { targetId: 't' })).toBe('t');
    expect(publishingRefId('publish.poll', { targetId: 't', pollNo: 1 })).toBe('t');
    expect(publishingRefId('render.export', {})).toBeUndefined();
    expect(defaultRefId('social.check', { connectionId: 'c', reason: 'manual' })).toBe('c');
  });
});

const item: EligibilityItemDto = {
  versionId: 'v1',
  projectId: 'p',
  projectTitle: 'Skin fade',
  styleName: 'Clean cut',
  versionNo: 1,
  previewUrl: null,
  durationSec: 10,
  exportStatus: 'none',
  noMusicExportStatus: 'none',
  defaultCoverTimeSec: 7.5,
  captionSuffix: null,
  hasMusic: true,
  eligibility: [
    { platform: 'instagram', allowedVariants: ['standard', 'no_music'], automationAllowedForStandard: true, reasons: [], manualStepHint: null, downloadLabel: null },
    { platform: 'tiktok', allowedVariants: ['no_music'], automationAllowedForStandard: false, reasons: ["The music licence doesn't cover TikTok."], manualStepHint: 'Add a Commercial Sound in the TikTok app if you want music.', downloadLabel: null },
  ],
  notes: [],
  methods: {
    instagram: [{ method: 'manual', available: true, isVerification: false, handle: '@studio' }],
    tiktok: [{ method: 'manual', available: true, isVerification: false, handle: '@studio' }],
  },
  priorTargets: [],
};

describe('composer logic', () => {
  it('preselects no platform, follows the music rule for the file, and prefills only the saved ending', () => {
    const d = initialDraft(item, '#ivanhoe', new Date('2026-11-14T00:00:00Z'));
    expect(d.destinations.instagram.enabled).toBe(false);
    expect(d.destinations.tiktok.enabled).toBe(false);
    expect(d.destinations.tiktok.variant).toBe('no_music');
    expect(d.caption).toBe('#ivanhoe');
    expect(d.coverTimeSec).toBe(7.5);
    expect(draftProblems(item, d)).toContain('Choose at least one place to post this video.');
  });

  it('caps a batch at five videos and never adds one twice', () => {
    let list: string[] = [];
    for (const id of ['a', 'b', 'a', 'c', 'd', 'e', 'f']) list = addVideo(list, id);
    expect(list).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('builds exactly the request the review step shows, and blocks a repeat without "Post again"', () => {
    const d = initialDraft(item, '');
    d.destinations.tiktok.enabled = true;
    d.caption = 'Fresh fade';
    expect(draftProblems(item, d)).toEqual([]);
    expect(buildCreateRequest([d])).toEqual({
      allowRepeat: false,
      items: [{ editVersionId: 'v1', caption: 'Fresh fade', coverTimeSec: 7.5, mode: 'now', targets: [{ platform: 'tiktok', method: 'manual', delivery: 'publish', variant: 'no_music' }] }],
    });
    const posted = { ...item, priorTargets: [{ platform: 'tiktok' as const, status: 'published' as const, publishedAt: '2026-11-12T00:00:00Z' }] };
    expect(draftProblems(posted, d).join(' ')).toMatch(/Post again/);
    expect(draftProblems(posted, { ...d, allowRepeat: true })).toEqual([]);
    d.destinations.tiktok.variant = 'standard';
    expect(draftProblems(item, d).join(' ')).toMatch(/doesn't cover TikTok/);
  });

  it('checks the Melbourne schedule in the browser too', () => {
    const d = { ...initialDraft(item, ''), mode: 'scheduled' as const, schedule: { date: '2027-10-03', time: '02:30' } };
    d.destinations.instagram.enabled = true;
    expect(draftProblems(item, d, new Date('2027-09-01T00:00:00Z')).join(' ')).toMatch(/doesn't exist/);
  });
});
