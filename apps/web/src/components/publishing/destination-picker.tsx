'use client';

import { TARGET_PLATFORM_NAMES, formatDateTime, type TargetPlatform } from '@studio/core';
import { Switch } from '@/components/ui/switch';
import type { EligibilityDto, EligibilityItemDto } from '@/lib/shared/publishing-dto';
import type { DestinationDraft } from './composer-state';
import { METHOD_LABELS } from './labels';

/**
 * One platform's switch (off by default), its method choice with the reason any option is greyed out, and the file
 * the music rule allows ("with music" / "without music: add a sound in TikTok"), plus the quota hint.
 */
export function DestinationPicker({
  item,
  platform,
  value,
  onChange,
  quota,
}: {
  item: EligibilityItemDto;
  platform: TargetPlatform;
  value: DestinationDraft;
  onChange: (v: DestinationDraft) => void;
  quota: EligibilityDto['quota'];
}) {
  const e = item.eligibility.find((x) => x.platform === platform);
  const options = item.methods[platform];
  const name = TARGET_PLATFORM_NAMES[platform];
  const manual = options.find((o) => o.method === 'manual');
  const prior = item.priorTargets.find((t) => t.platform === platform);
  return (
    <div className="rounded-xl border border-charcoal-200 p-3">
      <Switch checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} label={`${name} · ${manual?.handle ?? ''}`} description={value.enabled ? undefined : 'Off'} />
      {prior ? (
        <p className="mt-2 text-xs text-amber-800">
          Already {prior.status === 'published' ? 'posted' : 'sent'} to {name}
          {prior.publishedAt ? ` on ${formatDateTime(prior.publishedAt, { dateStyle: 'medium', timeStyle: undefined })}` : ''}. Posting again will create a second post.
        </p>
      ) : null}
      {value.enabled ? (
        <div className="mt-3 space-y-3">
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-charcoal-600">How</legend>
            {options.map((o) => {
              const label = o.isVerification ? 'First verification post (publish from Studio Assistant)' : METHOD_LABELS[o.method];
              return (
                <label key={o.method} className={`flex min-h-11 items-start gap-2 rounded-lg px-2 py-1.5 ${o.available ? 'cursor-pointer hover:bg-charcoal-50' : 'opacity-60'}`}>
                  <input type="radio" className="mt-1 size-4 accent-[var(--accent)]" name={`${item.versionId}-${platform}-method`} checked={value.method === o.method} disabled={!o.available} onChange={() => onChange({ ...value, method: o.method })} />
                  <span className="min-w-0 text-sm">
                    <span className="font-medium text-charcoal-900">{label}</span>
                    {o.method !== 'manual' ? <span className="block text-xs text-charcoal-600">as {o.handle}</span> : null}
                    {!o.available && o.reason ? <span className="block text-xs text-charcoal-600">{o.reason}</span> : null}
                    {o.isVerification && o.available ? <span className="block text-xs text-amber-800">This is a real, public post on {o.handle}. Choose an edit you&apos;re happy to share.</span> : null}
                  </span>
                </label>
              );
            })}
            {platform === 'instagram' && options.length === 1 ? <p className="text-xs text-charcoal-500">Direct publishing from Studio Assistant needs setup in Settings → Integrations.</p> : null}
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-charcoal-600">File</legend>
            {(['standard', 'no_music'] as const)
              .filter((v) => item.hasMusic || v === 'standard')
              .map((v) => {
                const allowed = e?.allowedVariants.includes(v) ?? false;
                return (
                  <label key={v} className={`flex min-h-11 items-start gap-2 rounded-lg px-2 py-1.5 ${allowed ? 'cursor-pointer hover:bg-charcoal-50' : 'opacity-60'}`}>
                    <input type="radio" className="mt-1 size-4 accent-[var(--accent)]" name={`${item.versionId}-${platform}-variant`} checked={value.variant === v} disabled={!allowed} onChange={() => onChange({ ...value, variant: v })} />
                    <span className="text-sm text-charcoal-900">
                      {v === 'standard' ? (item.hasMusic ? 'With music' : 'As edited') : 'Without music'}
                      {v === 'standard' && e?.downloadLabel ? <span className="block text-xs text-amber-800">{e.downloadLabel}</span> : null}
                      {v === 'no_music' && value.variant === 'no_music' && e?.manualStepHint ? <span className="block text-xs text-charcoal-600">{e.manualStepHint}</span> : null}
                    </span>
                  </label>
                );
              })}
            {e && !e.allowedVariants.includes('standard') && e.reasons[0] ? <p className="text-xs text-charcoal-600">Will post without music: {e.reasons[0]}</p> : null}
          </fieldset>
          {platform === 'instagram' && value.method === 'instagram_api' && quota.instagram ? (
            <p className="text-xs text-charcoal-500">
              {quota.instagram.usage} of {quota.instagram.total ?? '?'} posts used in the last 24 h
              {quota.instagram.checkedAt ? ` (checked ${formatDateTime(quota.instagram.checkedAt, { dateStyle: undefined, timeStyle: 'short' })})` : ''}
            </p>
          ) : null}
          {platform === 'instagram' ? <p className="text-xs text-charcoal-500">Instagram&apos;s library music can&apos;t be added from here. Add it in the Instagram app if you want it.</p> : <p className="text-xs text-charcoal-500">Add a Commercial Sound in the TikTok app if you want music.</p>}
        </div>
      ) : null}
    </div>
  );
}
