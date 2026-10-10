import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BundleError, packBundle, readTar, unpackBundle, writeTar, type BundleManifest } from './bundle.ts';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

describe('tar の書き読み', () => {
  it('ファイルを書いて、同じ中身で読める', () => {
    const tar = writeTar([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/b.bin', data: Buffer.alloc(1000, 7) }, { name: 'empty', data: Buffer.alloc(0) }]);
    expect(tar.length % 512).toBe(0);
    const back = readTar(tar);
    expect(back.map((e) => e.name)).toEqual(['a.txt', 'dir/b.bin', 'empty']);
    expect(back[0]!.data.toString()).toBe('hello');
    expect(back[1]!.data.equals(Buffer.alloc(1000, 7))).toBe(true);
    expect(back[2]!.data.length).toBe(0);
  });

  it('標準の tar コマンドで読める形である', async () => {
    const { execFileSync } = await import('node:child_process');
    const tar = writeTar([{ name: 'manifest.json', data: Buffer.from('{}') }, { name: `blobs/${'a'.repeat(64)}`, data: Buffer.from('x') }]);
    const out = execFileSync('tar', ['-tf', '-'], { input: tar }).toString().trim().split(/\r?\n/);
    expect(out).toEqual(['manifest.json', `blobs/${'a'.repeat(64)}`]);
  });

  it('壊れた書庫は読まずに断る', () => {
    const tar = writeTar([{ name: 'a', data: Buffer.from('hello') }]);
    const bad = Buffer.from(tar);
    bad[10] = bad[10]! ^ 0xff; // 名前を壊すと検査和が合わない
    expect(() => readTar(bad)).toThrow(BundleError);
    expect(() => readTar(tar.subarray(0, 700))).toThrow(BundleError); // 本文が切れている
  });

  it('長すぎる名前は書かない', () => {
    expect(() => writeTar([{ name: 'x'.repeat(101), data: Buffer.alloc(0) }])).toThrow(BundleError);
  });
});

const item = (id: string, kind: BundleManifest['items'][number]['kind'], text: string) => ({ id, kind, sha256: sha(text), size: Buffer.byteLength(text), marks: [] as never[] });

describe('束', () => {
  const manifest = (items: BundleManifest['items']): BundleManifest => ({ version: 1, deviceId: 'dev-a', createdAt: 123, items });

  it('目録と中身を包み、開くと同じものが出る', () => {
    const m = manifest([item('file:CLAUDE.md', 'claude-md', '# hi'), item('settings:model', 'settings', '"opus"')]);
    const tar = packBundle(m, new Map([[sha('# hi'), Buffer.from('# hi')], [sha('"opus"'), Buffer.from('"opus"')]]));
    const r = unpackBundle(tar);
    expect(r.manifest).toEqual(m);
    expect(r.blobs.get(sha('# hi'))!.toString()).toBe('# hi');
    expect(r.skipped).toBe(0);
  });

  it('同じ中身の項目は 1 つの中身を共有する', () => {
    const m = manifest([item('file:commands/a.md', 'commands', 'same'), item('file:commands/b.md', 'commands', 'same')]);
    const tar = packBundle(m, new Map([[sha('same'), Buffer.from('same')]]));
    expect(readTar(tar).filter((e) => e.name.startsWith('blobs/'))).toHaveLength(1);
    expect(unpackBundle(tar).manifest.items).toHaveLength(2);
  });

  it('目録の指紋と中身が合わない束は丸ごと断る', () => {
    const m = manifest([item('file:CLAUDE.md', 'claude-md', '# hi')]);
    const tar = packBundle(m, new Map([[sha('# hi'), Buffer.from('# HI')]]));
    expect(() => unpackBundle(tar)).toThrow(BundleError);
  });

  it('目録にあって中身が無い束は断る', () => {
    const m = manifest([item('file:CLAUDE.md', 'claude-md', '# hi')]);
    expect(() => unpackBundle(packBundle(m, new Map()))).toThrow(BundleError);
  });

  it('知らない id の項目は飛ばして数え、残りは開く', () => {
    const m = manifest([item('file:CLAUDE.md', 'claude-md', 'a'), item('future:thing', 'claude-md', 'b'), item('file:../x', 'claude-md', 'c')]);
    const tar = packBundle(m, new Map([[sha('a'), Buffer.from('a')], [sha('b'), Buffer.from('b')], [sha('c'), Buffer.from('c')]]));
    const r = unpackBundle(tar);
    expect(r.manifest.items.map((i) => i.id)).toEqual(['file:CLAUDE.md']);
    expect(r.skipped).toBe(2);
  });

  it('id の種類と目録の kind が食い違う項目は飛ばす', () => {
    const m = manifest([item('file:skills/a/SKILL.md', 'commands', 'a')]);
    const r = unpackBundle(packBundle(m, new Map([[sha('a'), Buffer.from('a')]])));
    expect(r.manifest.items).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it('知らない名前の書庫の項目、版違い、JSON でない目録は断る', () => {
    expect(() => unpackBundle(writeTar([{ name: 'manifest.json', data: Buffer.from('{}') }, { name: '../evil', data: Buffer.from('x') }]))).toThrow(BundleError);
    expect(() => unpackBundle(writeTar([{ name: 'manifest.json', data: Buffer.from('not json') }]))).toThrow(BundleError);
    expect(() => unpackBundle(writeTar([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ version: 2, deviceId: 'd', createdAt: 1, items: [] })) }]))).toThrow(BundleError);
    expect(() => unpackBundle(writeTar([]))).toThrow(BundleError);
  });

  it('大きさの上限を超える束は開かない', () => {
    const big = 'x'.repeat(4000);
    const m = manifest([item('file:CLAUDE.md', 'claude-md', big)]);
    const tar = packBundle(m, new Map([[sha(big), Buffer.from(big)]]));
    expect(() => unpackBundle(tar, { maxBlobBytes: 1000 })).toThrow(BundleError);
    expect(() => unpackBundle(tar, { maxEntries: 1 })).toThrow(BundleError);
  });
});
