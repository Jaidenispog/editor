import type { ReactNode } from 'react';
import { BrandMark } from '@/components/app/brand-mark';
import { maybeSignedUrl } from '@/lib/media-links';
import { getSettingsOrDefaults } from '@/lib/settings';

/** Centred layout for sign-in and first-run setup. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const settings = await getSettingsOrDefaults();
  let logoUrl: string | null = null;
  try {
    logoUrl = await maybeSignedUrl(settings.brand.logoStorageKey);
  } catch {
    logoUrl = null;
  }
  return (
    <div className="flex min-h-dvh flex-col bg-charcoal-950 lg:flex-row">
      <aside className="relative flex flex-col justify-between overflow-hidden px-6 py-8 text-white lg:w-[44%] lg:px-12 lg:py-12">
        <div aria-hidden="true" className="pointer-events-none absolute -top-40 -left-40 size-[28rem] rounded-full bg-accent opacity-20 blur-3xl" />
        <BrandMark appName={settings.brand.appName} businessName={settings.brand.businessName} logoUrl={logoUrl} className="relative" />
        <div className="relative mt-10 hidden max-w-md lg:block">
          <h1 className="text-4xl leading-tight font-semibold">Your haircuts, edited five ways.</h1>
          <p className="mt-4 text-base leading-relaxed text-charcoal-300">
            Drop in the clips from your phone, pick a length and style, and get vertical edits ready for Reels and TikTok.
          </p>
        </div>
        <p className="relative mt-6 hidden text-xs text-charcoal-500 lg:block">Private to {settings.brand.businessName}. Only signed-in staff can see your footage.</p>
      </aside>
      <main className="flex flex-1 items-center justify-center rounded-t-3xl bg-charcoal-50 px-4 py-10 sm:px-6 lg:rounded-t-none lg:rounded-l-3xl">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
