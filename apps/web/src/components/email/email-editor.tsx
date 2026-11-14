'use client';

import { useEffect, useRef, useState } from 'react';
import { EMAIL_VARIABLES, type MessageClass } from '@studio/core';
import { Input, Textarea } from '@/components/ui/field';
import { apiRequest } from '@/lib/client/api-client';
import type { LintDto } from './types';

/** A sandboxed preview of a rendered email (no scripts, no same-origin access). */
export function EmailPreviewFrame({ html, title = 'Email preview' }: { html: string; title?: string }) {
  return <iframe title={title} sandbox="" srcDoc={html} className="h-[420px] w-full rounded-[var(--radius-control)] border border-charcoal-200 bg-white" />;
}

/** The live lint result: errors block approval; warnings do not. */
export function LintPanel({ lint }: { lint: LintDto | null }) {
  if (!lint) return null;
  if (!lint.errors.length && !lint.warnings.length) return <p className="text-sm text-emerald-700">No problems found.</p>;
  return (
    <ul className="space-y-1 text-sm" aria-live="polite">
      {lint.errors.map((e, i) => (
        <li key={`e${i}`} className="text-red-700">
          {e.message}
        </li>
      ))}
      {lint.warnings.map((w, i) => (
        <li key={`w${i}`} className="text-amber-800">
          {w.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * Subject and body editor with variable chips, the live linter and an exact preview (through `/api/email/lint`,
 * debounced 400 ms; no side effects). The preview shows personal links as markers.
 */
export function EmailEditor({
  messageClass,
  subject,
  bodyMarkdown,
  onChange,
  customerId,
  disabled,
  onLint,
}: {
  messageClass: MessageClass;
  subject: string;
  bodyMarkdown: string;
  onChange: (next: { subject: string; bodyMarkdown: string }) => void;
  customerId?: string | null;
  disabled?: boolean;
  onLint?: (lint: LintDto) => void;
}) {
  const [lint, setLint] = useState<LintDto | null>(null);
  const [html, setHtml] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const onLintRef = useRef(onLint);
  useEffect(() => {
    onLintRef.current = onLint;
  }, [onLint]);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await apiRequest<LintDto & { preview: { html: string } }>('/api/email/lint', { method: 'POST', body: { messageClass, subject, bodyMarkdown, customerId: customerId ?? null }, signal: ctrl.signal });
        setLint({ errors: r.errors, warnings: r.warnings });
        setHtml(r.preview.html);
        onLintRef.current?.({ errors: r.errors, warnings: r.warnings });
      } catch {
        // A failed preview is not an error for the owner; the next keystroke tries again.
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [messageClass, subject, bodyMarkdown, customerId]);

  const insert = (name: string) => {
    const el = bodyRef.current;
    const token = `{{${name}}}`;
    if (!el) return onChange({ subject, bodyMarkdown: bodyMarkdown + token });
    const start = el.selectionStart ?? bodyMarkdown.length;
    const end = el.selectionEnd ?? start;
    onChange({ subject, bodyMarkdown: bodyMarkdown.slice(0, start) + token + bodyMarkdown.slice(end) });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="min-w-0 space-y-3">
        <Input label="Subject" value={subject} maxLength={200} disabled={disabled} onChange={(e) => onChange({ subject: e.target.value, bodyMarkdown })} />
        <Textarea
          ref={bodyRef}
          label="Email"
          rows={10}
          value={bodyMarkdown}
          disabled={disabled}
          hint="**bold**, *italic*, - lists and [link text](https://…). HTML isn't allowed."
          onChange={(e) => onChange({ subject, bodyMarkdown: e.target.value })}
        />
        <div className="flex flex-wrap gap-1.5" aria-label="Insert a variable">
          {EMAIL_VARIABLES.map((v) => (
            <button key={v} type="button" disabled={disabled} onClick={() => insert(v)} className="min-h-9 rounded-full border border-charcoal-200 bg-white px-3 text-xs font-medium text-charcoal-700 hover:bg-charcoal-50 disabled:opacity-50">
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        <LintPanel lint={lint} />
      </div>
      <div className="min-w-0">
        <p className="mb-1.5 text-sm font-medium text-charcoal-800">Preview</p>
        <EmailPreviewFrame html={html} />
      </div>
    </div>
  );
}
