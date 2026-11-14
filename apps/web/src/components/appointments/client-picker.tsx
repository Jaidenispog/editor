'use client';

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/field';
import { apiRequest } from '@/lib/client/api-client';
import { cn } from '@/lib/shared/cn';
import type { ClientDto } from '@/lib/shared/square-dto';

/**
 * Chooses a client from Studio Assistant's copy of Square's clients (search by name, email or phone). New clients are
 * added in Square first: Studio Assistant does not ask for permission to create Square customers.
 */
export function ClientPicker({ value, onChange, hint }: { value: ClientDto | null; onChange: (c: ClientDto) => void; hint?: string }) {
  const [q, setQ] = useState('');
  const [clients, setClients] = useState<ClientDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      apiRequest<{ clients: ClientDto[] }>(`/api/appointments/clients?q=${encodeURIComponent(q)}`)
        .then((r) => alive && (setClients(r.clients.slice(0, 20)), setError(null)))
        .catch((e: Error) => alive && setError(e.message));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);
  return (
    <div className="space-y-2">
      <Input label="Client" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} hint={hint ?? 'Clients copied from Square. Add a new client in Square first.'} autoComplete="off" />
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {clients && !clients.length ? <p className="text-sm text-charcoal-600">No client in Square’s list matches.</p> : null}
      {clients?.length ? (
        <ul className="max-h-48 space-y-1 overflow-y-auto" aria-label="Matching clients">
          {clients.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                aria-pressed={value?.id === c.id}
                onClick={() => onChange(c)}
                className={cn('flex min-h-11 w-full items-center rounded-[var(--radius-control)] border px-3 text-left text-sm', value?.id === c.id ? 'border-charcoal-900 bg-charcoal-50 font-medium' : 'border-charcoal-200 bg-white hover:border-charcoal-400')}
              >
                <span className="min-w-0 truncate">{c.name}</span>
                {c.email ? <span className="ml-2 min-w-0 truncate text-xs text-charcoal-500">{c.email}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
