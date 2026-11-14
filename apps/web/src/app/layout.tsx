import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { CSSProperties, ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/toast';
import { getSettingsOrDefaults } from '@/lib/settings';
import { accentCssVariables } from '@/lib/shared/accent';
import './globals.css';

/** Page title uses the configured app name. */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const settings = await getSettingsOrDefaults();
  return {
    title: { default: settings.brand.appName, template: `%s · ${settings.brand.appName}` },
    description: `${settings.brand.businessName} — private studio tools`,
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  themeColor: '#17181a',
  width: 'device-width',
  initialScale: 1,
};

/** Root layout: injects the accent colour from Settings → Branding as CSS variables. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const settings = await getSettingsOrDefaults();
  const style = accentCssVariables(settings.brand.accentColour) as CSSProperties;
  return (
    <html lang="en-AU" style={style}>
      <body className="min-h-dvh">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
