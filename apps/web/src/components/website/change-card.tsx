'use client';

import { useState } from 'react';
import { formatDateTime } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { ApplyDialog } from './apply-dialog';
import { DraftOptions } from './draft-options';
import { InstructionsDialog } from './instructions-dialog';
import type { WebsiteEditDto } from './types';

const SOURCE_LABELS: Record<WebsiteEditDto['source'], string> = {
  audit_rule: 'Suggested from your business details',
  ai_draft: 'AI wording — check before using',
  owner: 'Written by you',
  undo: 'Undo of an earlier change',
};

function counter(edit: WebsiteEditDto): string | null {
  const n = edit.change.after.length;
  if (edit.change.kind === 'page_title') return `${n} characters (aim for 30–60; approximate, Google decides how much to show)`;
  if (edit.change.kind === 'meta_description') return `${n} characters (aim for 70–160; approximate, Google decides how much to show)`;
  return null;
}

function verificationLine(edit: WebsiteEditDto): string | null {
  switch (edit.verification) {
    case 'confirmed_public':
      return 'Visible on the public page.';
    case 'confirmed_api':
      return 'Confirmed through WordPress.';
    case 'not_visible':
      return 'Not visible on the public page yet; your site may cache pages for a while.';
    case 'pending':
      return 'Your next website check confirms it.';
    default:
      return null;
  }
}

