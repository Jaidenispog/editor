import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { countUsers } from '@/lib/auth';
import { getLogger } from '@/lib/logger';
import { safeNextPath } from '@/lib/shared/session-cookie';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

/** Sign-in page. Sends the browser to /setup when no account exists yet. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const nextParam = typeof params['next'] === 'string' ? params['next'] : null;
  const reason = typeof params['reason'] === 'string' ? params['reason'] : null;
  let users: number | null = null;
  try {
    users = await countUsers();
  } catch (err) {
    getLogger().error({ err }, 'login page: database unavailable');
  }
  if (users === 0) redirect('/setup');
  return (
    <div>
      <h2 className="text-2xl font-semibold text-charcoal-950">Sign in</h2>
      <p className="mt-1 text-sm text-charcoal-600">Use the email and password for your studio account.</p>
      {users === null ? (
        <Alert tone="danger" title="The app cannot reach its database" className="mt-6">
          Sign-in is unavailable until the database is running. If you look after the server, check DATABASE_URL and that PostgreSQL is started.
        </Alert>
      ) : null}
      {reason === 'expired' ? (
        <Alert tone="info" className="mt-6">
          Your session ended. Please sign in again.
        </Alert>
      ) : null}
      <LoginForm next={safeNextPath(nextParam)} />
    </div>
  );
}
