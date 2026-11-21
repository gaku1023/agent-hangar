import fs from 'node:fs';
import type { Db } from '../db/open.ts';
import { stmt } from './statements.ts';

// 非対話の会話（claude -p や Agent SDK で走ったバッチ）の見分け。
// Claude Code は本文の行ごとに entrypoint（対話の端末なら cli、claude -p なら sdk-cli、SDK なら sdk-ts や sdk-py）を書く。
// entrypoint が sdk- で始まるものだけで、対話の入口が 1 つも無い会話を非対話とみなし、端末ローカルの session_stats.headless に 1 を持つ。
// 一覧・未読・サイドバー・「最近」から外し、検索とプロジェクトの絞り込みでは引ける（db/queries.ts の isHeadlessSql）。

export type EntrypointKind = 'headless' | 'interactive';

/** entrypoint の値の種類。値が無ければ null（決め手にしない）。 */
export function entrypointKind(entrypoint: string | undefined): EntrypointKind | null {
  if (!entrypoint) return null;
  return entrypoint.startsWith('sdk-') ? 'headless' : 'interactive';
}

/**
 * 前の印と、束で見た entrypoint から、次の印を決める。
 * 対話の入口を一度でも見たら 0 にし、以後は sdk の行が来ても 0 のまま（対話で使った会話を隠さない）。
 * sdk の入口だけを見たら、前が 0 でなければ 1 にする。どちらも見なければ前の値を残す（作り直しでは null）。
 */
export function nextHeadless(prev: number | null, seen: { headless: boolean; interactive: boolean }, reset: boolean): number | null {
  const base = reset ? null : prev;
  if (seen.interactive) return 0;
  if (seen.headless) return base === 0 ? 0 : 1;
  return base;
}

/** 先頭と末尾で読む量。claude -p のバッチは 1 本が数百 KB までなので、ほとんどは全部を読むのと同じになる。 */
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const ENTRYPOINT_RE = /"entrypoint":"([^"]*)"/g;

/**
 * 本文の先頭と末尾を読み、非対話の会話なら 1、それ以外は 0 を返す。読めなければ 0（隠さない側）にする。
 * 末尾も読むのは、claude -p で始めた会話を claude -r で対話に戻したとき、その行は末尾に足されるからである。
 */
export function probeHeadless(filePath: string): 0 | 1 {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const chunks: string[] = [];
    const read = (pos: number, len: number) => {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd!, buf, 0, len, pos);
      chunks.push(buf.subarray(0, n).toString('utf8'));
    };
    read(0, Math.min(size, HEAD_BYTES));
    if (size > HEAD_BYTES) { const from = Math.max(HEAD_BYTES, size - TAIL_BYTES); read(from, size - from); }
    const seen = { headless: false, interactive: false };
    for (const text of chunks) {
      for (const m of text.matchAll(ENTRYPOINT_RE)) {
        const k = entrypointKind(m[1]);
        if (k === 'interactive') return 0;
        if (k === 'headless') seen.headless = true;
      }
    }
    return seen.headless ? 1 : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* 閉じられなくても印は決まっている */ }
  }
}

/**
 * 印がまだ無い（版 64 より前に索引した）Claude の会話を、本文を読んで埋める。1 回で最大 limit 件で、埋めた件数を返す。
 * 主線のファイルを 1 つ選んで読む（手元の本文があればそれを、無ければほかの PC の写しを）。
 * 読めなくても 0 を書き、次の呼び出しで同じ会話を読み直さない。
 */
export function backfillHeadless(db: Db, limit = 200): number {
  const rows = stmt(db, `select st.session_id id,
      (select t.path from transcript_files t where t.session_id = st.session_id and t.agent_id is null and t.agent = 'claude-code' order by t.device_id is not null, t.path limit 1) path
    from session_stats st join sessions s on s.id = st.session_id
    where st.headless is null and s.provider = 'claude-code'
      and exists (select 1 from transcript_files t where t.session_id = st.session_id and t.agent_id is null and t.agent = 'claude-code')
    limit ?`).all(limit) as { id: string; path: string }[];
  const set = stmt(db, 'update session_stats set headless = ? where session_id = ? and headless is null');
  for (const r of rows) set.run(probeHeadless(r.path), r.id);
  return rows.length;
}
