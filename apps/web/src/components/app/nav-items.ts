import { CalendarDays, Clapperboard, Globe, LayoutDashboard, Library, Mail, Send, Settings, Star, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile bottom bar (the rest live under "More"). */
  primary: boolean;
}

/** Main navigation, in display order. */
export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, primary: true },
  { href: '/studio', label: 'Video Studio', icon: Clapperboard, primary: true },
  { href: '/library', label: 'Content Library', icon: Library, primary: true },
  { href: '/publishing', label: 'Publishing', icon: Send, primary: false },
  { href: '/appointments', label: 'Appointments', icon: CalendarDays, primary: false },
  { href: '/emails', label: 'Emails', icon: Mail, primary: false },
  { href: '/reviews', label: 'Reviews', icon: Star, primary: false },
  { href: '/website', label: 'Website', icon: Globe, primary: false },
  { href: '/settings', label: 'Settings', icon: Settings, primary: false },
];

/** True when `pathname` belongs to the nav item (exact for the dashboard, prefix otherwise). */
export function isActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
