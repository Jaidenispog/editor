import { describe, expect, it } from 'vitest';
import {
  UPLOAD_PART_SIZE,
  checkUploadFile,
  expectedPartSize,
  fileExtension,
  missingParts,
  partCountFor,
  partRange,
  receivedBytes,
  resumeStorageKey,
  retryDelayMs,
} from '../src/lib/shared/upload-math';

const MiB = 1024 * 1024;

describe('upload part maths', () => {
  it('uses 8 MiB parts, below the 10 MB proxy body limit', () => {
    expect(UPLOAD_PART_SIZE).toBe(8 * MiB);
    expect(UPLOAD_PART_SIZE).toBeLessThan(10 * 1000 * 1000);
  });

  it('counts parts with a short final part', () => {
    expect(partCountFor(0)).toBe(0);
    expect(partCountFor(1)).toBe(1);
    expect(partCountFor(8 * MiB)).toBe(1);
    expect(partCountFor(8 * MiB + 1)).toBe(2);
    expect(partCountFor(100 * MiB)).toBe(13);
    expect(() => partCountFor(10, 0)).toThrow();
  });

  it('computes byte ranges and expected sizes for each part', () => {
    const size = 20 * MiB + 5;
    expect(partRange(1, size)).toEqual({ start: 0, end: 8 * MiB });
    expect(partRange(2, size)).toEqual({ start: 8 * MiB, end: 16 * MiB });
    expect(partRange(3, size)).toEqual({ start: 16 * MiB, end: size });
    expect(expectedPartSize(3, size)).toBe(4 * MiB + 5);
    expect(partRange(0, size)).toBeNull();
    expect(partRange(4, size)).toBeNull();
    expect(partRange(1.5, size)).toBeNull();
  });

  it('lists missing parts and bytes already received for resuming', () => {
    expect(missingParts(5, [1, 3])).toEqual([2, 4, 5]);
    expect(missingParts(3, [3, 2, 1, 1])).toEqual([]);
    const size = 17 * MiB;
    expect(receivedBytes(size, [1, 3, 3])).toBe(8 * MiB + 1 * MiB);
    expect(receivedBytes(size, [9])).toBe(0);
  });

  it('backs off 1 s, 2 s, 4 s and caps the wait', () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000]);
    expect(retryDelayMs(10)).toBe(15_000);
  });

  it('remembers unfinished uploads by project, name, size and last-modified time', () => {
    const key = resumeStorageKey('p1', { name: 'IMG_0001.MOV', size: 123, lastModified: 456 });
    expect(key).toBe('studio-upload:p1:IMG_0001.MOV:123:456');
    expect(resumeStorageKey('p1', { name: 'IMG_0001.MOV', size: 124, lastModified: 456 })).not.toBe(key);
  });
});

describe('upload file checks', () => {
  it('reads extensions safely', () => {
    expect(fileExtension('IMG_0001.MOV')).toBe('mov');
    expect(fileExtension('folder/clip.final.mp4')).toBe('mp4');
    expect(fileExtension('.hidden')).toBe('');
    expect(fileExtension('noext')).toBe('');
  });

  it('accepts phone videos, including ones the browser gives no type for', () => {
    expect(checkUploadFile({ filename: 'IMG_0001.MOV', mimeType: 'video/quicktime', kind: 'video' })).toEqual({ ok: true, extension: 'mov', mimeType: 'video/quicktime' });
    expect(checkUploadFile({ filename: 'clip.m4v', mimeType: '', kind: 'video' })).toEqual({ ok: true, extension: 'm4v', mimeType: 'video/x-m4v' });
    expect(checkUploadFile({ filename: 'clip.mp4', mimeType: 'application/octet-stream', kind: 'video' })).toMatchObject({ ok: true, mimeType: 'video/mp4' });
  });

  it('rejects other files with a plain reason', () => {
    const avi = checkUploadFile({ filename: 'clip.avi', mimeType: 'video/x-msvideo', kind: 'video' });
    expect(avi.ok).toBe(false);
    if (!avi.ok) expect(avi.reason).toMatch(/\.mov, \.mp4 and \.m4v/);
    expect(checkUploadFile({ filename: 'clip.mp4', mimeType: 'image/png', kind: 'video' }).ok).toBe(false);
    expect(checkUploadFile({ filename: 'song.mp3', mimeType: 'audio/mpeg', kind: 'video' }).ok).toBe(false);
  });

  it('accepts licensed music formats and normalises the type', () => {
    expect(checkUploadFile({ filename: 'beat.mp3', mimeType: 'audio/mp3', kind: 'audio' })).toEqual({ ok: true, extension: 'mp3', mimeType: 'audio/mpeg' });
    expect(checkUploadFile({ filename: 'beat.m4a', mimeType: 'audio/x-m4a', kind: 'audio' })).toMatchObject({ ok: true, mimeType: 'audio/mp4' });
    expect(checkUploadFile({ filename: 'beat.wav', mimeType: '', kind: 'audio' })).toMatchObject({ ok: true, mimeType: 'audio/wav' });
    expect(checkUploadFile({ filename: 'beat.flac', mimeType: 'audio/flac', kind: 'audio' }).ok).toBe(false);
  });
});
