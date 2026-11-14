import { Skeleton } from '@/components/ui/skeleton';

/** Placeholder while the project's clips and edits load. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading the project">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-8 w-64 max-w-full" />
      <Skeleton className="mt-3 h-4 w-40" />
      <Skeleton className="mt-8 h-48 rounded-[var(--radius-card)]" />
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="aspect-[9/16] rounded-[var(--radius-card)]" />
        ))}
      </div>
    </div>
  );
}
