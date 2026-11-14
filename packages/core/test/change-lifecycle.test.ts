import { describe, expect, it } from 'vitest';
import { editDedupeKey, observeChange, refreshChange, supersedeReason, verificationFromObservation, type WebsiteChange } from '../src/index.js';
import { page, ROOT } from './website-fixtures.js';

const title = (after: string, before: string | null = 'Home'): WebsiteChange => ({ kind: 'page_title', pageUrl: ROOT, before, after });

describe('prepared change lifecycle', () => {
  it('dedupes one open change per page per kind, and per target text for replacements and images', () => {
    expect(editDedupeKey(title('A long enough title'))).toBe(editDedupeKey(title('Another long title', 'Other')));
    expect(editDedupeKey(title('A long enough title'))).toBe(
      editDedupeKey({
        ...title('A long enough title'),
        pageUrl: `${ROOT}?utm_source=x#top`,
      }),
    );
    const a: WebsiteChange = {
      kind: 'text_replace',
      pageUrl: ROOT,
      before: '03 9000 0000',
      after: '03 9499 1234',
    };
    const b: WebsiteChange = { ...a, before: '03 9111 1111' };
    expect(editDedupeKey(a)).not.toBe(editDedupeKey(b));
    const img = (src: string): WebsiteChange => ({
      kind: 'image_alt_text',
      pageUrl: ROOT,
      imageSrc: src,
      before: null,
      after: 'Fade',
    });
    expect(editDedupeKey(img('a.jpg'))).not.toBe(editDedupeKey(img('b.jpg')));
  });

  it('refreshes rule wording but keeps the owner’s and the AI’s', () => {
    const fresh = title('Ivanhoe Barber Co | Barber in Ivanhoe', 'Welcome');
    expect(refreshChange(title('Old rule text here'), 'audit_rule', fresh)).toEqual(fresh);
    expect(refreshChange(title('Owner wrote this title'), 'owner', fresh)).toEqual({ ...title('Owner wrote this title'), before: 'Welcome' });
    expect(refreshChange(title('AI suggested this one'), 'ai_draft', fresh).after).toBe('AI suggested this one');
  });

  it('supersedes when the finding is gone or the page changed', () => {
    const base = {
      status: 'proposed' as const,
      source: 'audit_rule' as const,
      change: title('New title for the page'),
      findingKey: 'title_length:abc',
    };
    expect(
      supersedeReason({
        ...base,
        currentFindingKeys: new Set(),
        observation: { beforePresent: true, afterPresent: false },
      }),
    ).toBe('finding_gone');
    expect(
      supersedeReason({
        ...base,
        currentFindingKeys: new Set(['title_length:abc']),
        observation: { beforePresent: false, afterPresent: false },
      }),
    ).toBe('page_changed');
    expect(
      supersedeReason({
        ...base,
        currentFindingKeys: new Set(['title_length:abc']),
        observation: { beforePresent: true, afterPresent: false },
      }),
    ).toBeNull();
    expect(
      supersedeReason({
        ...base,
        source: 'owner',
        currentFindingKeys: new Set(),
        observation: { beforePresent: true, afterPresent: false },
      }),
    ).toBeNull();
    expect(
      supersedeReason({
        ...base,
        status: 'applied' as never,
        currentFindingKeys: new Set(),
        observation: null,
      }),
    ).toBeNull();
  });

  it('observes titles, descriptions, image text and replacements', () => {
    const p = page(ROOT, {
      title: 'Home',
      metaDescription: 'Old',
      images: [
        {
          src: 'a.jpg',
          alt: 'Chair',
          widthAttr: true,
          heightAttr: true,
          bytes: 1,
          intrinsicWidth: 1,
        },
      ],
    });
    expect(observeChange(title('New title for the page'), p)).toEqual({
      beforePresent: true,
      afterPresent: false,
    });
    expect(
      observeChange(
        {
          kind: 'image_alt_text',
          pageUrl: ROOT,
          imageSrc: 'a.jpg',
          before: null,
          after: 'Chair',
        },
        p,
      ),
    ).toEqual({ beforePresent: false, afterPresent: true });
    const replace: WebsiteChange = {
      kind: 'text_replace',
      pageUrl: ROOT,
      before: 'old',
      after: 'new',
    };
    expect(observeChange(replace, p)).toBeNull();
    expect(observeChange(replace, p, new Set(['new']))).toEqual({
      beforePresent: false,
      afterPresent: true,
    });
    expect(observeChange(replace, undefined)).toBeNull();
  });

  it('turns observations into verification', () => {
    expect(verificationFromObservation({ beforePresent: false, afterPresent: true })).toBe('confirmed_public');
    expect(verificationFromObservation({ beforePresent: true, afterPresent: false })).toBe('not_visible');
    expect(
      verificationFromObservation({
        beforePresent: false,
        afterPresent: false,
      }),
    ).toBeNull();
    expect(verificationFromObservation(null)).toBeNull();
  });
});
