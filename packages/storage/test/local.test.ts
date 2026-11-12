import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalDiskStore } from '../src/local.js';
import { verifyMediaLink } from '../src/signing.js';

let root: string;
let store: LocalDiskStore;
const secret = 'test-secret-that-is-long-enough-0123456789';

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sa-store-'));
  store = new LocalDiskStore({ rootDir: root, appUrl: 'http://localhost:3000', secret });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalDiskStore', () => {
  it('puts, stats, streams with ranges and deletes', async () => {
    await store.put('projects/p1/assets/a1/original.mp4', Buffer.from('0123456789'));
    const st = await store.stat('projects/p1/assets/a1/original.mp4');
    expect(st?.size).toBe(10);
    expect(st?.contentType).toBe('video/mp4');
    const chunks: Buffer[] = [];
    for await (const c of await store.getStream('projects/p1/assets/a1/original.mp4', { start: 2, end: 4 })) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('234');
    expect(await store.list('projects/p1')).toEqual(['projects/p1/assets/a1/original.mp4']);
    expect(await store.deletePrefix('projects/p1')).toBe(1);
    expect(await store.exists('projects/p1/assets/a1/original.mp4')).toBe(false);
  });
  it('rejects unsafe keys', async () => {
    await expect(store.put('../escape', Buffer.from('x'))).rejects.toThrow(/Unsafe/);
    await expect(store.put('/abs', Buffer.from('x'))).rejects.toThrow(/Unsafe/);
  });
  it('assembles multipart uploads in order', async () => {
    const up = await store.createMultipart('music/t1/original.mp3');
    const p2 = await store.uploadPart(up, 2, Buffer.from('BB'));
    const p1 = await store.uploadPart(up, 1, Buffer.from('AA'));
    await store.completeMultipart(up, [p2, p1]);
    const buf = await readFile(path.join(root, 'music/t1/original.mp3'));
    expect(buf.toString()).toBe('AABB');
  });
  it('signs links that verify and expire', async () => {
    const url = await store.signedUrl('music/t1/original.mp3', { expiresInSeconds: 60, downloadName: 'song.mp3' });
    const token = url.split('/api/media/')[1]!;
    const claims = verifyMediaLink(token, secret);
    expect(claims?.key).toBe('music/t1/original.mp3');
    expect(claims?.downloadName).toBe('song.mp3');
    expect(verifyMediaLink(token, 'wrong-secret')).toBeNull();
    expect(verifyMediaLink(token, secret, claims!.exp + 1)).toBeNull();
    expect(verifyMediaLink(token.slice(0, -2) + 'xx', secret)).toBeNull();
  });
  it('putFile copies atomically', async () => {
    const src = path.join(root, 'src.bin');
    await writeFile(src, Buffer.from('file-body'));
    await store.putFile('misc/copy.bin', src);
    expect((await store.stat('misc/copy.bin'))?.size).toBe(9);
    await store.put('misc/stream.bin', Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    expect((await store.stat('misc/stream.bin'))?.size).toBe(4);
  });
});
