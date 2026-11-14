'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { EditCardExtension, EditCardSlotProps } from './types';

/** "Hide this edit" / "Show again": nothing is deleted; hiding is remembered as feedback for learning. */
function HideButton({ edit, onChanged }: EditCardSlotProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await apiRequest(`/api/edits/${edit.id}/dismiss`, { method: 'POST', body: { value: !edit.dismissed } });
      if (!edit.dismissed) toast.success('Edit hidden', `${edit.styleName} is kept in this generation. Use "Show" under the previews to bring it back.`);
      onChanged();
    } catch (err) {
      toast.error(edit.dismissed ? 'Could not show the edit' : 'Could not hide the edit', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="ghost" onClick={toggle} loading={busy} aria-label={edit.dismissed ? `Show ${edit.styleName} again` : `Hide ${edit.styleName}`}>
      {edit.dismissed ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
      {edit.dismissed ? 'Show again' : 'Hide this edit'}
    </Button>
  );
}

/** A note on a hidden card (shown when the owner chose to see hidden edits). */
function HiddenBanner({ edit }: EditCardSlotProps) {
  if (!edit.dismissed) return null;
  return <p className="rounded-lg bg-charcoal-50 px-3 py-2 text-xs text-charcoal-600">Hidden. It stays in this generation and its history; nothing was deleted.</p>;
}

/** Edit-card additions of the saved preferences module: "Hide this edit" and the hidden note. */
export const preferencesEditCardExtension: EditCardExtension = { id: 'preferences', Banner: HiddenBanner, MenuItems: HideButton };
