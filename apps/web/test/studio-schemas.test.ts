import { describe, expect, it } from 'vitest';
import { CompleteUploadSchema, CreateUploadSchema, CurrentVersionSchema, DownloadKindSchema, FavouriteSchema, RegenerateSchema, ReviseSchema, UpdateAssetSchema, CLIP_TAG_OPTIONS, clipTagName } from '../src/lib/shared/studio-schemas';
import { GenerateRequestSchema } from '../src/lib/studio-edits';

describe('Video Studio API input schemas', () => {
  it('validates upload requests', () => {
    expect(CreateUploadSchema.parse({ filename: ' IMG_1.MOV ', size: 10, kind: 'video' })).toEqual({ filename: 'IMG_1.MOV', size: 10, mimeType: '', kind: 'video' });
    expect(CreateUploadSchema.safeParse({ filename: 'a.mov', size: 0, kind: 'video' }).success).toBe(false);
    expect(CreateUploadSchema.safeParse({ filename: 'a.mov', size: 1.5, kind: 'video' }).success).toBe(false);
    expect(CreateUploadSchema.safeParse({ filename: 'a.mov', size: 10, kind: 'image' }).success).toBe(false);
    expect(CreateUploadSchema.safeParse({ filename: '', size: 10, kind: 'video' }).success).toBe(false);
  });

  it('accepts an empty completion body for videos and a licence for music', () => {
    expect(CompleteUploadSchema.parse({})).toEqual({});
    const parsed = CompleteUploadSchema.parse({ title: 'Beat', licence: { kind: 'commercial_licence', permitted: { promotionalUse: true } }, confirmLicence: true });
    expect(parsed.licence?.permitted.instagram).toBe(false);
    expect(parsed.licence?.confirmedByOwnerAt).toBeNull();
    expect(CompleteUploadSchema.safeParse({ licence: { kind: 'stolen', permitted: {} } }).success).toBe(false);
  });

  it('validates clip tags, per-shot tags and order', () => {
    expect(UpdateAssetSchema.parse({ clipLabel: 'fade_detail' })).toEqual({ clipLabel: 'fade_detail' });
    expect(UpdateAssetSchema.parse({ clipLabel: null })).toEqual({ clipLabel: null });
    expect(UpdateAssetSchema.parse({ manualLabels: { s1: 'before' }, sortOrder: 2 })).toEqual({ manualLabels: { s1: 'before' }, sortOrder: 2 });
    expect(UpdateAssetSchema.safeParse({}).success).toBe(false);
    expect(UpdateAssetSchema.safeParse({ clipLabel: 'explosion' }).success).toBe(false);
    expect(UpdateAssetSchema.safeParse({ sortOrder: -1 }).success).toBe(false);
  });

  it('maps every clip tag to a real shot label (Not sure clears the tag)', () => {
    expect(CLIP_TAG_OPTIONS.map((o) => o.label)).toEqual(['Not sure', 'Before', 'Cutting', 'Fade detail', 'Styling', 'Result', 'Reaction', 'Shop']);
    for (const o of CLIP_TAG_OPTIONS) if (o.value) expect(UpdateAssetSchema.safeParse({ clipLabel: o.value }).success).toBe(true);
    expect(clipTagName('environment')).toBe('Shop');
    expect(clipTagName(null)).toBe('Not sure');
  });

  it('validates edit actions', () => {
    expect(FavouriteSchema.safeParse({ value: 'yes' }).success).toBe(false);
    expect(ReviseSchema.parse({ instruction: '  Make this 15 seconds ' })).toEqual({ instruction: 'Make this 15 seconds' });
    expect(ReviseSchema.safeParse({ instruction: ' ' }).success).toBe(false);
    expect(ReviseSchema.safeParse({ instruction: 'x'.repeat(501) }).success).toBe(false);
    expect(RegenerateSchema.parse({})).toEqual({ instruction: '' });
    expect(CurrentVersionSchema.safeParse({}).success).toBe(false);
    expect(DownloadKindSchema.parse(undefined)).toBe('export');
    expect(DownloadKindSchema.parse('preview')).toBe('preview');
    expect(DownloadKindSchema.safeParse('original').success).toBe(false);
  });

  it('validates generation settings with defaults and unique styles', () => {
    const parsed = GenerateRequestSchema.parse({ styles: ['beat_montage', 'clean_promo'] });
    expect(parsed).toMatchObject({ durationSec: 25, musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: '' });
    expect(GenerateRequestSchema.safeParse({ styles: [] }).success).toBe(false);
    expect(GenerateRequestSchema.safeParse({ styles: ['beat_montage', 'beat_montage'] }).success).toBe(false);
    expect(GenerateRequestSchema.safeParse({ styles: ['beat_montage'], durationSec: 7 }).success).toBe(false);
    expect(GenerateRequestSchema.safeParse({ styles: ['beat_montage'], durationSec: 91 }).success).toBe(false);
    expect(GenerateRequestSchema.safeParse({ styles: ['vlog'] }).success).toBe(false);
  });
});
