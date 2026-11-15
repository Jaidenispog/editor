'use client';

import { useEffect, useMemo, useState } from 'react';
import { TIKTOK_INTERACTION_LABELS, type TiktokInteractionSeeds, type TiktokInteractions } from '@studio/core';
import { Switch } from '@/components/ui/switch';
import type { EligibilityItemDto, PublishPostDto, TargetDto } from '@/lib/shared/publishing-dto';

/** What the owner chose on the review step for every TikTok-via-Zernio destination in the batch. */
export interface ZernioConsentValue {
  /** Every required tick is ticked (publicly posting and/or sending to drafts). */
  ticked: boolean;
  interactions: TiktokInteractions;
}

/** The Zernio destinations of the saved drafts. */
export function zernioTargetsOf(posts: PublishPostDto[]): TargetDto[] {
  return posts.flatMap((p) => p.targets.filter((t) => t.method === 'zernio'));
}

/** True when the approve button may be pressed. */
export function zernioConsentReady(value: ZernioConsentValue | null): boolean {
  return Boolean(value?.ticked);
}

const KEYS = ['allowComment', 'allowDuet', 'allowStitch'] as const;

/**
 * The review step's consent for TikTok through Zernio (design §4.1 step 6, §7.2.3): the Comments / Duets / Stitches
 * switches (TikTok requires a choice and forbids defaults; seeded from Zernio's creator info and locked off when the
 * creator turned one off in TikTok) and the tick "I've watched this video and checked the caption. Post it publicly to
 * TikTok as @handle." (or the drafts wording). Without the tick nothing can be approved; the server checks it again.
 */
export function ZernioConsent({ posts, items, onChange }: { posts: PublishPostDto[]; items: EligibilityItemDto[]; onChange: (value: ZernioConsentValue) => void }) {
  const targets = zernioTargetsOf(posts);
  const handle = targets[0]?.handle ?? 'your TikTok account';
  const hasPublish = targets.some((t) => t.delivery === 'publish');
  const hasDraft = targets.some((t) => t.delivery === 'draft');
  const seeds: TiktokInteractionSeeds | null = useMemo(() => {
    for (const item of items) {
      const option = item.methods.tiktok.find((o) => o.method === 'zernio' && o.tiktokInteractions);
      if (option?.tiktokInteractions) return option.tiktokInteractions;
    }
    return null;
  }, [items]);
  const [choice, setChoice] = useState<TiktokInteractions>(() => ({
    allowComment: Boolean(seeds?.allowComment.enabled && seeds.allowComment.default),
    allowDuet: Boolean(seeds?.allowDuet.enabled && seeds.allowDuet.default),
    allowStitch: Boolean(seeds?.allowStitch.enabled && seeds.allowStitch.default),
  }));
  const [publicTick, setPublicTick] = useState(false);
  const [draftTick, setDraftTick] = useState(false);
  useEffect(() => {
    onChange({ ticked: (!hasPublish || publicTick) && (!hasDraft || draftTick), interactions: choice });
  }, [choice, publicTick, draftTick, hasPublish, hasDraft, onChange]);

  return (
    <div className="space-y-3 rounded-xl border border-charcoal-200 bg-white p-4">
      <p className="text-sm font-semibold text-charcoal-900">TikTok through Zernio · {handle}</p>
      {hasPublish ? <p className="text-sm text-charcoal-700">Posts through Zernio are public on TikTok immediately.</p> : null}
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-charcoal-600">Allow on TikTok{targets.length > 1 ? ' (for every TikTok post above)' : ''}</legend>
        {KEYS.map((k) => {
          const locked = seeds ? !seeds[k].enabled : false;
          return (
            <Switch
              key={k}
              checked={choice[k]}
              disabled={locked}
              onChange={(v) => setChoice((c) => ({ ...c, [k]: v }))}
              label={TIKTOK_INTERACTION_LABELS[k]}
              description={locked ? 'Turned off in your TikTok settings' : undefined}
            />
          );
        })}
      </fieldset>
      {hasPublish ? (
        <label className="flex min-h-11 items-start gap-2 text-sm text-charcoal-800">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={publicTick} onChange={(e) => setPublicTick(e.target.checked)} />
          <span>I&apos;ve watched this video and checked the caption. Post it publicly to TikTok as {handle}.</span>
        </label>
      ) : null}
      {hasDraft ? (
        <label className="flex min-h-11 items-start gap-2 text-sm text-charcoal-800">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={draftTick} onChange={(e) => setDraftTick(e.target.checked)} />
          <span>I&apos;ve watched this video. Send it to my TikTok drafts as {handle}.</span>
        </label>
      ) : null}
    </div>
  );
}
