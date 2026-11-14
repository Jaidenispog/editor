'use client';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { WebsiteEditDto } from './types';

/**
 * The explicit confirmation before a live change (design §4.4): destination (amber for a staging site), the page, the
 * exact before/after, and that WordPress keeps the previous version. "Apply now" sends the wording shown here.
 */
export function ApplyDialog({ edit, open, busy, onClose, onConfirm }: { edit: WebsiteEditDto; open: boolean; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const d = edit.destination;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Apply this change to your website?"
      footer={
        <>
          <Button variant="ghost" className="min-h-11" onClick={onClose}>
            Cancel
          </Button>
          <Button className="min-h-11" loading={busy} onClick={onConfirm}>
            Apply now
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm [overflow-wrap:anywhere]">
        {d ? (
          d.environment === 'staging' ? (
            <Alert tone="warning">WordPress at {d.host} — a staging site, not your public website.</Alert>
          ) : (
            <p className="text-charcoal-700">WordPress at {d.host} — your public website.</p>
          )
        ) : null}
        <p className="text-charcoal-700">Page: {edit.pageUrl}</p>
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-charcoal-500">Before</p>
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-charcoal-50 p-2 text-xs whitespace-pre-wrap">
              {'before' in edit.change && edit.change.before ? edit.change.before : '(nothing)'}
            </pre>
          </div>
          <div>
            <p className="text-xs font-medium text-charcoal-500">After</p>
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-charcoal-50 p-2 text-xs whitespace-pre-wrap">{edit.change.after || '(removed)'}</pre>
          </div>
        </div>
        <p className="text-charcoal-700">This changes your website immediately. WordPress keeps the previous version in the page&apos;s revisions.</p>
        {edit.firstLiveApply && d?.environment === 'live' ? <Alert tone="warning">This will be the first change Studio Assistant makes to your live website.</Alert> : null}
      </div>
    </Dialog>
  );
}
