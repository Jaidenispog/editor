'use client';

import { useEffect, useState } from 'react';
import { formatDateTime, formatRelative } from '@/lib/format';

const REFRESH_MS = 30_000;

/**
 * "3 minutes ago" that is safe to server-render. Relative text depends on the current time, so the server and
 * the browser's first render would disagree whenever a second ticks over between them (a hydration error).
 * Both therefore render the fixed Melbourne date and time first; after mounting, the browser switches to the
 * relative text and refreshes it every 30 seconds. The absolute time stays available as the tooltip.
 */
export function RelativeTime({ date, className }: { date: Date | string; className?: string }) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const iso = Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  const absolute = iso ? formatDateTime(d) : '';
  const [relative, setRelative] = useState<string | null>(null);

  useEffect(() => {
    if (!iso) return;
    const update = () => setRelative(formatRelative(iso));
    update();
    const timer = window.setInterval(update, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [iso]);

  if (!iso) return null;
  return (
    // suppressHydrationWarning only covers this element's own text, in case Node's and the browser's ICU data
    // format the absolute time differently (for example the space before "pm").
    <time dateTime={iso} title={absolute} className={className} suppressHydrationWarning>
      {relative ?? absolute}
    </time>
  );
}
