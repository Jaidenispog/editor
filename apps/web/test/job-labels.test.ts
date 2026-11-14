import { describe, expect, it } from 'vitest';
import { ALL_JOB_TYPES } from '@studio/core';
import { JOB_TYPE_LABELS } from '../src/lib/shared/dto';

describe('job type labels', () => {
  it('every registered job type has a plain label (the owner never sees a raw internal name)', () => {
    const missing = ALL_JOB_TYPES.filter((t) => !JOB_TYPE_LABELS[t]?.trim());
    expect(missing).toEqual([]);
    for (const t of ALL_JOB_TYPES) {
      const label = JOB_TYPE_LABELS[t] ?? '';
      expect(label, t).not.toContain('.');
      expect(label, t).not.toContain('_');
    }
  });

  it('uses Australian spelling', () => {
    const all = Object.values(JOB_TYPE_LABELS).join(' ');
    expect(all).not.toMatch(/analyz|color\b|favorite|license\b/i);
  });
});
