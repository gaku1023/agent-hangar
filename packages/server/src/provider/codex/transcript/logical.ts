import fs from 'node:fs';
import { splitLines, readNewLines, type NewLine } from '../../claude-code/transcript/lines.ts';
import type { PageBody } from '../../../transcript/filePage.ts';
import { decompressZstd } from './zstd.ts';

// 索引に入れるパス（論理パス）は常に rollout-<時刻>-<uuid>.jsonl である。
// 実体（物理パス）は .jsonl か、7 日を過ぎて圧縮された .jsonl.zst で、読むたびにここで解く。
// 展開後のバイト列は元の .jsonl と一致する前提なので、圧縮されても索引の読んだ位置はそのまま使える。

const ZST = '.zst';

export type Physical = { path: string; compressed: boolean };
export type FileStat = { size: number; mtimeMs: number };

/** 論理パスの実体。.jsonl があればそれ（両方あるときも）、無ければ .jsonl.zst。どちらも無ければ null。 */
export function resolvePhysical(logical: string): Physical | null {
  if (fs.existsSync(logical)) return { path: logical, compressed: false };
  const z = logical + ZST;
  return fs.existsSync(z) ? { path: z, compressed: true } : null;
}

/** 実体の大きさと更新時刻（圧縮されていれば zst のもの）。無ければ null。 */
export function statLogical(logical: string): FileStat | null {
  const p = resolvePhysical(logical);
  if (!p) return null;
  try {
    const s = fs.statSync(p.path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

const CACHE_MAX_ENTRIES = 2;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
type Cached = { size: number; mtimeMs: number; buf: Buffer };
/** 展開したバッファの小さな LRU。パスと実体の mtime と大きさが鍵。 */
const cache = new Map<string, Cached>();

function inflated(physical: string): Buffer {
  const st = fs.statSync(physical);
  const hit = cache.get(physical);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    cache.delete(physical);
    cache.set(physical, hit);
    return hit.buf;
  }
  const buf = decompressZstd(fs.readFileSync(physical));
  cache.delete(physical);
  cache.set(physical, { size: st.size, mtimeMs: st.mtimeMs, buf });
  let total = 0;
  for (const c of cache.values()) total += c.buf.length;
  // 古いものから落とす。直前に入れた 1 件は、大きくても残す。
  for (const k of [...cache.keys()]) {
    if (cache.size <= 1 || (cache.size <= CACHE_MAX_ENTRIES && total <= CACHE_MAX_BYTES)) break;
    total -= cache.get(k)!.buf.length;
    cache.delete(k);
  }
  return buf;
}

/** 圧縮の途中で .jsonl が消えるなど、物理パスが入れ替わった競合は 1 回だけやり直す。 */
function withPhysical<T>(logical: string, fn: (p: Physical) => T): T {
  for (let attempt = 0; ; attempt++) {
    const p = resolvePhysical(logical);
    if (!p) throw Object.assign(new Error(`ENOENT: ${logical}`), { code: 'ENOENT' });
    try {
      return fn(p);
    } catch (e) {
      if (attempt === 0 && (e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
  }
}

/**
 * 論理パスの本文を from バイト目から読み、改行で終わった行に分ける。
 * 本文が from より短くなっていたら作り直されたと見て先頭から読み、reset を立てる。
 * zst は全体を展開してから from 以降を取る。展開に失敗したら投げる。
 */
export function readLogicalLines(logical: string, from: number): { lines: NewLine[]; nextByte: number; reset: boolean } {
  return withPhysical(logical, (p) => {
    if (!p.compressed) return readNewLines(p.path, from);
    const buf = inflated(p.path);
    let start = from;
    let reset = false;
    if (buf.length < from) { start = 0; reset = true; }
    return { ...splitLines(buf.subarray(start), start), reset };
  });
}

/** 本文の先頭の 1 行（session_meta）。見つからなければ null。 */
export function readHeadLine(logical: string): string | null {
  return withPhysical(logical, (p) => {
    if (p.compressed) {
      const buf = inflated(p.path);
      const nl = buf.indexOf(10);
      return (nl === -1 ? buf : buf.subarray(0, nl)).toString('utf8') || null;
    }
    const fd = fs.openSync(p.path, 'r');
    try {
      const chunks: Buffer[] = [];
      let pos = 0;
      const CHUNK = 64 * 1024;
      const MAX = 4 * 1024 * 1024;
      while (pos < MAX) {
        const b = Buffer.alloc(CHUNK);
        const n = fs.readSync(fd, b, 0, CHUNK, pos);
        if (n === 0) break;
        const nl = b.subarray(0, n).indexOf(10);
        if (nl !== -1) { chunks.push(b.subarray(0, nl)); return Buffer.concat(chunks).toString('utf8') || null; }
        chunks.push(b.subarray(0, n));
        pos += n;
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  });
}

/** 本文の全体（zst なら展開したもの）。同期の上げ手が論理パスの .jsonl として読むための口（使うのは段 E）。 */
export function readLogicalWhole(logical: string): Buffer {
  return withPhysical(logical, (p) => (p.compressed ? Buffer.from(inflated(p.path)) : fs.readFileSync(p.path)));
}

/** 読み直し（page.ts）が開く口。zst は展開したバッファを持つ。 */
export function openLogicalBody(logical: string): PageBody {
  return withPhysical(logical, (p) => {
    if (p.compressed) {
      const buf = inflated(p.path);
      return {
        read: (offset, length) => Buffer.from(buf.subarray(offset, offset + length)),
        close() { /* バッファはキャッシュが持つ */ },
      };
    }
    const fd = fs.openSync(p.path, 'r');
    return {
      read(offset, length) {
        const b = Buffer.alloc(length);
        fs.readSync(fd, b, 0, length, offset);
        return b;
      },
      close() { fs.closeSync(fd); },
    };
  });
}
