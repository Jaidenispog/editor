'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { apiRequest, fieldErrors } from '@/lib/client/api-client';

/** Owner account form posting to /api/setup; signs in and opens the dashboard on success. */
export function SetupForm() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setErrors({});
    if (password !== confirm) {
      setErrors({ confirm: 'The two passwords do not match.' });
      return;
    }
    setLoading(true);
    try {
      await apiRequest('/api/setup', { method: 'POST', body: { displayName, email, password } });
      window.location.assign('/');
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      setError(Object.keys(fe).length ? null : err instanceof Error ? err.message : 'Setup failed. Please try again.');
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
      <Input label="Your name" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required autoFocus error={errors['displayName'] ?? null} />
      <Input label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required error={errors['email'] ?? null} />
      <Input
        label="Password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        minLength={10}
        hint="At least 10 characters. A short sentence is easy to remember and hard to guess."
        error={errors['password'] ?? null}
      />
      <Input label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required error={errors['confirm'] ?? null} />
      {error ? (
        <p role="alert" className="rounded-[var(--radius-control)] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="w-full" loading={loading}>
        Create account and sign in
      </Button>
    </form>
  );
}
