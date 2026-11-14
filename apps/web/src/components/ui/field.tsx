'use client';

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/shared/cn';

const controlBase =
  'block w-full rounded-[var(--radius-control)] border bg-white px-3 text-sm text-charcoal-900 placeholder:text-charcoal-400 shadow-xs transition-colors ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent disabled:bg-charcoal-50 disabled:text-charcoal-500';

function controlClass(invalid: boolean, extra?: string) {
  return cn(controlBase, invalid ? 'border-red-400' : 'border-charcoal-200 hover:border-charcoal-300', extra);
}

interface FieldChrome {
  label: ReactNode;
  /** Helper text under the control. */
  hint?: ReactNode;
  /** Error text; also marks the control aria-invalid. */
  error?: string | null;
  /** Hide the label visually (still read by screen readers). */
  hideLabel?: boolean;
}

/** Label + control + hint/error wrapper that wires up ids and aria attributes. */
export function Field({ id, label, hint, error, hideLabel, children, className }: FieldChrome & { id: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className={cn('block text-sm font-medium text-charcoal-800', hideLabel && 'sr-only')}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-charcoal-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, error?: string | null, hint?: ReactNode) {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined;
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & FieldChrome & { containerClassName?: string };

/** Labelled text input. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, hideLabel, id, className, containerClassName, ...props }, ref) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field id={inputId} label={label} hint={hint} error={error ?? null} hideLabel={hideLabel ?? false} {...(containerClassName ? { className: containerClassName } : {})}>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, error, hint)}
        className={controlClass(Boolean(error), cn('h-10', className))}
        {...props}
      />
    </Field>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldChrome & { containerClassName?: string };

/** Labelled multi-line text input. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, hideLabel, id, className, containerClassName, rows = 4, ...props },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field id={inputId} label={label} hint={hint} error={error ?? null} hideLabel={hideLabel ?? false} {...(containerClassName ? { className: containerClassName } : {})}>
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, error, hint)}
        className={controlClass(Boolean(error), cn('py-2 leading-relaxed', className))}
        {...props}
      />
    </Field>
  );
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> &
  FieldChrome & { options: Array<{ value: string; label: string; disabled?: boolean }>; containerClassName?: string };

/** Labelled native select (accessible on every device, including phones). */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, hideLabel, id, className, containerClassName, options, ...props },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field id={inputId} label={label} hint={hint} error={error ?? null} hideLabel={hideLabel ?? false} {...(containerClassName ? { className: containerClassName } : {})}>
      <select
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, error, hint)}
        className={controlClass(Boolean(error), cn('h-10 pr-8', className))}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
});
