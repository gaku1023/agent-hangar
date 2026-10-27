import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BundleError, bundleTargetsOf, packBundle, unpackBundle, writeTar, type BundleManifest } from './bundle.ts';
import { parseItemId } from './ids.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const blobs = (...texts: string[]) => new Map(texts.map((t) => [sha(t), Buffer.from(t)]));
const it1 = { id: 'file:CLAUDE.md', kind: 'claude-md' as const, sha256: sha('hi'), size: 2, marks: [] };
const rawBundle = (manifest: unknown, texts: string[] = ['hi']) => writeTar([
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
  ...texts.map((t) => ({ name: `blobs/${sha(t)}`, data: Buffer.from(t) })),
]);
const base = { version: 1, deviceId: 'A', createdAt: 5, items: [it1] };

describe('束の目録の targets と os', () => {
  it('往復で残る', () => {
    const man: BundleManifest = { version: 1, deviceId: 'A', createdAt: 5, items: [it1], targets: ['claude', 'codex'], os: 'darwin' };
    const back = unpackBundle(packBundle(man, blobs('hi'))).manifest;
    expect(back.targets).toEqual(['claude', 'codex']);
    expect(back.os).toBe('darwin');
  });

  it('欄の無い目録（古い版の束）は undefined で、claude だけと読む', () => {
    const back = unpackBundle(rawBundle(base)).manifest;
    expect(back.targets).toBeUndefined();
    expect(back.os).toBeUndefined();
    expect(bundleTargetsOf(back)).toEqual(['claude']);
  });

  it('壊れた targets と os は、束を断らずにその欄だけ捨てる（古い版の束として読む）', () => {
    for (const targets of ['claude', [1], ['Bad Name'], [{}], null, ['a'.repeat(40)]]) {
      const back = unpackBundle(rawBundle({ ...base, targets, os: 'beos' })).manifest;
      expect(back.targets).toBeUndefined();
      expect(back.os).toBeUndefined();
      expect(back.items).toHaveLength(1);
    }
  });

  it('targets の重なりは 1 つにまとめる', () => {
    expect(unpackBundle(rawBundle({ ...base, targets: ['claude', 'claude', 'codex'] })).manifest.targets).toEqual(['claude', 'codex']);
  });

  it('知らない頭の id は、束を断らずにその項目だけ読み飛ばす', () => {
    const items = [it1, { id: 'unknown-target:foo', kind: 'codex-file', sha256: sha('zz'), size: 2, marks: [] }];
    const un = unpackBundle(rawBundle({ ...base, items, targets: ['claude', 'unknown-target'] }, ['hi', 'zz']));
    expect(un.manifest.items.map((i) => i.id)).toEqual(['file:CLAUDE.md']);
    expect(un.skipped).toBe(1);
    expect(parseItemId('unknown-target:foo')).toBeNull();
    expect(parseItemId('codex:file:AGENTS.md')).toBeNull(); // 対象がまだ無い頭は null
  });

  it('壊れた目録そのものは、今までどおり断る', () => {
    expect(() => unpackBundle(rawBundle({ ...base, items: 'x' }))).toThrow(BundleError);
  });
});

/**
 * 古い版（この PR より前の main）の unpackBundle の目録の読み方の写し。
 * 知らない欄（targets、os）を見ず、目録を作り直して返す。新しい版の束を古い版が受けても壊れないことの確かめ。
 */
function legacyManifest(tarBytes: Buffer): { version: 1; deviceId: string; createdAt: number; items: unknown[] } {
  const entry = unpackBundle(tarBytes); // blobs と tar の検査は今の実装のものを使う（その部分は変えていない）
  void entry;
  const raw = JSON.parse(readManifestRaw(tarBytes)) as Partial<BundleManifest> | null;
  if (!raw || raw.version !== 1 || typeof raw.deviceId !== 'string' || typeof raw.createdAt !== 'number' || !Array.isArray(raw.items)) throw new BundleError('目録の形が違います');
  return { version: 1, deviceId: raw.deviceId, createdAt: raw.createdAt, items: [...raw.items] };
}
const readManifestRaw = (t: Buffer): string => {
  // 先頭の 1 件が manifest.json（packBundle の並び）。512 バイトの頭の後ろから大きさだけ読む。
  const size = parseInt(t.subarray(124, 135).toString('latin1').trim(), 8);
  return t.subarray(512, 512 + size).toString('utf8');
};

describe('古い版の読み方との互換（SPEC 12 章）', () => {
  it('古い版は知らない欄を無視し、新しい版の束を断らない', () => {
    const man: BundleManifest = { version: 1, deviceId: 'A', createdAt: 5, items: [it1], targets: ['claude', 'codex'], os: 'win32' };
    const legacy = legacyManifest(packBundle(man, blobs('hi')));
    expect(legacy).toEqual({ version: 1, deviceId: 'A', createdAt: 5, items: [it1] });
  });
});
