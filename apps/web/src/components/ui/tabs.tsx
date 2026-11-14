'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/shared/cn';

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

/**
 * Accessible tabs (WAI-ARIA tabs pattern: arrow keys, Home/End). Works uncontrolled (`defaultValue`) or
 * controlled (`value` + `onValueChange`, e.g. to mirror the tab in the URL). Only the active panel renders.
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

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto border-b border-charcoal-200 px-1 pb-px [scrollbar-width:none]">
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
                '-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
                selected ? 'border-[var(--accent)] text-charcoal-950' : 'border-transparent text-charcoal-500 hover:text-charcoal-800',
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {current ? (
        <div role="tabpanel" id={`${baseId}-panel-${current.id}`} aria-labelledby={`${baseId}-tab-${current.id}`} tabIndex={0} className="pt-6 focus-visible:outline-none">
          {current.content}
        </div>
      ) : null}
    </div>
  );
}
