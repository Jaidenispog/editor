'use client';

import { Laptop, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiClientError, apiRequest } from '@/lib/client/api-client';
import { RelativeTime } from '@/components/ui/relative-time';
import { formatDateTime } from '@/lib/format';

/** One active session for the list. */
export interface SessionRow {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  ipAddress: string;
}

/** Short device description from a user agent string. */
function describeDevice(ua: string): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} on ${os}`;
}

/** Users & security: account details, password change and active sessions with sign-out per device. */
export function SecurityTab({ user, sessions }: { user: { email: string; displayName: string; role: 'owner' | 'staff' }; sessions: SessionRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [revoking, setRevoking] = useState<string | null>(null);

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (next !== confirm) {
      setErrors({ confirm: 'The two new passwords do not match.' });
      return;
    }
    setSaving(true);
    try {
      const res = await apiRequest<{ signedOutSessions: number }>('/api/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      toast.success('Password changed', res.signedOutSessions ? `Signed out of ${res.signedOutSessions} other device${res.signedOutSessions === 1 ? '' : 's'}.` : undefined);
      setCurrent('');
      setNext('');
      setConfirm('');
      router.refresh();
    } catch (err) {
      const field = err instanceof ApiClientError && err.details && typeof err.details === 'object' ? (err.details as { field?: string }).field : undefined;
      if (field && err instanceof Error) setErrors({ [field]: err.message });
      else toast.error('Password not changed', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (id: string) => {
    setRevoking(id);
    try {
      await apiRequest(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast.success('Signed out of that device');
      router.refresh();
    } catch (err) {
      toast.error('Could not sign out that device', err instanceof Error ? err.message : undefined);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <Card>
          <CardHeader title="Your account" />
          <CardBody className="space-y-1 text-sm">
            <p className="font-medium text-charcoal-900">{user.displayName}</p>
            <p className="text-charcoal-600">{user.email}</p>
            <Badge tone={user.role === 'owner' ? 'accent' : 'neutral'} className="mt-2">
              {user.role === 'owner' ? 'Owner' : 'Staff'}
            </Badge>
          </CardBody>
        </Card>
        <form onSubmit={changePassword}>
          <Card>
            <CardHeader title="Change password" description="Other devices are signed out when you change it." />
            <CardBody className="space-y-4">
              <Input label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required error={errors['currentPassword'] ?? null} />
              <Input
                label="New password"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
                minLength={10}
                hint="At least 10 characters."
                error={errors['newPassword'] ?? null}
              />
              <Input label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required error={errors['confirm'] ?? null} />
            </CardBody>
            <CardFooter>
              <Button type="submit" loading={saving}>
                Change password
              </Button>
            </CardFooter>
          </Card>
        </form>
      </div>
      <Card>
        <CardHeader title="Signed-in devices" description="Sessions last 30 days from last use." />
        <CardBody>
          <ul className="divide-y divide-charcoal-100">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-3">
                <Laptop className="size-5 shrink-0 text-charcoal-400" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {describeDevice(s.userAgent)}
                    {s.current ? <Badge tone="success">This device</Badge> : null}
                  </p>
                  <p className="text-xs text-charcoal-500" title={formatDateTime(s.lastSeenAt)}>
                    Last active <RelativeTime date={s.lastSeenAt} /> · signed in {formatDateTime(s.createdAt)}
                    {s.ipAddress ? ` · ${s.ipAddress}` : ''}
                  </p>
                </div>
                {s.current ? null : (
                  <Button variant="ghost" size="sm" onClick={() => revoke(s.id)} loading={revoking === s.id} aria-label={`Sign out ${describeDevice(s.userAgent)}`}>
                    <LogOut className="size-4" aria-hidden="true" /> Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
