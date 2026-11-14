'use client';

import { CheckCircle2, Circle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate } from '@studio/core';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { WebsiteOverviewDto } from './types';

function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      {done ? (
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-label="Done" />
      ) : (
        <Circle className="mt-0.5 size-5 shrink-0 text-charcoal-300" aria-label="Not done" />
      )}
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium text-charcoal-900">{title}</p>
        {children}
      </div>
    </li>
  );
}

/**
 * "Before your first check" (design §4.1): website address, the ownership confirmation, business details that enable
 * more checks, and the manual Business Profile comparison. Collapses to one line once the required steps are done.
 */
export function SetupChecklist({ overview, onChanged }: { overview: WebsiteOverviewDto; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const s = overview.setup;
  const ready = s.websiteValid && s.ownershipConfirmed;
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const details = [s.profileDetails.name, s.profileDetails.address, s.profileDetails.phone, ...s.profileDetails.hours].filter(Boolean).join('\n');
  if (ready && !expanded) {
    return (
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-2 py-4">
          <p className="text-sm text-charcoal-700">
            Checking <span className="font-medium text-charcoal-900">{s.host}</span>
            {s.missingDetails.length ? ` · ${s.missingDetails.length} business detail${s.missingDetails.length === 1 ? '' : 's'} missing` : ''}
            {s.profileDetailsCheckedAt ? ` · Business Profile checked ${formatDate(s.profileDetailsCheckedAt)}` : ''}
          </p>
          <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setExpanded(true)}>
            Show setup
          </Button>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Before your first check" description="Two quick steps, then a few optional details that let the check compare more." />
      <CardBody>
        <ol className="space-y-5">
          <Step done={s.websiteValid} title="Website address">
            {s.websiteValid ? (
              <p className="text-sm text-charcoal-600">{s.host}</p>
            ) : (
              <p className="text-sm text-charcoal-600">
                {s.website ? `"${s.website}" isn't a plain web address. ` : ''}
                Add your website address in Settings → Business.{' '}
                <Link href="/settings?tab=business" className="font-medium underline underline-offset-2">
                  Open Business settings
                </Link>
              </p>
            )}
          </Step>
          <Step done={s.ownershipConfirmed} title="This is my website">
            {s.ownershipConfirmed ? (
              <p className="text-sm text-charcoal-600">
                Confirmed
                {s.ownershipConfirmedAt ? ` on ${formatDate(s.ownershipConfirmedAt)}` : ''}.
              </p>
            ) : (
              <label className="flex min-h-11 items-start gap-2 text-sm text-charcoal-700">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5"
                  disabled={!s.websiteValid || busy === 'own'}
                  onChange={(e) => {
                    if (e.target.checked)
                      void act(
                        'own',
                        () =>
                          apiRequest('/api/website/ownership', {
                            method: 'POST',
                            body: { confirm: true },
                          }),
                        'Website confirmed',
                      );
                  }}
                />
                <span>This is my business&apos;s own website and I&apos;m allowed to have it checked.</span>
              </label>
            )}
          </Step>
          <Step done={s.missingDetails.length === 0} title="Business details (recommended)">
            {s.missingDetails.length ? (
              <ul className="space-y-1 text-sm text-charcoal-600">
                {s.missingDetails.map((m) => (
                  <li key={m.field}>{m.enables}</li>
                ))}
                <li>
                  <Link
                    href={s.missingDetails.some((m) => m.field === 'businessName') ? '/settings?tab=branding' : '/settings?tab=business'}
                    className="font-medium underline underline-offset-2"
                  >
                    Add them in Settings
                  </Link>
                </li>
              </ul>
            ) : (
              <p className="text-sm text-charcoal-600">All set.</p>
            )}
          </Step>
          <Step done={Boolean(s.profileDetailsCheckedAt)} title="Google Business Profile details (optional)">
            <p className="text-sm text-charcoal-600">
              Open your Business Profile on Google and check it shows exactly these details. Mismatched details confuse customers and Google.
            </p>
            {details ? <pre className="max-w-full overflow-x-auto rounded-md bg-charcoal-50 p-3 text-xs whitespace-pre-wrap text-charcoal-800">{details}</pre> : null}
            <div className="flex flex-wrap items-center gap-3">
              {details ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="min-h-11"
                  onClick={() => {
                    void navigator.clipboard?.writeText(details).then(
                      () => toast.success('Copied'),
                      () => toast.error('Could not copy'),
                    );
                  }}
                >
                  Copy
                </Button>
              ) : null}
              <label className="flex min-h-11 items-center gap-2 text-sm text-charcoal-700">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={Boolean(s.profileDetailsCheckedAt)}
                  disabled={busy === 'profile'}
                  onChange={(e) =>
                    void act(
                      'profile',
                      () =>
                        apiRequest('/api/website/profile-check', {
                          method: 'PUT',
                          body: { checked: e.target.checked },
                        }),
                      e.target.checked ? 'Marked as checked' : 'Cleared',
                    )
                  }
                />
                I&apos;ve checked my Business Profile matches
                {s.profileDetailsCheckedAt ? ` (checked ${formatDate(s.profileDetailsCheckedAt)})` : ''}
              </label>
            </div>
          </Step>
        </ol>
        {ready ? (
          <button type="button" className={buttonClasses('ghost', 'sm', 'mt-4 min-h-11')} onClick={() => setExpanded(false)}>
            Hide setup
          </button>
        ) : null}
      </CardBody>
    </Card>
  );
}
