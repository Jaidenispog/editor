'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';

/** "Publishing settings" on the Publishing page: the default caption ending (owner only; empty by default, never AI-written). */
export function PublishingSettingsCard({ initialFooter, canEdit }: { initialFooter: string; canEdit: boolean }) {
  const toast = useToast();
  const [footer, setFooter] = useState(initialFooter);
  const [saved, setSaved] = useState(initialFooter);
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader title="Publishing settings" description="Text the composer adds to the end of every new caption, such as your booking link or hashtags. You can change it per post." />
      <CardBody className="space-y-3">
        <Textarea label="Default caption ending" value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={500} rows={3} disabled={!canEdit} hint={canEdit ? `${footer.length} / 500` : 'Only the studio owner can change this.'} />
        {canEdit ? (
          <Button
            className="min-h-11"
            disabled={footer === saved}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await apiRequest<{ captionFooter: string }>('/api/publishing/settings', { method: 'PUT', body: { captionFooter: footer } });
                setSaved(r.captionFooter);
                toast.success('Saved');
              } catch (e) {
                toast.error('Could not save', (e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        ) : null}
      </CardBody>
    </Card>
  );
}
