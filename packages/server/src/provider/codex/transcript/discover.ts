import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptFile } from '../../../agent/types.ts';

// Codex の会話の置き場（$CODEX_HOME）の見分け方。
// 本文は sessions/YYYY/MM/DD/rollout-<ローカル時刻>-<thread の UUID>.jsonl[.zst] で、アーカイブされたものは archived_sessions/ に平らに置かれる。
// auth.json、config.toml、sqlite、*.log は読まない。名前が rollout の形のものだけを本文として数える。

export const ROLLOUT_RE = /^rollout-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/;

export type RolloutName = { sessionId: string; localTime: string; /** 索引に入れる名前（常に .jsonl）。 */ logicalName: string; compressed: boolean };

export function parseRolloutName(name: string): RolloutName | null {
  const m = ROLLOUT_RE.exec(name);
  if (!m) return null;
  const compressed = m[3] !== undefined;
  return { sessionId: m[2]!, localTime: m[1]!, logicalName: compressed ? name.slice(0, -'.zst'.length) : name, compressed };
}

/** Codex の置き場。環境変数 CODEX_HOME があればそれ、無ければ ~/.codex。 */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.CODEX_HOME;
  return v !== undefined && v !== '' ? v : path.join(os.homedir(), '.codex');
}

/** 本文の置き場。どちらも $CODEX_HOME の下である。 */
export const sessionsDirOf = (codexHome: string): string => path.join(codexHome, 'sessions');
export const archivedDirOf = (codexHome: string): string => path.join(codexHome, 'archived_sessions');

type Found = { file: TranscriptFile; localTime: string; archived: boolean };

const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const readdir = (p: string): fs.Dirent[] => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };

function collect(dir: string, sub: boolean, archived: boolean, into: Map<string, Found>): void {
  const take = (d: string): void => {
    for (const e of readdir(d)) {
      if (!e.isFile()) continue;
      const n = parseRolloutName(e.name);
      if (!n) continue;
      const logical = path.join(d, n.logicalName);
      // .jsonl と .jsonl.zst が並んでいても、論理パスは 1 つ。
      if (!into.has(logical)) into.set(logical, { file: { path: logical, sessionId: n.sessionId, agentId: null, deviceId: null }, localTime: n.localTime, archived });
    }
  };
  if (!sub) { take(dir); return; }
  for (const y of readdir(dir)) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    for (const m of readdir(path.join(dir, y.name))) {
      if (!m.isDirectory() || !/^\d\d$/.test(m.name)) continue;
      for (const d of readdir(path.join(dir, y.name, m.name))) {
        if (d.isDirectory() && /^\d\d$/.test(d.name)) take(path.join(dir, y.name, m.name, d.name));
      }
    }
  }
}

/**
 * 全部の本文を、新しい順（ファイル名の時刻の降順）に並べて返す。
 * 同じ会話が sessions と archived_sessions の両方にあるときは sessions を採り、もう一方は drop に入れる。
 * sessions が見えるかは sessionsVisible で返す（見えないときは、呼び手が索引の全部を消さないようにする）。
 */
export function listRolloutFiles(codexHome: string): { files: TranscriptFile[]; drop: TranscriptFile[]; sessionsVisible: boolean } {
  const sessions = sessionsDirOf(codexHome);
  const found = new Map<string, Found>();
  const sessionsVisible = isDir(sessions);
  if (sessionsVisible) collect(sessions, true, false, found);
  const archived = archivedDirOf(codexHome);
  if (isDir(archived)) collect(archived, false, true, found);
  const sorted = [...found.values()].sort((a, b) => (a.localTime === b.localTime ? (a.file.path < b.file.path ? 1 : -1) : a.localTime < b.localTime ? 1 : -1));
  const chosen = new Map<string, Found>();
  const drop: TranscriptFile[] = [];
  for (const f of sorted) {
    const cur = chosen.get(f.file.sessionId);
    if (!cur) { chosen.set(f.file.sessionId, f); continue; }
    // sessions を正にする。同じ側の重複は、新しく見つけた方（先に並んだ方）を残す。
    if (cur.archived && !f.archived) { drop.push(cur.file); chosen.set(f.file.sessionId, f); } else drop.push(f.file);
  }
  const keep = new Set([...chosen.values()].map((f) => f.file.path));
  return { files: sorted.filter((f) => keep.has(f.file.path)).map((f) => f.file), drop, sessionsVisible };
}

/** 見張りの通知の名前を、索引にとっての意味に振り分けた結果。 */
export type CodexWatched = { kind: 'file'; file: TranscriptFile } | { kind: 'rescan' } | { kind: 'ignore' };

/**
 * sessions か archived_sessions の見張りが渡した相対の名前を振り分ける。
 * rollout の名前なら本文（.jsonl.zst の名前も論理パスの .jsonl にする）、名前の無い通知は全件の見比べ、それ以外は無視する。
 */
export function classifyCodexEntry(root: string, rel: string | null): CodexWatched {
  if (rel === null || rel === '') return { kind: 'rescan' };
  if (path.isAbsolute(rel)) return { kind: 'rescan' };
  const parts = rel.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.includes('..')) return { kind: 'rescan' };
  const n = parseRolloutName(parts[parts.length - 1]!);
  if (!n) return { kind: 'ignore' };
  return { kind: 'file', file: { path: path.join(root, ...parts.slice(0, -1), n.logicalName), sessionId: n.sessionId, agentId: null, deviceId: null } };
}
