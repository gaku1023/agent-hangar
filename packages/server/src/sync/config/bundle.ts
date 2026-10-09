import { createHash } from 'node:crypto';
import type { ConfigExecMark, ConfigItemKind } from '@agent-hangar/shared';
import { parseItemId } from './ids.ts';

/**
 * 設定の束（PC ごとに 1 つ）の形。tar である。
 * 呼び手が gzip して暗号化してから、クラウドの `config/<端末>/.hangar/config-bundle` に 1 オブジェクトとして置く。
 *
 * 中身は 2 種類だけである。
 * - `manifest.json`：目録。項目の id、種類、指紋、大きさ、実行の印。
 * - `blobs/<sha256>`：項目の中身。指紋で名前を付けるので、同じ中身の項目は 1 つを共有し、名前に外から来た文字が入らない。
 *
 * 束は他の PC から届く外からの入力である。開くときに、名前、大きさ、指紋、id の形を全部検査する。
 * tar は自前で書く（普通のファイル 1 種類だけで、名前は 100 バイト以内の ustar）。標準の tar コマンドでも読める。
 */

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

/** 1 項目の中身の上限。旧実装と同じ 1 MiB。 */
export const MAX_ITEM_BYTES = 1 << 20;
const MAX_MANIFEST_BYTES = 8 << 20;
const MAX_ENTRIES = 20_000;
const BLOCK = 512;
const SHA_RE = /^[0-9a-f]{64}$/;
const BLOB_RE = /^blobs\/[0-9a-f]{64}$/;
const MARKS: readonly ConfigExecMark[] = ['hooks', 'shell', 'script'];

export type TarEntry = { name: string; data: Buffer };

const octal = (n: number, width: number): string => `${n.toString(8).padStart(width - 1, '0')}\0`;

