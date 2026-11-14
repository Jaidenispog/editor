'use client';

import { useState, type FormEvent } from 'react';
import type { BusinessConfig } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { useSaveSettings } from './use-save-settings';

type FieldDef = { key: keyof BusinessConfig; label: string; type?: string; hint?: string; max: number; placeholder?: string; wide?: boolean };

const GROUPS: Array<{ title: string; description: string; fields: FieldDef[] }> = [
  {
    title: 'Address',
    description: 'Used on your website checks and in emails.',
    fields: [
      { key: 'addressLine', label: 'Street address', max: 160, wide: true },
      { key: 'suburb', label: 'Suburb', max: 80 },
      { key: 'state', label: 'State', max: 40 },
      { key: 'postcode', label: 'Postcode', max: 10 },
      { key: 'country', label: 'Country', max: 40 },
    ],
  },
  {
    title: 'Contact',
    description: 'How clients reach you.',
    fields: [
      { key: 'phone', label: 'Phone', type: 'tel', max: 40, placeholder: '03 9000 0000' },
      { key: 'email', label: 'Email', type: 'email', max: 120 },
      { key: 'website', label: 'Website', type: 'url', max: 300, placeholder: 'https://', wide: true },
      { key: 'bookingLink', label: 'Booking link', type: 'url', max: 500, placeholder: 'https://', hint: 'Where clients book, e.g. your Square booking page.', wide: true },
    ],
  },
  {
    title: 'Reviews and social',
    description: 'Links used for review requests and on video end cards.',
    fields: [
      { key: 'googleReviewLink', label: 'Google review link', type: 'url', max: 500, placeholder: 'https://g.page/r/…', hint: 'From your Google Business Profile: “Ask for reviews”.', wide: true },
      { key: 'googleBusinessProfileName', label: 'Google Business Profile name', max: 160, wide: true },
      { key: 'instagramHandle', label: 'Instagram handle', max: 60, placeholder: 'yourstudio' },
      { key: 'tiktokHandle', label: 'TikTok handle', max: 60, placeholder: 'yourstudio' },
    ],
  },
];

/** Business details: address, contact, review link, handles and booking link. */
export function BusinessTab({ business, disabled }: { business: BusinessConfig; disabled: boolean }) {
  const { save, saving, errors } = useSaveSettings('business');
  const [values, setValues] = useState<BusinessConfig>(business);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await save({ ...values, instagramHandle: values.instagramHandle.replace(/^@/, ''), tiktokHandle: values.tiktokHandle.replace(/^@/, '') });
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      {GROUPS.map((g) => (
        <Card key={g.title}>
          <CardHeader title={g.title} description={g.description} />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            {g.fields.map((f) => (
              <Input
                key={f.key}
                label={f.label}
                type={f.type ?? 'text'}
                value={values[f.key]}
                onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                maxLength={f.max}
                disabled={disabled}
                containerClassName={f.wide ? 'sm:col-span-2' : undefined}
                {...(f.placeholder ? { placeholder: f.placeholder } : {})}
                {...(f.hint ? { hint: f.hint } : {})}
                error={errors[f.key] ?? null}
              />
            ))}
          </CardBody>
        </Card>
      ))}
      <div className="flex justify-end">
        <Button type="submit" loading={saving} disabled={disabled}>
          Save business details
        </Button>
      </div>
    </form>
  );
}
