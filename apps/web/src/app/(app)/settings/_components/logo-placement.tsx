'use client';

/* eslint-disable @next/next/no-img-element -- logo comes from an expiring signed link */
import { VERTICAL_SAFE_ZONE_1080x1920, type BrandConfig, type LogoCorner, type LogoPlacement } from '@studio/core';
import { Select } from '@/components/ui/field';

/** Percent of the 1080×1920 frame, for the CSS preview. */
const px = (n: number, of: number) => `${(n / of) * 100}%`;

/** The corner mark and end card boxes at 1080×1920 (the renderer fits the logo inside them, keeping its shape). */
const CORNER = { size: 150, inset: 12 };
const END_CARD = { width: 420, height: 300, top: 380 };

/**
 * A static 9:16 frame (plain CSS, no rendering) showing where the logo goes and the areas kept clear for the apps'
 * buttons and captions, so the owner sees why it cannot go lower or further right.
 */
export function SafeZonePreviewFrame({ placement, corner, opacity, logoUrl }: { placement: LogoPlacement; corner: LogoCorner; opacity: number; logoUrl: string | null }) {
  const z = VERTICAL_SAFE_ZONE_1080x1920;
  const showCorner = placement === 'corner' || placement === 'both';
  const showEnd = placement === 'end_card' || placement === 'both';
  const cornerLeft = corner === 'top_left' ? z.head.left + CORNER.inset : z.head.right - CORNER.inset - CORNER.size;
  const logo = (label: string) =>
    logoUrl ? <img src={logoUrl} alt="" className="size-full object-contain" /> : <span className="text-[10px] font-medium text-charcoal-700">{label}</span>;
  return (
    <figure className="mx-auto w-40 sm:w-48">
      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-xl bg-charcoal-800" role="img" aria-label="Preview of where the logo appears in a vertical video">
        {z.forbidden.map((f) => (
          <div
            key={f.name}
            className="absolute bg-charcoal-950/70 [background-image:repeating-linear-gradient(45deg,transparent_0,transparent_6px,rgba(255,255,255,0.08)_6px,rgba(255,255,255,0.08)_12px)]"
            style={{ left: px(f.rect.left, z.width), top: px(f.rect.top, z.height), width: px(f.rect.right - f.rect.left, z.width), height: px(f.rect.bottom - f.rect.top, z.height) }}
          />
        ))}
        <div className="absolute border border-dashed border-white/40" style={{ left: px(z.head.left, z.width), top: px(z.head.top, z.height), width: px(z.head.right - z.head.left, z.width), height: px(z.head.bottom - z.head.top, z.height) }} />
        {showCorner ? (
          <div
            className="absolute flex items-center justify-center rounded-sm bg-white/90"
            style={{ left: px(cornerLeft, z.width), top: px(z.head.top + CORNER.inset, z.height), width: px(CORNER.size, z.width), height: px(CORNER.size, z.height), opacity }}
          >
            {logo('Logo')}
          </div>
        ) : null}
        {showEnd ? (
          <div
            className="absolute flex items-center justify-center rounded-sm border border-white/60 bg-white/20"
            style={{ left: px((z.width - END_CARD.width) / 2, z.width), top: px(END_CARD.top, z.height), width: px(END_CARD.width, z.width), height: px(END_CARD.height, z.height) }}
          >
            {logo('End card')}
          </div>
        ) : null}
      </div>
      <figcaption className="mt-2 text-xs text-charcoal-500">Shaded areas are kept clear for the apps’ buttons and captions.</figcaption>
    </figure>
  );
}

/** "Logo in videos": placement, corner and opacity, with the preview frame. Disabled until a logo is uploaded. */
export function LogoPlacementControl({
  values,
  onChange,
  hasLogo,
  logoUrl,
  disabled,
}: {
  values: Pick<BrandConfig, 'logoPlacement' | 'logoCorner' | 'logoOpacity'>;
  onChange: (patch: Partial<Pick<BrandConfig, 'logoPlacement' | 'logoCorner' | 'logoOpacity'>>) => void;
  hasLogo: boolean;
  logoUrl: string | null;
  disabled: boolean;
}) {
  const off = disabled || !hasLogo;
  const usesCorner = values.logoPlacement === 'corner' || values.logoPlacement === 'both';
  return (
    <div className="grid gap-5 sm:col-span-2 sm:grid-cols-[1fr_auto]">
      <div className="space-y-4">
        <Select
          label="Logo in videos"
          value={hasLogo ? values.logoPlacement : 'off'}
          onChange={(e) => onChange({ logoPlacement: e.target.value as LogoPlacement })}
          disabled={off}
          hint={hasLogo ? 'The logo stays inside the area every app leaves clear.' : 'Upload a logo above to use it in videos.'}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'end_card', label: 'End card — large, for the last two seconds' },
            { value: 'corner', label: 'Corner mark — small, the whole video' },
            { value: 'both', label: 'Both' },
          ]}
        />
        {usesCorner && hasLogo ? (
          <>
            <Select
              label="Corner"
              value={values.logoCorner}
              onChange={(e) => onChange({ logoCorner: e.target.value as LogoCorner })}
              disabled={off}
              options={[
                { value: 'top_left', label: 'Top left' },
                { value: 'top_right', label: 'Top right' },
              ]}
            />
            <div className="space-y-1.5">
              <label htmlFor="logo-opacity" className="flex items-center justify-between text-sm font-medium text-charcoal-800">
                <span>Corner mark opacity</span>
                <span className="tabular-nums text-charcoal-600">{Math.round(values.logoOpacity * 100)}%</span>
              </label>
              <input
                id="logo-opacity"
                type="range"
                min={0.6}
                max={1}
                step={0.05}
                value={values.logoOpacity}
                onChange={(e) => onChange({ logoOpacity: Number(e.target.value) })}
                disabled={off}
                className="w-full accent-[var(--accent)]"
              />
            </div>
          </>
        ) : null}
        <p className="text-sm text-charcoal-500">The corner mark steps aside while a title is at the top, and the end card is skipped if text is already in its place.</p>
      </div>
      <SafeZonePreviewFrame placement={hasLogo ? values.logoPlacement : 'off'} corner={values.logoCorner} opacity={values.logoOpacity} logoUrl={logoUrl} />
    </div>
  );
}
