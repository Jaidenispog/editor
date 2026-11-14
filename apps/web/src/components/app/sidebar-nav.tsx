'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/shared/cn';
import { NAV_ITEMS, isActive } from './nav-items';

/** Desktop sidebar links (≥ lg) with the active section highlighted. */
export function SidebarNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const active = isActive(item.href, pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              active ? 'bg-white/10 text-white' : 'text-charcoal-300 hover:bg-white/5 hover:text-white',
            )}
          >
            <Icon className={cn('size-[18px] shrink-0', active ? 'text-accent' : 'text-charcoal-400 group-hover:text-charcoal-200')} aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
