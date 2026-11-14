'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { WebsiteOverviewDto } from './types';

const toList = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * "How searches are grouped" (design §4.5): other names for the business, places and service words. Grouping happens
 * when reading, so saving regroups all stored history at once.
 */
export function QueryGroupsEditor({ initial, brandAmbiguous, onSaved }: { initial: WebsiteOverviewDto['queryGroups']; brandAmbiguous: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [brand, setBrand] = useState(initial.brandTerms.join('\n'));
  const [places, setPlaces] = useState(initial.placeTerms.join('\n'));
  const [services, setServices] = useState(initial.serviceTerms.join('\n'));
  const [saving, setSaving] = useState(false);
  return (
    <details className="rounded-lg border border-charcoal-200 p-3">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-charcoal-900">How searches are grouped</summary>
      <div className="mt-2 space-y-3">
        {brandAmbiguous ? (
          <p className="text-sm text-amber-800">
            Your business name uses everyday words, so some searches can&apos;t be told apart. Add a distinctive name or nickname below if you have one.
          </p>
        ) : null}
        <Textarea label="Other names people use for the business" hint="One per line, up to 10." rows={3} value={brand} onChange={(e) => setBrand(e.target.value)} />
        <Textarea
          label="Places"
          hint="Your suburb and postcode are always included. Add nearby suburbs, one per line."
          rows={3}
          value={places}
          onChange={(e) => setPlaces(e.target.value)}
        />
        <Textarea label="Service words" hint="One per line, up to 40." rows={5} value={services} onChange={(e) => setServices(e.target.value)} />
        <Button
          size="sm"
          className="min-h-11"
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await apiRequest('/api/website/query-groups', {
                method: 'PUT',
                body: {
                  brandTerms: toList(brand),
                  placeTerms: toList(places),
                  serviceTerms: toList(services),
                },
              });
              toast.success('Search groups saved');
              onSaved();
            } catch (e) {
              toast.error('Not saved', (e as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          Save groups
        </Button>
      </div>
    </details>
  );
}