/** ustar の書庫を作る。名前は 100 バイト以内。 */
export function writeTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    if (name.length === 0 || name.length > 100) throw new BundleError('書庫の中の名前が長すぎます');
    const h = Buffer.alloc(BLOCK);
    name.copy(h, 0);
    h.write('0000644\0', 100, 'latin1');
    h.write('0000000\0', 108, 'latin1');
    h.write('0000000\0', 116, 'latin1');
    h.write(octal(e.data.length, 12), 124, 'latin1');
    h.write(octal(0, 12), 136, 'latin1');
    h.write('        ', 148, 'latin1'); // 検査和の欄は、数える間は空白
    h.write('0', 156, 'latin1');
    h.write('ustar\0', 257, 'latin1');
    h.write('00', 263, 'latin1');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    parts.push(h, e.data, Buffer.alloc((BLOCK - (e.data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

const cstr = (b: Buffer): string => { const i = b.indexOf(0); return b.subarray(0, i < 0 ? b.length : i).toString('utf8'); };
const parseOctal = (b: Buffer): number => {
  const s = cstr(b).trim();
  if (!/^[0-7]+$/.test(s)) throw new BundleError('書庫の大きさの欄が読めません');
  return parseInt(s, 8);
};

/** 書庫を読む。普通のファイル以外、検査和の合わないもの、切れたものは断る。 */
export function readTar(tar: Buffer, o: { maxEntries?: number; maxEntryBytes?: number } = {}): TarEntry[] {
  const maxEntries = o.maxEntries ?? MAX_ENTRIES;
  const maxBytes = o.maxEntryBytes ?? MAX_MANIFEST_BYTES;
  const out: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) return out;
    const stored = parseInt(cstr(h.subarray(148, 156)).trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (!Number.isFinite(stored) || stored !== sum) throw new BundleError('書庫の検査和が合いません');
    const type = String.fromCharCode(h[156]!);
    if (type !== '0' && type !== '\0') throw new BundleError('書庫に普通のファイル以外が入っています');
    const size = parseOctal(h.subarray(124, 136));
    if (size > maxBytes) throw new BundleError('書庫の中のファイルが大きすぎます');
    const end = off + BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (end > tar.length) throw new BundleError('書庫が途中で切れています');
    if (out.length >= maxEntries) throw new BundleError('書庫の中のファイルが多すぎます');
    out.push({ name: cstr(h.subarray(0, 100)), data: Buffer.from(tar.subarray(off + BLOCK, off + BLOCK + size)) });
    off = end;
  }
  return out;
}

export type ManifestItem = { id: string; kind: ConfigItemKind; sha256: string; size: number; marks: ConfigExecMark[] };
export type BundleManifest = { version: 1; deviceId: string; createdAt: number; items: ManifestItem[] };

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** 目録と中身（指紋から中身）を包む。 */
export function packBundle(manifest: BundleManifest, blobs: ReadonlyMap<string, Buffer>): Buffer {
  const entries: TarEntry[] = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }];
  const wanted = new Set(manifest.items.map((i) => i.sha256));
  for (const [hash, data] of [...blobs].sort(([a], [b]) => (a < b ? -1 : 1))) if (wanted.has(hash)) entries.push({ name: `blobs/${hash}`, data });
  return writeTar(entries);
}

export type UnpackedBundle = {
  /** 検査を通った項目だけの目録。 */
  manifest: BundleManifest;
  blobs: Map<string, Buffer>;
  /** 知らない id や種類の食い違いで飛ばした項目の数。新しい版の hangar が足した種類は、ここで静かに飛ばす。 */
  skipped: number;
};

const isMarks = (v: unknown): v is ConfigExecMark[] => Array.isArray(v) && v.every((m) => (MARKS as readonly unknown[]).includes(m));

/**
 * 束を開く。中身の指紋が目録と合わない、目録が読めない、版が違う、名前が決まりの外、のどれかなら BundleError。
 * 項目の id が知らない形のものと、id と種類が食い違うものは、束ごとは断らずにその項目だけ飛ばす。
 */
export function unpackBundle(tar: Buffer, o: { maxBlobBytes?: number; maxEntries?: number } = {}): UnpackedBundle {
  const maxBlob = o.maxBlobBytes ?? MAX_ITEM_BYTES;
  const entries = readTar(tar, { maxEntries: o.maxEntries, maxEntryBytes: Math.max(maxBlob, MAX_MANIFEST_BYTES) });
  let manifestRaw: Buffer | null = null;
  const blobs = new Map<string, Buffer>();
  for (const e of entries) {
    if (e.name === 'manifest.json') {
      if (manifestRaw) throw new BundleError('目録が 2 つあります');
      manifestRaw = e.data;
    } else if (BLOB_RE.test(e.name)) {
      if (e.data.length > maxBlob) throw new BundleError('項目の中身が大きすぎます');
      const hash = e.name.slice('blobs/'.length);
      if (sha256(e.data) !== hash) throw new BundleError('項目の中身の指紋が名前と合いません');
      blobs.set(hash, e.data);
    } else {
      throw new BundleError('書庫に知らない名前が入っています');
    }
  }
  if (!manifestRaw) throw new BundleError('目録がありません');
  let parsed: unknown;
  try { parsed = JSON.parse(manifestRaw.toString('utf8')); } catch { throw new BundleError('目録を読めません'); }
  const m = parsed as Partial<BundleManifest> | null;
  if (!m || m.version !== 1 || typeof m.deviceId !== 'string' || typeof m.createdAt !== 'number' || !Array.isArray(m.items)) throw new BundleError('目録の形が違います');
  const items: ManifestItem[] = [];
  let skipped = 0;
  for (const raw of m.items as unknown[]) {
    const it = raw as Partial<ManifestItem> | null;
    if (!it || typeof it.id !== 'string' || typeof it.sha256 !== 'string' || !SHA_RE.test(it.sha256) || typeof it.size !== 'number' || !isMarks(it.marks ?? [])) throw new BundleError('目録の項目の形が違います');
    const blob = blobs.get(it.sha256);
    if (!blob) throw new BundleError('目録にある項目の中身が束にありません');
    if (blob.length !== it.size) throw new BundleError('目録の大きさと中身が合いません');
    const parsedId = parseItemId(it.id);
    if (!parsedId || parsedId.kind !== it.kind) { skipped++; continue; }
    items.push({ id: it.id, kind: parsedId.kind, sha256: it.sha256, size: it.size, marks: it.marks ?? [] });
  }
  return { manifest: { version: 1, deviceId: m.deviceId, createdAt: m.createdAt, items }, blobs, skipped };
}
