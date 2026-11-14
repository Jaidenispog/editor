/* eslint-disable @next/next/no-img-element -- logos are served from expiring signed links, not the image optimiser */
import { cn } from '@/lib/shared/cn';

/** Logo (when uploaded) or a monogram on the accent colour, with the app and business names. */
export function BrandMark({ appName, businessName, logoUrl, compact, className }: { appName: string; businessName: string; logoUrl: string | null; compact?: boolean; className?: string }) {
  const initials = businessName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      {logoUrl ? (
        <img src={logoUrl} alt={`${businessName} logo`} className="size-9 shrink-0 rounded-lg bg-white object-contain" />
      ) : (
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-sm font-bold text-accent-foreground">
          {initials || 'SA'}
        </span>
      )}
      {compact ? null : (
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold">{appName}</span>
          <span className="block truncate text-xs opacity-70">{businessName}</span>
        </span>
      )}
    </div>
  );
}
