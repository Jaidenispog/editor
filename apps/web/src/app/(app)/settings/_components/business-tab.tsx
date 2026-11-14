'use client';

import { ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { LEGAL_PAGE_KINDS, LEGAL_PAGES, LEGAL_TEXT_MAX, formatDate, suggestedLegalDraft, type AppSettings, type BusinessConfig, type LegalPage, type LegalPageKind } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
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
      { key: 'googleReviewLink', label: 'Google review link', type: 'url', max: 500, placeholder: 'https://g.page/r/…', hint: 'From your Google Business Profile: Read reviews → Get more reviews (on a computer).', wide: true },
      { key: 'googleBusinessProfileName', label: 'Google Business Profile name', max: 160, wide: true },
      { key: 'instagramHandle', label: 'Instagram handle', max: 60, placeholder: 'yourstudio' },
      { key: 'tiktokHandle', label: 'TikTok handle', max: 60, placeholder: 'yourstudio' },
    ],
  },
  {
    title: 'Privacy and terms addresses',
    description: 'Where other services (Meta, Google, Spotify) send people to read your policies.',
    fields: [
      { key: 'privacyUrl', label: 'Privacy policy address', type: 'url', max: 500, placeholder: 'https://', hint: 'Leave blank to use the Privacy policy page below once you publish it.', wide: true },
      { key: 'termsUrl', label: 'Terms address', type: 'url', max: 500, placeholder: 'https://', hint: 'Leave blank to use the Terms of use page below once you publish it.', wide: true },
    ],
  },
];

/** Business details: address, contact, review link, handles, booking link and the public legal pages. */
export function BusinessTab({ business, disabled }: { business: BusinessConfig; disabled: boolean }) {
  const { save, saving, errors } = useSaveSettings('business');
  const [values, setValues] = useState<BusinessConfig>(business);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await save({ ...values, instagramHandle: values.instagramHandle.replace(/^@/, ''), tiktokHandle: values.tiktokHandle.replace(/^@/, '') });
  };

  return (
    <div className="space-y-6">
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
      <LegalPages disabled={disabled} />
    </div>
  );
}

/** Loads the saved legal pages (they are not part of the business section the page passes in). */
function LegalPages({ disabled }: { disabled: boolean }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<{ settings: AppSettings }>('/api/settings', { signal: controller.signal })
      .then((res) => setSettings(res.settings))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setLoadError(err instanceof Error ? err.message : 'The legal pages could not be loaded.');
      });
    return () => controller.abort();
  }, []);

  return (
    <Card>
      <CardHeader
        title="Legal pages"
        description="Public pages for your privacy policy, terms and how to ask for deletion. Meta, Google and the Spotify player need these addresses. Nothing is public until you press Publish."
      />
      <CardBody className="space-y-8">
        {loadError ? <Alert tone="danger">{loadError}</Alert> : null}
        {!settings && !loadError ? <Skeleton className="h-40 w-full" /> : null}
        {settings ? LEGAL_PAGE_KINDS.map((kind) => <LegalPageEditor key={kind} kind={kind} settings={settings} disabled={disabled} onSaved={setSettings} />) : null}
      </CardBody>
    </Card>
  );
}

function LegalPageEditor({ kind, settings, disabled, onSaved }: { kind: LegalPageKind; settings: AppSettings; disabled: boolean; onSaved: (s: AppSettings) => void }) {
  const router = useRouter();
  const toast = useToast();
  const page = settings.legal[kind];
  const b = settings.business;
  const suggested = suggestedLegalDraft(kind, {
    businessName: settings.brand.businessName,
    addressLine: b.addressLine,
    suburb: b.suburb,
    state: b.state,
    postcode: b.postcode,
    email: b.email,
    phone: b.phone,
    website: b.website,
  });
  const [text, setText] = useState(page.draft || page.published || suggested);
  const [busy, setBusy] = useState<'save' | 'publish' | 'unpublish' | null>(null);
  const isPublished = Boolean(page.publishedAt && page.published.trim());
  const unchangedSuggestion = text.trim() === suggested.trim();
  const publishedDiffers = isPublished && text.trim() !== page.published.trim();
  const { title, path } = LEGAL_PAGES[kind];
  const fieldId = `legal-${kind}`;

  const store = async (next: LegalPage, action: 'save' | 'publish' | 'unpublish') => {
    setBusy(action);
    try {
      const res = await apiRequest<{ settings: AppSettings }>('/api/settings', { method: 'PUT', body: { legal: { [kind]: next } } });
      onSaved(res.settings);
      toast.success(action === 'publish' ? `${title} published` : action === 'unpublish' ? `${title} taken down` : 'Draft saved', action === 'publish' ? `It is now public at ${path}.` : undefined);
      router.refresh();
    } catch (err) {
      toast.error('Not saved', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby={`${fieldId}-title`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${fieldId}-title`} className="text-base font-semibold text-charcoal-950">
          {title}
        </h3>
        <div className="flex items-center gap-2">
          {isPublished && page.publishedAt ? <StatusPill status="published" label={`Published ${formatDate(page.publishedAt)}`} /> : <StatusPill status="not_published" />}
          {isPublished ? (
            <a href={path} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-charcoal-900 underline decoration-[var(--accent)] decoration-2 underline-offset-4">
              View <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}
        </div>
      </div>
      {unchangedSuggestion || !isPublished ? (
        <Alert tone="warning" title="Review before publishing">
          This starting draft was written from your business details. It is not legal advice: read it, change anything that does not match how you work, then publish.
        </Alert>
      ) : null}
      {publishedDiffers ? <Alert tone="info">You have changes that are not public yet. Press Publish to update the public page.</Alert> : null}
      <Textarea
        id={fieldId}
        label={`${title} text`}
        hideLabel
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        maxLength={LEGAL_TEXT_MAX}
        disabled={disabled}
        hint="Plain text. Leave a blank line between paragraphs; a short first line becomes the paragraph's heading."
      />
      <CardFooter className="flex flex-wrap justify-end gap-2 border-0 px-0 pb-0">
        {isPublished ? (
          <Button variant="ghost" onClick={() => void store({ ...page, publishedAt: null }, 'unpublish')} loading={busy === 'unpublish'} disabled={disabled || busy !== null}>
            Take down
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => void store({ ...page, draft: text }, 'save')} loading={busy === 'save'} disabled={disabled || busy !== null}>
          Save draft
        </Button>
        <Button onClick={() => void store({ draft: text, published: text, publishedAt: new Date().toISOString() }, 'publish')} loading={busy === 'publish'} disabled={disabled || busy !== null || !text.trim()}>
          Publish
        </Button>
      </CardFooter>
    </section>
  );
}
