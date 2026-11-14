'use client';

import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/shared/cn';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before it disappears (default 5000; errors stay 8000). */
  durationMs?: number;
}

interface ToastItem extends Required<Pick<ToastInput, 'title' | 'tone'>> {
  id: number;
  description?: string;
  durationMs: number;
}

interface ToastApi {
  toast: (t: ToastInput) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Provides toast notifications to client components (announced through an aria-live region). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const toast = useCallback((t: ToastInput) => {
    const tone = t.tone ?? 'info';
    const item: ToastItem = {
      id: nextId.current++,
      title: t.title,
      tone,
      durationMs: t.durationMs ?? (tone === 'error' ? 8000 : 5000),
      ...(t.description ? { description: t.description } : {}),
    };
    setItems((all) => [...all.slice(-3), item]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (title, description) => toast({ title, tone: 'success', ...(description ? { description } : {}) }),
      error: (title, description) => toast({ title, tone: 'error', ...(description ? { description } : {}) }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:px-6">
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), item.durationMs);
    return () => clearTimeout(timer);
  }, [item.id, item.durationMs, onDismiss]);
  const Icon = item.tone === 'success' ? CheckCircle2 : item.tone === 'error' ? TriangleAlert : Info;
  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-[var(--radius-control)] border border-charcoal-200 bg-white px-4 py-3 shadow-lg"
    >
      <Icon className={cn('mt-0.5 size-5 shrink-0', item.tone === 'success' ? 'text-emerald-600' : item.tone === 'error' ? 'text-red-600' : 'text-charcoal-500')} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-charcoal-900">{item.title}</p>
        {item.description ? <p className="mt-0.5 text-sm text-charcoal-600">{item.description}</p> : null}
      </div>
      <button type="button" onClick={() => onDismiss(item.id)} aria-label="Dismiss notification" className="rounded p-1 text-charcoal-400 hover:text-charcoal-700">
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Access the toast API inside a ToastProvider. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
