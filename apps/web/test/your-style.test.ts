import { describe, expect, it } from 'vitest';
import type { SummarySuggestion } from '@studio/core';
import { anyStyleFromVideos, stopRowRequest, summaryRowActions } from '../src/lib/shared/your-style';

/** The parts of a "Your style from your videos" row the card's actions depend on. */
const row = (field: SummarySuggestion['field'], state: SummarySuggestion['state'], inUse: boolean, value: unknown = 'on') => ({ field, state, inUse, value });

describe('"Your style from your videos" card actions', () => {
  it('sends "Change: use each style\'s own" for the whole row, not just its own value', () => {
    // The reset route resets every value accepting the row set ("Cutting to the beat" also the beats per cut); the card
    // used to send only `editingStyle.beatSync` to PUT /api/settings, which left the beats per cut in use.
    expect(stopRowRequest('beatSync')).toEqual({ path: '/api/references/summary/reset', method: 'POST', body: { field: 'beatSync' } });
    expect(stopRowRequest('transitionPalette').body).toEqual({ field: 'transitionPalette' });
  });

  it('offers the stop on an editing-style row whose value from the videos is in use, to the owner only', () => {
    expect(summaryRowActions(row('beatSync', 'accepted', true), true)).toEqual({ decide: false, stop: true });
    // Still in use with no video behind it.
    expect(summaryRowActions(row('transitionPalette', 'not_measured', true, null), true)).toEqual({ decide: false, stop: true });
    expect(summaryRowActions(row('beatSync', 'accepted', true), false).stop).toBe(false);
    // Length, pace, colour and text are changed in the editing preferences, not stopped here.
    expect(summaryRowActions(row('pacing', 'accepted', true, 'fast'), true).stop).toBe(false);
    // Nothing from the videos in use: a suggestion to decide, no stop.
    expect(summaryRowActions(row('zoom', 'open', false), true)).toEqual({ decide: true, stop: false });
    expect(summaryRowActions(row('zoom', 'dismissed', false), true)).toEqual({ decide: true, stop: false });
    expect(summaryRowActions(row('zoom', 'matches', false), true)).toEqual({ decide: false, stop: false });
  });

  it('shows "Go back to each style\'s own" while any editing-style row is in use', () => {
    expect(anyStyleFromVideos([row('pacing', 'accepted', true), row('beatSync', 'open', false)])).toBe(false);
    expect(anyStyleFromVideos([row('pacing', 'accepted', false), row('beatSync', 'not_measured', true, null)])).toBe(true);
  });
});
