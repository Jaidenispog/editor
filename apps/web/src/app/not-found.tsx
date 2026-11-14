import Link from 'next/link';
import { buttonClasses } from '@/components/ui/button';

/** 404 page. */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-semibold text-charcoal-500">Not found</p>
      <h1 className="mt-2 text-2xl font-semibold">We could not find that page</h1>
      <p className="mt-2 max-w-md text-sm text-charcoal-600">It may have been moved or deleted.</p>
      <Link href="/" className={buttonClasses('primary', 'md', 'mt-6')}>
        Back to the dashboard
      </Link>
    </main>
  );
}
