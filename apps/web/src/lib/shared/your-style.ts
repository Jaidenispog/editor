import { isEditingStyleRow, type EditingStyleRowField, type SummarySuggestion } from '@studio/core';

/**
 * What a row of "Your style from your videos" (`your-style-summary.tsx`) offers, worked out here so it can be tested
 * without a browser. Pure.
 */
export interface SummaryRowActions {
  /** **Use this** / **No thanks** for the suggestion (or, for staff, the read-only line). */
  decide: boolean;
  /** **Change: use each style's own**: a value from the videos is in use on this editing-style row. */
  stop: boolean;
}

export function summaryRowActions(row: Pick<SummarySuggestion, 'field' | 'state' | 'inUse' | 'value'>, canEdit: boolean): SummaryRowActions {
  return {
    decide: row.state === 'open' || row.state === 'dismissed',
    stop: canEdit && isEditingStyleRow(row.field) && (row.state === 'accepted' || (row.inUse && row.value === null)),
  };
}

/** Whether **Go back to each style's own** shows: something from the videos is in use on an editing-style row. */
export function anyStyleFromVideos(rows: ReadonlyArray<Pick<SummarySuggestion, 'field' | 'inUse'>>): boolean {
  return rows.some((r) => r.inUse && isEditingStyleRow(r.field));
}

/**
 * The request **Change: use each style's own** sends for a row: the row's editing-style values back to each style's
 * own, every one accepting it set ("Cutting to the beat" also the beats per cut), with their sources.
 */
export function stopRowRequest(field: EditingStyleRowField): { path: string; method: 'POST'; body: { field: EditingStyleRowField } } {
  return { path: '/api/references/summary/reset', method: 'POST', body: { field } };
}
