'use client';

import { useId } from 'react';
import { CAPTION_MAX_GRAPHEMES, validateCaption } from '@studio/core';
import { Button } from '@/components/ui/button';

/**
 * Caption textarea with a live `n / 2,200` counter (graphemes, so an emoji counts once), a warning above 30
 * hashtags, the locked credit line (CC BY) shown under it, and "Use default ending". Never AI-written.
 */
export function CaptionEditor({ value, onChange, suffix, footer }: { value: string; onChange: (v: string) => void; suffix: string | null; footer: string }) {
  const id = useId();
  const check = validateCaption(value, suffix);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-charcoal-800">
        Caption
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        className="w-full rounded-lg border border-charcoal-200 bg-white px-3 py-2 text-base text-charcoal-900 shadow-sm focus:border-charcoal-400 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:text-sm"
        aria-describedby={`${id}-count`}
      />
      {suffix ? (
        <p className="rounded-md bg-charcoal-50 px-2 py-1 text-xs text-charcoal-700">
          Always added at the end (the music licence asks for it): <span className="font-medium">{suffix}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`${id}-count`} className={check.ok ? 'text-xs text-charcoal-500' : 'text-xs font-medium text-red-700'} aria-live="polite">
          {check.length.toLocaleString('en-AU')} / {CAPTION_MAX_GRAPHEMES.toLocaleString('en-AU')}
          {check.warnings.length ? ` · ${check.warnings[0]}` : ''}
        </p>
        {footer ? (
          <Button variant="ghost" className="min-h-11" onClick={() => onChange(value.includes(footer) ? value : `${value.replace(/\s+$/, '')}${value.trim() ? '\n\n' : ''}${footer}`)}>
            Use default ending
          </Button>
        ) : null}
      </div>
    </div>
  );
}
