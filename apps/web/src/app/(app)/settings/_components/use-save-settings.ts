'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AppSettings } from '@studio/core';
import { useToast } from '@/components/ui/toast';
import { apiRequest, fieldErrors } from '@/lib/client/api-client';

type Section = 'brand' | 'business' | 'preferences';

/** Saves one settings section with PUT /api/settings, shows a toast and refreshes server components. */
export function useSaveSettings(section: Section) {
  const router = useRouter();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = async (values: Partial<AppSettings[Section]>): Promise<AppSettings | null> => {
    setSaving(true);
    setErrors({});
    try {
      const res = await apiRequest<{ settings: AppSettings }>('/api/settings', { method: 'PUT', body: { [section]: values } });
      toast.success('Settings saved');
      router.refresh();
      return res.settings;
    } catch (err) {
      const fe = fieldErrors(err);
      const local: Record<string, string> = {};
      for (const [k, v] of Object.entries(fe)) local[k.startsWith(`${section}.`) ? k.slice(section.length + 1) : k] = v;
      setErrors(local);
      toast.error('Settings not saved', err instanceof Error ? err.message : undefined);
      return null;
    } finally {
      setSaving(false);
    }
  };

  return { save, saving, errors };
}
