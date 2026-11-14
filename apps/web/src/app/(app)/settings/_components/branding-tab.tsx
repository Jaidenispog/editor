'use client';

/* eslint-disable @next/next/no-img-element -- logo comes from an expiring signed link */
import { ImageUp, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import type { BrandConfig } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { accentCssVariables } from '@/lib/shared/accent';
import { useSaveSettings } from './use-save-settings';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Branding: names, accent colour (with live preview), logo, fonts, in-video text style and social handle. */
export function BrandingTab({ brand, logoUrl, disabled }: { brand: BrandConfig; logoUrl: string | null; disabled: boolean }) {
  const { save, saving, errors } = useSaveSettings('brand');
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState({
    appName: brand.appName,
    businessName: brand.businessName,
    tagline: brand.tagline,
    accentColour: brand.accentColour,
    fontHeadline: brand.fontHeadline,
    fontBody: brand.fontBody,
    videoTextStyle: brand.videoTextStyle,
    socialHandle: brand.socialHandle,
  });
  const [uploading, setUploading] = useState(false);
  const set = <K extends keyof typeof values>(k: K, v: (typeof values)[K]) => setValues((s) => ({ ...s, [k]: v }));
  const previewVars = accentCssVariables(HEX.test(values.accentColour) ? values.accentColour : brand.accentColour);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await save({ ...values, socialHandle: values.socialHandle.replace(/^@/, '') });
  };

  const uploadLogo = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.set('file', file);
      await apiRequest('/api/settings/logo', { method: 'POST', body: form });
      toast.success('Logo updated');
      router.refresh();
    } catch (err) {
      toast.error('Logo not uploaded', err instanceof Error ? err.message : undefined);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeLogo = async () => {
    setUploading(true);
    try {
      await apiRequest('/api/settings/logo', { method: 'DELETE' });
      toast.success('Logo removed');
      router.refresh();
    } catch (err) {
      toast.error('Logo not removed', err instanceof Error ? err.message : undefined);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <form onSubmit={submit} className="lg:col-span-2">
        <Card>
          <CardHeader title="Brand" description="Shown in the app and used for text inside your videos." />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            <Input label="App name" value={values.appName} onChange={(e) => set('appName', e.target.value)} maxLength={60} disabled={disabled} error={errors['appName'] ?? null} />
            <Input label="Business name" value={values.businessName} onChange={(e) => set('businessName', e.target.value)} maxLength={80} disabled={disabled} error={errors['businessName'] ?? null} hint="Used in promo edits and emails." />
            <Input label="Tagline" value={values.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={120} disabled={disabled} containerClassName="sm:col-span-2" error={errors['tagline'] ?? null} />
            <div className="space-y-1.5 sm:col-span-2">
              <label htmlFor="accent-colour" className="block text-sm font-medium text-charcoal-800">
                Accent colour
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  id="accent-colour"
                  type="color"
                  value={HEX.test(values.accentColour) ? values.accentColour : '#C8A24A'}
                  onChange={(e) => set('accentColour', e.target.value.toUpperCase())}
                  disabled={disabled}
                  className="h-10 w-14 cursor-pointer rounded-[var(--radius-control)] border border-charcoal-200 bg-white p-1"
                />
                <Input label="Hex value" hideLabel value={values.accentColour} onChange={(e) => set('accentColour', e.target.value)} maxLength={7} disabled={disabled} className="w-32 font-mono" error={errors['accentColour'] ?? null} />
                <div style={previewVars} className="flex items-center gap-2 rounded-[var(--radius-control)] border border-charcoal-200 bg-white px-3 py-2" aria-label="Accent preview">
                  <span className="rounded-md px-3 py-1 text-sm font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}>
                    Button
                  </span>
                  <span className="rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ background: 'var(--accent-soft)' }}>
                    Highlight
                  </span>
                  <span className="text-sm underline decoration-2 underline-offset-4" style={{ textDecorationColor: 'var(--accent)' }}>
                    Link
                  </span>
                </div>
              </div>
              <p className="text-sm text-charcoal-500">One colour used for highlights across the app. Text on top of it switches between charcoal and white automatically for readability.</p>
            </div>
            <Select
              label="Headline font"
              value={values.fontHeadline}
              onChange={(e) => set('fontHeadline', e.target.value as BrandConfig['fontHeadline'])}
              disabled={disabled}
              options={['Inter Display', 'Inter', 'DejaVu Sans', 'Liberation Sans'].map((f) => ({ value: f, label: f }))}
            />
            <Select
              label="Body font"
              value={values.fontBody}
              onChange={(e) => set('fontBody', e.target.value as BrandConfig['fontBody'])}
              disabled={disabled}
              options={['Inter', 'DejaVu Sans', 'Liberation Sans'].map((f) => ({ value: f, label: f }))}
            />
            <Select
              label="Text style in videos"
              value={values.videoTextStyle}
              onChange={(e) => set('videoTextStyle', e.target.value as BrandConfig['videoTextStyle'])}
              disabled={disabled}
              hint="How titles and captions look on screen."
              options={[
                { value: 'minimal', label: 'Minimal — small, clean, out of the way' },
                { value: 'bold', label: 'Bold — large, high contrast' },
                { value: 'editorial', label: 'Editorial — refined, magazine feel' },
              ]}
            />
            <Input
              label="Social handle (optional)"
              value={values.socialHandle}
              onChange={(e) => set('socialHandle', e.target.value)}
              maxLength={40}
              disabled={disabled}
              placeholder="yourstudio"
              hint="Shown at the end of promo edits when the style uses it."
              error={errors['socialHandle'] ?? null}
            />
          </CardBody>
          <CardFooter>
            <Button type="submit" loading={saving} disabled={disabled}>
              Save branding
            </Button>
          </CardFooter>
        </Card>
      </form>
      <Card>
        <CardHeader title="Logo" description="PNG, JPEG or WebP, up to 2 MB. A square image works best." />
        <CardBody>
          <div className="flex aspect-square w-full items-center justify-center rounded-xl border border-dashed border-charcoal-200 bg-charcoal-50">
            {logoUrl ? <img src={logoUrl} alt="Current logo" className="max-h-[80%] max-w-[80%] object-contain" /> : <p className="px-6 text-center text-sm text-charcoal-500">No logo yet. The app shows your initials instead.</p>}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            id="logo-file"
            disabled={disabled || uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadLogo(f);
            }}
          />
        </CardBody>
        <CardFooter className="justify-between">
          {logoUrl ? (
            <Button variant="ghost" onClick={removeLogo} disabled={disabled || uploading}>
              <Trash2 className="size-4" aria-hidden="true" /> Remove
            </Button>
          ) : (
            <span />
          )}
          <Button variant="secondary" onClick={() => fileRef.current?.click()} loading={uploading} disabled={disabled}>
            <ImageUp className="size-4" aria-hidden="true" /> {logoUrl ? 'Replace logo' : 'Upload logo'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
