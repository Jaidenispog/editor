import { cn } from '@/lib/shared/cn';

/** Grey shimmering block used in loading states. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-charcoal-200/60', className)} />;
}
