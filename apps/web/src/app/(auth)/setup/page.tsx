import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { countUsers } from '@/lib/auth';
import { getLogger } from '@/lib/logger';
import { SetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up' };

/** First-run setup: only available while no accounts exist; afterwards it sends you to sign in. */
export default async function SetupPage() {
  let users: number | null = null;
  try {
    users = await countUsers();
  } catch (err) {
    getLogger().error({ err }, 'setup page: database unavailable');
  }
  if (users !== null && users > 0) redirect('/login');
  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-charcoal-500 uppercase">First-time setup</p>
      <h2 className="mt-1 text-2xl font-semibold text-charcoal-950">Create the owner account</h2>
      <p className="mt-1 text-sm text-charcoal-600">This account can change every setting. You can do this once; after that the page is closed.</p>
      {users === null ? (
        <Alert tone="danger" title="The app cannot reach its database" className="mt-6">
          Setup needs the database. Check DATABASE_URL, make sure PostgreSQL is running and that migrations have been applied (pnpm db:migrate).
        </Alert>
      ) : (
        <SetupForm />
      )}
    </div>
  );
}
