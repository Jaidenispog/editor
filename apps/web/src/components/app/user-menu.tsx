'use client';

import { ChevronDown, LogOut, Settings, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { cn } from '@/lib/shared/cn';

/** Header menu with the signed-in user's name, links to settings and a sign-out action. */
export function UserMenu({ displayName, email, tone = 'light' }: { displayName: string; email: string; tone?: 'light' | 'dark' }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
      window.location.assign('/login');
    } catch (err) {
      setSigningOut(false);
      toast.error('Could not sign out', err instanceof Error ? err.message : undefined);
    }
  };

  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${displayName}`}
        className={cn(
          'flex items-center gap-2 rounded-full py-1 pr-2 pl-1 text-sm font-medium transition-colors',
          tone === 'dark' ? 'text-white hover:bg-white/10' : 'text-charcoal-800 hover:bg-charcoal-100',
        )}
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-charcoal-800 text-xs font-semibold text-white ring-2 ring-[var(--accent)]">{initials || '?'}</span>
        <span className="hidden max-w-32 truncate sm:inline">{displayName}</span>
        <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
      </button>
      {open ? (
        <div role="menu" aria-label="Account" className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-charcoal-200 bg-white py-1 text-charcoal-800 shadow-xl">
          <div className="border-b border-charcoal-100 px-4 py-3">
            <p className="truncate text-sm font-semibold">{displayName}</p>
            <p className="truncate text-xs text-charcoal-500">{email}</p>
          </div>
          <Link role="menuitem" href="/settings" onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-charcoal-50">
            <Settings className="size-4 text-charcoal-500" aria-hidden="true" /> Settings
          </Link>
          <Link role="menuitem" href="/settings?tab=security" onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-charcoal-50">
            <ShieldCheck className="size-4 text-charcoal-500" aria-hidden="true" /> Password and sessions
          </Link>
          <button role="menuitem" type="button" onClick={signOut} disabled={signingOut} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-red-700 hover:bg-red-50 disabled:opacity-60">
            <LogOut className="size-4" aria-hidden="true" /> {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
