import { CheckCircle2, CircleDashed, PlugZap } from 'lucide-react';
import Link from 'next/link';
import type { IntegrationStatus } from '@/lib/shared/integration-types';
import { cn } from '@/lib/shared/cn';
import { StatusPill } from '@/components/ui/status-pill';

/** State word for an integration card. */
export function integrationState(i: IntegrationStatus): 'connected' | 'ready' | 'needs_setup' {
  if (i.connected) return 'connected';
  if (i.configured) return 'ready';
  return 'needs_setup';
}

/**
 * Status cards for integrations: what is connected, what is configured but not yet connected, and what needs
 * setup — with the plain-language next step and the names (never values) of missing server settings.
 */
export function IntegrationStatusList({ integrations, showEnv = false, className }: { integrations: IntegrationStatus[]; showEnv?: boolean; className?: string }) {
  return (
    <ul className={cn('grid gap-3 md:grid-cols-2', className)}>
      {integrations.map((i) => {
        const state = integrationState(i);
        const Icon = state === 'connected' ? CheckCircle2 : state === 'ready' ? PlugZap : CircleDashed;
        return (
          <li key={i.id} className="rounded-xl border border-charcoal-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <Icon className={cn('size-5 shrink-0', state === 'connected' ? 'text-emerald-600' : state === 'ready' ? 'text-sky-600' : 'text-charcoal-400')} aria-hidden="true" />
                <h3 className="truncate text-sm font-semibold text-charcoal-900">{i.name}</h3>
              </div>
              <StatusPill status={state === 'connected' ? 'connected' : state === 'ready' ? 'queued' : 'needs_setup'} label={state === 'connected' ? 'Active' : state === 'ready' ? 'Ready to connect' : 'Needs setup'} />
            </div>
            <p className="mt-2 text-sm leading-relaxed text-charcoal-600">{i.message}</p>
            {i.detail ? <p className="mt-1.5 text-xs text-charcoal-500">{i.detail}</p> : null}
            {showEnv && i.missingEnv.length > 0 ? (
              <div className="mt-3">
                <p className="text-xs font-medium text-charcoal-500">Missing server settings</p>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {i.missingEnv.map((name) => (
                    <li key={name}>
                      <code className="rounded bg-charcoal-100 px-1.5 py-0.5 text-xs text-charcoal-700">{name}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Link to the integrations settings tab, for section pages. */
export function IntegrationsSettingsLink() {
  return (
    <Link href="/settings?tab=integrations" className="text-sm font-medium text-charcoal-900 underline decoration-[var(--accent)] decoration-2 underline-offset-4 hover:text-charcoal-700">
      Open Settings → Integrations
    </Link>
  );
}
