'use client';

import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { CATEGORY_LABELS, EFFORT_LABELS, type Finding } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';

/** An image without a description, for the owner to describe ("Prepare a change"). */
export interface AltImage {
  src: string;
  pageUrl: string;
}

/** The owner writes image descriptions (never generated from file names); each becomes a prepared change. */
function AltTextForm({ images, onPrepared }: { images: AltImage[]; onPrepared?: (() => void) | undefined }) {
  const toast = useToast();
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <h4 className="font-medium text-charcoal-800">Prepare a change</h4>
      {images.slice(0, 10).map((img) => (
        <div key={img.src} className="space-y-1.5">
          <Input
            label={`Describe ${img.src.split('/').pop() ?? 'this image'}`}
            hint={img.pageUrl}
            value={text[img.src] ?? ''}
            maxLength={125}
            onChange={(e) => setText((t) => ({ ...t, [img.src]: e.target.value }))}
          />
          <Button
            size="sm"
            variant="secondary"
            className="min-h-11"
            disabled={(text[img.src] ?? '').trim().length < 3}
            loading={busy === img.src}
            onClick={async () => {
              setBusy(img.src);
              try {
                await apiRequest('/api/website/edits', {
                  method: 'POST',
                  body: {
                    kind: 'image_alt_text',
                    pageUrl: img.pageUrl,
                    imageSrc: img.src,
                    after: (text[img.src] ?? '').trim(),
                  },
                });
                toast.success('Change prepared', 'Find it under Suggested changes.');
                onPrepared?.();
              } catch (e) {
                toast.error('Not prepared', (e as Error).message);
              } finally {
                setBusy(null);
              }
            }}
          >
            Prepare change
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * One finding (design §4.2 step 4): severity, effort, "What we found", "Why it matters", "How to fix" and up to five
 * pages. Collapsed by default. Every string came from a public page or the check catalogue and is rendered as text.
 */
export function FindingCard({
  finding,
  hasChange,
  onShowChange,
  defaultOpen = false,
  altImages,
}: {
  finding: Finding;
  hasChange: boolean;
  onShowChange?: (() => void) | undefined;
  defaultOpen?: boolean;
  altImages?: AltImage[] | undefined;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const pages = finding.pages.slice(0, 5);
  return (
    <div className="rounded-lg border border-charcoal-200 bg-white">
      <button
        type="button"
        className="flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-charcoal-900">{finding.title}</p>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={finding.severity} />
            <span className="text-xs text-charcoal-500">{EFFORT_LABELS[finding.effort]}</span>
            <span className="text-xs text-charcoal-400">· {CATEGORY_LABELS[finding.category]}</span>
          </div>
        </div>
        <ChevronDown className={`mt-1 size-4 shrink-0 text-charcoal-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open ? (
        <div id={`${id}-body`} className="space-y-3 border-t border-charcoal-100 px-4 py-3 text-sm [overflow-wrap:anywhere]">
          <div>
            <h4 className="font-medium text-charcoal-800">What we found</h4>
            <p className="mt-0.5 text-charcoal-700">{finding.detail}</p>
            {pages.length ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-charcoal-500">
                {pages.map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {finding.pages.length > 5 ? <li>and {finding.pages.length - 5} more</li> : null}
              </ul>
            ) : null}
          </div>
          <div>
            <h4 className="font-medium text-charcoal-800">Why it matters</h4>
            <p className="mt-0.5 text-charcoal-700">{finding.why}</p>
          </div>
          {finding.howToFix.length ? (
            <div>
              <h4 className="font-medium text-charcoal-800">How to fix</h4>
              <ol className="mt-0.5 list-decimal space-y-0.5 pl-5 text-charcoal-700">
                {finding.howToFix.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          ) : null}
          {finding.checkId === 'image_alt_missing' && altImages?.length ? <AltTextForm images={altImages} onPrepared={onShowChange} /> : null}
          {hasChange && onShowChange ? (
            <button type="button" className="min-h-11 text-sm font-medium text-charcoal-900 underline underline-offset-2" onClick={onShowChange}>
              See prepared change
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
