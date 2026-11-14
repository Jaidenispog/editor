'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/** Error state for app pages: plain message plus a retry. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto max-w-lg rounded-[var(--radius-card)] border border-red-200 bg-white p-8 text-center">
      <h1 className="text-lg font-semibold">This page could not load</h1>
      <p className="mt-2 text-sm text-charcoal-600">
        Something went wrong while loading. It is usually temporary — try again. If it keeps happening, check that the database and worker are running.
      </p>
      {error.digest ? <p className="mt-2 text-xs text-charcoal-400">Reference: {error.digest}</p> : null}
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
