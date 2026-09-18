import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredFile } from '../types.ts';

/** cwd を Claude Code のプロジェクトディレクトリ名に変換する。英数字以外は 1 文字ずつ '-' にする。 */
export function mangleCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

const UUID_RE = /^[0-9a-f-]{36}$/;

/** ~/.claude/projects 配下の本体とサブエージェントの jsonl をパス順に列挙する。 */
export function listTranscriptFiles(claudeDir: string): DiscoveredFile[] {
  const root = path.join(claudeDir, 'projects');
  if (!fs.existsSync(root)) return [];
  const out: DiscoveredFile[] = [];
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pd = path.join(root, proj.name);
    for (const entry of fs.readdirSync(pd, { withFileTypes: true })) {
      const full = path.join(pd, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const sessionId = entry.name.slice(0, -'.jsonl'.length);
        if (UUID_RE.test(sessionId)) out.push({ path: full, sessionId, agentId: null });
      } else if (entry.isDirectory() && UUID_RE.test(entry.name)) {
        const sub = path.join(full, 'subagents');
        if (!fs.existsSync(sub)) continue;
        for (const f of fs.readdirSync(sub)) {
          const m = /^agent-([0-9a-zA-Z]+)\.jsonl$/.exec(f);
          if (m) out.push({ path: path.join(sub, f), sessionId: entry.name, agentId: m[1]! });
        }
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** そのディレクトリに、このセッションの本体かサブエージェントの jsonl があるか。 */
function hasSessionFilesIn(projectDir: string, sessionUuid: string): boolean {
  if (fs.existsSync(path.join(projectDir, `${sessionUuid}.jsonl`))) return true;
  try {
    return fs.readdirSync(path.join(projectDir, sessionUuid, 'subagents')).some((f) => /^agent-[0-9a-zA-Z]+\.jsonl$/.test(f));
  } catch {
    return false;
  }
}

/**
 * そのセッションの jsonl が 1 つでもあるかを、ファイルの実体で確かめる。
 * 索引の `transcript_files` はまだ行が入っていないことがあるので、
 * 「本文があるか」を消す側の判断に使うときはこちらを見る。
 * cwd が分かっていれば素直な場所を先に見て、外れていても全部のプロジェクトを当たる。
 */
export function hasTranscriptFile(claudeDir: string, sessionUuid: string, cwd?: string | null): boolean {
  if (!sessionUuid) return false;
  const root = path.join(claudeDir, 'projects');
  if (cwd && hasSessionFilesIn(path.join(root, mangleCwd(cwd)), sessionUuid)) return true;
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  return dirs.some((d) => d.isDirectory() && hasSessionFilesIn(path.join(root, d.name), sessionUuid));
}

export type HistoryEntry ={ cwd: string; firstTs: number; lastTs: number; firstDisplay: string; count: number };

/** ~/.claude/history.jsonl を読み、セッション ID ごとにまとめる。 */
export function readHistoryIndex(claudeDir: string): Map<string, HistoryEntry> {
  const file = path.join(claudeDir, 'history.jsonl');
  const map = new Map<string, HistoryEntry>();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec: { sessionId?: string; project?: string; timestamp?: number; display?: string };
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.sessionId) continue;
    const ts = typeof rec.timestamp === 'number' ? rec.timestamp : 0;
    const cur = map.get(rec.sessionId);
    if (!cur) map.set(rec.sessionId, { cwd: rec.project ?? '', firstTs: ts, lastTs: ts, firstDisplay: rec.display ?? '', count: 1 });
    else {
      cur.count += 1;
      if (ts < cur.firstTs) { cur.firstTs = ts; cur.firstDisplay = rec.display ?? cur.firstDisplay; }
      if (ts > cur.lastTs) cur.lastTs = ts;
      if (rec.project) cur.cwd = rec.project;
    }
  }
  return map;
}
