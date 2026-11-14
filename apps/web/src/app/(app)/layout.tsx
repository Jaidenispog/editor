import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/app/brand-mark';
import { MobileNav } from '@/components/app/mobile-nav';
import { SidebarNav } from '@/components/app/sidebar-nav';
import { UserMenu } from '@/components/app/user-menu';
import { maybeSignedUrl } from '@/lib/media-links';
import { getCurrentUser } from '@/lib/session';
import { getSettingsOrDefaults } from '@/lib/settings';

/**
 * Signed-in application shell: charcoal sidebar on large screens, header with brand and user menu, and a
 * bottom tab bar on phones. A missing or stale session is sent to sign in again.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    const path = (await headers()).get('x-studio-pathname') ?? '/';
    redirect(`/api/auth/session-expired?next=${encodeURIComponent(path)}`);
  }
  const settings = await getSettingsOrDefaults();
  const logoUrl = await maybeSignedUrl(settings.brand.logoStorageKey);
  const { appName, businessName } = settings.brand;

  return (
    <div className="min-h-dvh lg:pl-64">
      <a href="#main" className="sr-only z-50 rounded-md bg-white px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-charcoal-950 px-4 py-6 text-white lg:flex">
        <BrandMark appName={appName} businessName={businessName} logoUrl={logoUrl} className="px-2" />
        <div className="mt-8 flex-1 overflow-y-auto">
          <SidebarNav />
        </div>
        <p className="px-3 text-xs text-charcoal-500">
          {/* Breaks only after the dot, never leaving one word alone on the second line. */}
          <span className="whitespace-nowrap">Private studio tools ·</span> <span className="whitespace-nowrap">Melbourne time</span>
        </p>
      </aside>
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-charcoal-200/70 bg-white/90 px-4 backdrop-blur sm:px-6 lg:px-10">
        <BrandMark appName={appName} businessName={businessName} logoUrl={logoUrl} className="text-charcoal-950 lg:hidden" />
        <p className="hidden truncate text-sm text-charcoal-500 lg:block">{businessName}</p>
        <UserMenu displayName={user.displayName} email={user.email} />
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl px-4 pt-8 pb-28 sm:px-6 lg:px-10 lg:pb-12">
        {children}
      </main>
      <MobileNav />
    </div>
  );
}
