'use client';

import { Scissors } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { SquareServiceDto, SquareStatusDto } from '@/lib/shared/square-dto';

const LABEL_WORDS: Record<SquareServiceDto['label'], { status: string; text: string }> = {
  bookable: { status: 'ok', text: 'Bookable here' },
  needs_confirmation: { status: 'pending', text: 'Not confirmed' },
  book_in_square: { status: 'needs_setup', text: 'Book in Square' },
  unverified: { status: 'needs_setup', text: 'Book in Square' },
  not_bookable: { status: 'none', text: 'Not open for booking' },
};

/**
 * Services from the Square catalogue with durations, the studio's own prices (AUD) and the per-service label
 * (design §4.3). The owner can record "I've checked: no no-show fee"; a new Square version resets it.
 */
export function ServiceList({ services, canManage, onChanged }: { services: SquareServiceDto[]; canManage: boolean; onChanged: (s: SquareStatusDto) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (!services.length) return <EmptyState icon={<Scissors />} title="No services copied from Square yet" description="Services appear after the first sync. Only Square Appointments services are shown." />;
  const confirm = async (s: SquareServiceDto, confirmed: boolean) => {
    setBusy(s.variationId);
    try {
      onChanged(await apiRequest<SquareStatusDto>('/api/integrations/square', { method: 'PATCH', body: { serviceConfirmation: { variationId: s.variationId, confirmed } } }));
      toast.success(confirmed ? 'Noted: no no-show fee on this service' : 'Confirmation removed');
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <ul className="space-y-3">
      {services.map((s) => {
        const word = LABEL_WORDS[s.label];
        return (
          <li key={s.variationId} className="rounded-[var(--radius-card)] border border-charcoal-200 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-charcoal-900">{s.name}</p>
                <p className="text-sm text-charcoal-600">
                  {[s.durationMinutes ? `${s.durationMinutes} min` : null, s.priceLabel, s.teamMemberNames.length ? s.teamMemberNames.join(', ') : 'No barber assigned'].filter(Boolean).join(' · ')}
                </p>
              </div>
              <StatusPill status={word.status} label={word.text} />
            </div>
            <p className="mt-2 text-xs text-charcoal-600">{s.labelReason}</p>
            {canManage && (s.label === 'needs_confirmation' || (s.label === 'bookable' && s.confirmed)) ? (
              <Button size="sm" variant="secondary" className="mt-2 min-h-11 sm:min-h-8" loading={busy === s.variationId} onClick={() => void confirm(s, s.label === 'needs_confirmation')}>
                {s.label === 'needs_confirmation' ? 'I’ve checked: no no-show fee' : 'Remove my confirmation'}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
