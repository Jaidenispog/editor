'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { BookingDto } from '@/lib/shared/square-dto';

/**
 * Attended / Didn't attend / Clear for one booking (owner and staff). Disabled with Square's reason when Square's own
 * status forbids a mark or the appointment has not started. The mark stays in Studio Assistant; Square is unchanged.
 */
export function AttendanceControl({ booking, onMarked }: { booking: BookingDto; onMarked?: (b: BookingDto) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const mark = async (value: 'attended' | 'not_attended' | null) => {
    setBusy(value ?? 'clear');
    try {
      const updated = await apiRequest<BookingDto>(`/api/appointments/${encodeURIComponent(booking.id)}/attendance`, { method: 'POST', body: { value } });
      toast.success(value === 'attended' ? 'Marked as attended' : value === 'not_attended' ? 'Marked as didn’t attend' : 'Mark cleared');
      onMarked?.(updated);
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const { allowed, reason, current } = booking.attendanceMark;
  if (!allowed) return <p className="text-xs text-charcoal-500">{reason}</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" className="min-h-11 sm:min-h-8" variant={current === 'attended' ? 'primary' : 'secondary'} loading={busy === 'attended'} disabled={Boolean(busy) || current === 'attended'} onClick={() => void mark('attended')}>
        Attended
      </Button>
      <Button size="sm" className="min-h-11 sm:min-h-8" variant={current === 'not_attended' ? 'primary' : 'secondary'} loading={busy === 'not_attended'} disabled={Boolean(busy) || current === 'not_attended'} onClick={() => void mark('not_attended')}>
        Didn’t attend
      </Button>
      {current ? (
        <Button size="sm" className="min-h-11 sm:min-h-8" variant="ghost" loading={busy === 'clear'} disabled={Boolean(busy)} onClick={() => void mark(null)}>
          Clear mark
        </Button>
      ) : null}
    </div>
  );
}
