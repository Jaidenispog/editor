'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/shared/cn';
import { NAV_ITEMS, isActive } from './nav-items';

/** Bottom tab bar for phones and tablets (< lg): primary sections plus a "More" sheet for the rest. */
export function MobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = NAV_ITEMS.filter((i) => i.primary);
  const secondary = NAV_ITEMS.filter((i) => !i.primary);
  const moreActive = secondary.some((i) => isActive(i.href, pathname));

  return (
    <>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-charcoal-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {primary.map((item) => {
            const active = isActive(item.href, pathname);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn('flex flex-col items-center gap-1 px-1 py-2.5 text-[11px] font-medium', active ? 'text-charcoal-950' : 'text-charcoal-500')}
                >
                  <Icon className={cn('size-5', active && 'text-charcoal-950')} aria-hidden="true" />
                  <span className="truncate">{item.label.replace('Content ', '').replace('Video ', '')}</span>
                  <span className={cn('h-0.5 w-6 rounded-full', active ? 'bg-accent' : 'bg-transparent')} aria-hidden="true" />
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              className={cn('flex w-full flex-col items-center gap-1 px-1 py-2.5 text-[11px] font-medium', moreActive ? 'text-charcoal-950' : 'text-charcoal-500')}
            >
              <MoreHorizontal className="size-5" aria-hidden="true" />
              <span>More</span>
              <span className={cn('h-0.5 w-6 rounded-full', moreActive ? 'bg-accent' : 'bg-transparent')} aria-hidden="true" />
            </button>
          </li>
        </ul>
      </nav>
      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="More sections">
        <ul className="grid grid-cols-2 gap-2">
          {secondary.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href, pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={cn('flex items-center gap-3 rounded-lg border px-3 py-3 text-sm font-medium', active ? 'border-charcoal-900 bg-charcoal-50' : 'border-charcoal-200 hover:bg-charcoal-50')}
                >
                  <Icon className="size-5 text-charcoal-600" aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </Dialog>
    </>
  );
}