/** One prepared change (design §4.3): before/after, why, and the owner's actions. Text from pages is shown as text. */
export function ChangeCard({ edit, aiAvailable, onChanged }: { edit: WebsiteEditDto; aiAvailable: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(edit.change.after);
  const [applyOpen, setApplyOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const open = edit.status === 'proposed' || edit.status === 'apply_failed';
  const act = async (key: string, fn: () => Promise<unknown>, done: string | null) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
      onChanged();
      return true;
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const isCode = edit.change.kind === 'structured_data' || edit.change.kind === 'robots_txt' || edit.change.kind === 'head_snippet';
  const before = 'before' in edit.change ? edit.change.before : null;
  return (
    <article className="space-y-3 rounded-lg border border-charcoal-200 bg-white p-4" id={`change-${edit.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-charcoal-900">{edit.title}</h3>
          <p className="text-xs text-charcoal-500 [overflow-wrap:anywhere]">
            {edit.pageUrl} · {SOURCE_LABELS[edit.source]}
          </p>
        </div>
        <StatusPill status={edit.status} />
      </header>
      {edit.statusMessage ? (
        <Alert tone={edit.status === 'apply_failed' ? 'danger' : edit.status === 'superseded' || edit.status === 'rejected' ? 'info' : 'success'}>{edit.statusMessage}</Alert>
      ) : null}
      <div className="grid gap-2 md:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-charcoal-500">Before</p>
          <pre className={`mt-1 max-h-48 overflow-auto rounded-md bg-charcoal-50 p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere] ${isCode ? 'font-mono' : 'font-sans'}`}>
            {before || '(nothing yet)'}
          </pre>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-charcoal-500">After</p>
          {editing ? (
            <Textarea label="New wording" hideLabel value={draft} onChange={(e) => setDraft(e.target.value)} rows={isCode ? 8 : 3} maxLength={5000} />
          ) : (
            <pre className={`mt-1 max-h-48 overflow-auto rounded-md bg-emerald-50 p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere] ${isCode ? 'font-mono' : 'font-sans'}`}>
              {edit.change.after || '(removed)'}
            </pre>
          )}
          {counter(edit) ? <p className="mt-1 text-xs text-charcoal-500">{counter(edit)}</p> : null}
        </div>
      </div>
      {edit.rationale ? <p className="text-sm text-charcoal-600">Why: {edit.rationale}</p> : null}
      {warnings.length ? (
        <Alert tone="warning" title="Saved, but check this wording">
          {warnings.join(' ')}
        </Alert>
      ) : null}
      {edit.status === 'applied' ? (
        <p className="text-sm text-charcoal-700">
          {edit.appliedVia === 'wordpress' ? 'Changed through WordPress' : 'Made by hand'}
          {edit.appliedAt ? ` on ${formatDateTime(edit.appliedAt)}` : ''}. {verificationLine(edit)}
        </p>
      ) : null}
      {open && edit.aiOptions.length ? (
        <DraftOptions
          options={edit.aiOptions}
          busy={busy === 'choose'}
          onChoose={(i) =>
            void act(
              'choose',
              () =>
                apiRequest(`/api/website/edits/${edit.id}/choose-draft`, {
                  method: 'POST',
                  body: { index: i },
                }),
              'Wording copied into the change',
            )
          }
        />
      ) : null}
      {rejecting ? (
        <div className="space-y-2">
          <Textarea label="Why are you dismissing it? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} rows={2} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="min-h-11"
              loading={busy === 'reject'}
              onClick={() =>
                void act(
                  'reject',
                  () =>
                    apiRequest(`/api/website/edits/${edit.id}/reject`, {
                      method: 'POST',
                      body: reason.trim() ? { reason: reason.trim() } : {},
                    }),
                  'Dismissed',
                )
              }
            >
              Dismiss
            </Button>
            <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setRejecting(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {open && !editing ? (
          <Button size="sm" className="min-h-11" disabled={!edit.applyAvailable.ok} onClick={() => setApplyOpen(true)} title={edit.applyAvailable.reason ?? undefined}>
            Apply to website
          </Button>
        ) : null}
        {open && editing ? (
          <>
            <Button
              size="sm"
              className="min-h-11"
              loading={busy === 'save'}
              onClick={async () => {
                setBusy('save');
                try {
                  const res = await apiRequest<{ warnings: string[] }>(`/api/website/edits/${edit.id}`, { method: 'PATCH', body: { after: draft } });
                  setWarnings(res.warnings);
                  setEditing(false);
                  toast.success('Wording saved');
                  onChanged();
                } catch (e) {
                  toast.error('Not saved', (e as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              Save wording
            </Button>
            <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : null}
        {open && !editing ? (
          <Button
            size="sm"
            variant="secondary"
            className="min-h-11"
            onClick={() => {
              setDraft(edit.change.after);
              setEditing(true);
            }}
          >
            Edit wording
          </Button>
        ) : null}
        {open && aiAvailable && edit.canDraft ? (
          <Button
            size="sm"
            variant="secondary"
            className="min-h-11"
            loading={busy === 'draft'}
            onClick={() =>
              void act(
                'draft',
                () =>
                  apiRequest(`/api/website/edits/${edit.id}/draft`, {
                    method: 'POST',
                    body: {},
                  }),
                'Writing suggestions…',
              )
            }
          >
            Suggest wording
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" className="min-h-11" onClick={() => setStepsOpen(true)}>
          Copy steps
        </Button>
        {open ? (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11"
            loading={busy === 'done'}
            onClick={() =>
              void act(
                'done',
                () =>
                  apiRequest(`/api/website/edits/${edit.id}/mark-done`, {
                    method: 'POST',
                    body: {},
                  }),
                'Marked as done',
              )
            }
          >
            I&apos;ve made this change
          </Button>
        ) : null}
        {open && !rejecting ? (
          <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setRejecting(true)}>
            Dismiss
          </Button>
        ) : null}
        {edit.canUndo ? (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11"
            loading={busy === 'undo'}
            onClick={() =>
              void act(
                'undo',
                () =>
                  apiRequest(`/api/website/edits/${edit.id}/undo`, {
                    method: 'POST',
                    body: {},
                  }),
                'Undo prepared — apply it from "To review"',
              )
            }
          >
            Undo
          </Button>
        ) : null}
      </div>
      {open && !edit.applyAvailable.ok && edit.applyAvailable.reason ? <p className="text-xs text-charcoal-500">{edit.applyAvailable.reason}</p> : null}
      <ApplyDialog
        edit={edit}
        open={applyOpen}
        busy={busy === 'apply'}
        onClose={() => setApplyOpen(false)}
        onConfirm={() =>
          void act(
            'apply',
            () =>
              apiRequest(`/api/website/edits/${edit.id}/apply`, {
                method: 'POST',
                // Everything the dialog showed, so the approval covers exactly that (design §4.4).
                body: {
                  confirm: true,
                  expectedAfter: edit.change.after,
                  expectedBefore: 'before' in edit.change ? edit.change.before : null,
                  ...(edit.destination ? { expectedDestination: edit.destination } : {}),
                },
              }),
            'Applying the change…',
          ).then((ok) => {
            if (ok) setApplyOpen(false);
          })
        }
      />
      <InstructionsDialog edit={edit} open={stepsOpen} onClose={() => setStepsOpen(false)} />
    </article>
  );
}
