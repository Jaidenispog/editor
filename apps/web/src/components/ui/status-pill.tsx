import { cn } from '@/lib/shared/cn';
import type { BadgeTone } from './badge';
import { statusLabel, toneForStatus } from './status-words';

export { statusLabel, toneForStatus } from './status-words';

const dot: Record<BadgeTone, string> = {
  neutral: 'bg-charcoal-400',
  accent: 'bg-accent',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-sky-500',
};

const pill: Record<BadgeTone, string> = {
  neutral: 'bg-charcoal-100 text-charcoal-700',
  accent: 'bg-accent-soft text-charcoal-900',
  success: 'bg-emerald-50 text-emerald-800',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-700',
  info: 'bg-sky-50 text-sky-800',
};

/** Status chip with a coloured dot; animated while work is in progress. */
export function StatusPill({ status, label, className }: { status: string; label?: string | undefined; className?: string }) {
  const tone = toneForStatus(status);
  const busy = tone === 'info';
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', pill[tone], className)}>
      <span className={cn('size-1.5 rounded-full', dot[tone], busy && 'animate-pulse')} aria-hidden="true" />
      {label ?? statusLabel(status)}
    </span>
  );
}
