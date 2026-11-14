import Link from 'next/link';
import { StatusPill } from '@/components/ui/status-pill';
import type { IntegrationStatus } from '@/lib/shared/integration-types';

/**
 * The Publishing page's honest connection summary: manual posting always works and is said first; direct publishing
 * shows its real state (needs setup, ready to connect, connected but not verified, reconnect, error).
 */
export function ConnectionsPanel({ integrations }: { integrations: IntegrationStatus[] }) {
  const ig = integrations.find((i) => i.id === 'instagram');
  const direct = !ig || ig.state === 'not_configured' ? 'Direct publishing: needs setup' : ig.state === 'not_connected' ? 'Direct publishing: ready to connect' : ig.state === 'connected' ? (ig.verified ? 'Direct publishing: connected and verified' : 'Direct publishing: connected, not verified yet') : ig.state === 'needs_reauth' ? 'Direct publishing: reconnect needed' : 'Direct publishing: has a problem';
  return (
    <ul className="space-y-2 text-sm">
      <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-charcoal-200 bg-white p-3">
        <span>
          <span className="font-medium text-charcoal-900">Instagram:</span> post it yourself (works now) · {direct}
        </span>
        <StatusPill status={ig?.state === 'connected' ? 'connected' : ig?.state === 'needs_reauth' ? 'needs_reauth' : ig?.state === 'error' ? 'error' : 'not_connected'} label={ig?.state === 'connected' ? (ig.verified ? 'Connected' : 'Not verified') : ig?.state === 'needs_reauth' ? 'Reconnect needed' : ig?.state === 'error' ? 'Problem' : 'Manual'} />
      </li>
      <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-charcoal-200 bg-white p-3">
        <span>
          <span className="font-medium text-charcoal-900">TikTok:</span> post it yourself (works now)
        </span>
        <StatusPill status="not_connected" label="Manual" />
      </li>
      <li>
        <Link href="/settings?tab=integrations" className="text-sm font-medium text-charcoal-900 underline decoration-[var(--accent)] decoration-2 underline-offset-4">
          Open Settings → Integrations
        </Link>
      </li>
    </ul>
  );
}
