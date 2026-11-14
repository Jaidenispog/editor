import { StatusPill } from '@/components/ui/status-pill';
import type { PublishBadgeDto } from '@/lib/shared/publishing-dto';

/** Small per-platform badges ("Instagram · Posted", "TikTok · Your turn") for Studio and Library cards. */
export function PublishBadges({ badges, className }: { badges: PublishBadgeDto[]; className?: string }) {
  if (badges.length === 0) return null;
  return (
    <ul className={className ?? 'flex flex-wrap gap-1.5'} aria-label="Posting status">
      {badges.map((b) => (
        <li key={`${b.versionId}:${b.platform}`}>
          <StatusPill status={b.status} label={b.label} />
        </li>
      ))}
    </ul>
  );
}
