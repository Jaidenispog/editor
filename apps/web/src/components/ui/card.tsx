import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/shared/cn';

/** White rounded surface used for every content block. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white shadow-[var(--shadow-card)]', className)} {...props} />;
}

/** Card heading row with an optional description and actions on the right. */
export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6', className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-charcoal-900">{title}</h2>
        {description ? <p className="mt-1 text-sm text-charcoal-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Padded card body. */
export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-5 sm:px-6', className)} {...props} />;
}

/** Card footer with a top border, for actions. */
export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-charcoal-100 px-5 py-4 sm:px-6', className)} {...props} />;
}
