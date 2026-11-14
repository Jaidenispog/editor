'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/shared/cn';
import { revealTabScrollLeft, stripFadeMask, stripOverflow } from '@/lib/shared/tab-scroll';

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

/**
 * Accessible tabs (WAI-ARIA tabs pattern: arrow keys, Home/End). Works uncontrolled (`defaultValue`) or
 * controlled (`value` + `onValueChange`, e.g. to mirror the tab in the URL). Only the active panel renders.
 * On a narrow screen the strip scrolls sideways: the selected tab is scrolled into view (the page itself never
 * moves) and the edges with more tabs beyond them fade out.
 */
export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  label,
  className,
}: {
  items: TabItem[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (id: string) => void;
  /** Accessible name for the tab list. */
  label: string;
  className?: string;
}) {
  const baseId = useId();
  const [internal, setInternal] = useState(defaultValue ?? items[0]?.id ?? '');
  const active = value ?? internal;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });

  const select = (id: string) => {
    if (value === undefined) setInternal(id);
    onValueChange?.(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const idx = items.findIndex((t) => t.id === active);
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (idx + 1) % items.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIdx = (idx - 1 + items.length) % items.length;
    if (e.key === 'Home') nextIdx = 0;
    if (e.key === 'End') nextIdx = items.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const next = items[nextIdx];
    if (!next) return;
    select(next.id);
    refs.current[next.id]?.focus();
  };

  const current = items.find((t) => t.id === active) ?? items[0];
  const currentId = current?.id;

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const next = stripOverflow(strip);
    setOverflow((o) => (o.start === next.start && o.end === next.end ? o : next));
  }, []);

  // Keep the selected tab visible: on first render (e.g. Settings opened on "Music library") and whenever it changes.
  useEffect(() => {
    const strip = stripRef.current;
    const tab = currentId ? refs.current[currentId] : null;
    if (!strip || !tab) return;
    const left = revealTabScrollLeft(strip, tab);
    if (left !== strip.scrollLeft) strip.scrollTo({ left, behavior: 'auto' });
    measure();
  }, [currentId, measure]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(strip);
    return () => observer?.disconnect();
  }, [measure]);

  const mask = stripFadeMask(overflow);

  return (
    <div className={className}>
      <div className="relative -mx-1">
        {/* The baseline sits under the strip so the edge fade (a mask on the strip) never fades it. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-charcoal-200" />
        <div
          ref={stripRef}
          role="tablist"
          aria-label={label}
          onScroll={measure}
          className="relative flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        >
          {items.map((t) => {
            const selected = t.id === current?.id;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  refs.current[t.id] = el;
                }}
                role="tab"
                type="button"
                id={`${baseId}-tab-${t.id}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel-${t.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(t.id)}
                onKeyDown={onKeyDown}
                className={cn(
                  'shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
                  selected ? 'border-[var(--accent)] text-charcoal-950' : 'border-transparent text-charcoal-500 hover:text-charcoal-800',
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
      {current ? (
        <div role="tabpanel" id={`${baseId}-panel-${current.id}`} aria-labelledby={`${baseId}-tab-${current.id}`} tabIndex={0} className="pt-6 focus-visible:outline-none">
          {current.content}
        </div>
      ) : null}
    </div>
  );
}
