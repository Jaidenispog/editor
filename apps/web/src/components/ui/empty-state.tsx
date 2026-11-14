import type { ReactNode } from 'react';
import { cn } from '@/lib/shared/cn';

/** Friendly placeholder for lists with nothing in them yet, with an optional action. */
export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-charcoal-200 bg-white/60 px-6 py-12 text-center', className)}>
      {icon ? <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-charcoal-100 text-charcoal-600 [&_svg]:size-6">{icon}</div> : null}
      <h3 className="text-base font-semibold text-charcoal-900">{title}</h3>
      {description ? <p className="mt-1.5 max-w-md text-sm text-charcoal-500">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
