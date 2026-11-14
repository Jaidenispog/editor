import type { ReactNode } from 'react';

/**
 * Page title block. `status` (for example a provider status pill) sits right after the title, so it reads as the
 * page's state; `actions` (buttons) go to the right on wider screens.
 */
export function PageHeader({ title, description, actions, eyebrow, status }: { title: string; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode; status?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 text-xs font-semibold tracking-wide text-charcoal-500 uppercase">{eyebrow}</div> : null}
        {status ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl font-semibold text-charcoal-950 sm:text-3xl">{title}</h1>
            <div className="flex shrink-0 items-center gap-2">{status}</div>
          </div>
        ) : (
          <h1 className="text-2xl font-semibold text-charcoal-950 sm:text-3xl">{title}</h1>
        )}
        {description ? <p className="mt-2 max-w-2xl text-sm leading-relaxed text-charcoal-600 sm:text-base">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
