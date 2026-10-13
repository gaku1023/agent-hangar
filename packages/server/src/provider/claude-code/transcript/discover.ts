import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredFile } from '../types.ts';

/** cwd を Claude Code のプロジェクトディレクトリ名に変換する。英数字以外は 1 文字ずつ '-' にする。 */
export function mangleCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

const UUID_RE = /^[0-9a-f-]{36}$/;

const byPath = (a: DiscoveredFile, b: DiscoveredFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export const AGENT_FILE_RE = /^agent-([0-9a-zA-Z]+)\.jsonl$/;

/** 1 つの projects ディレクトリから本体とサブエージェントの jsonl をパス順に集める。 */
function listUnderProjects(root: string, deviceId: string | null): DiscoveredFile[] {
  if (!fs.existsSync(root)) return [];
  const out: DiscoveredFile[] = [];
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pd = path.join(root, proj.name);
    for (const entry of fs.readdirSync(pd, { withFileTypes: true })) {
      const full = path.join(pd, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const sessionId = entry.name.slice(0, -'.jsonl'.length);
        if (UUID_RE.test(sessionId)) out.push({ path: full, sessionId, agentId: null, deviceId });
      } else if (entry.isDirectory() && UUID_RE.test(entry.name)) {
        const sub = path.join(full, 'subagents');
        if (!fs.existsSync(sub)) continue;
        for (const f of fs.readdirSync(sub)) {
          const m = AGENT_FILE_RE.exec(f);
          if (m) out.push({ path: path.join(sub, f), sessionId: entry.name, agentId: m[1]!, deviceId });
        }
      }
    }
  }
  return out.sort(byPath);
}

/** ~/.claude/projects 配下の本体とサブエージェントの jsonl をパス順に列挙する。 */
export function listTranscriptFiles(claudeDir: string): DiscoveredFile[] {
  return listUnderProjects(path.join(claudeDir, 'projects'), null);
}

/** ~/.agent-hangar/remote 配下を端末ごとに歩き、他端末から降ろした写しを列挙する。 */
export function listRemoteTranscriptFiles(remoteRootDir: string): DiscoveredFile[] {
  if (!fs.existsSync(remoteRootDir)) return [];
  const out: DiscoveredFile[] = [];
  for (const dev of fs.readdirSync(remoteRootDir, { withFileTypes: true })) {
    if (!dev.isDirectory()) continue;
    out.push(...listUnderProjects(path.join(remoteRootDir, dev.name, 'projects'), dev.name));
  }
  return out;
}

/**
 * 監視の通知の名前を、索引にとっての意味に振り分けた結果。
 * file はその本文のファイル、rescan は全件走査で確かめるべき変化、ignore は本文に関わらない変化である。
 */
export type WatchedEntry = { kind: 'file'; file: DiscoveredFile } | { kind: 'rescan' } | { kind: 'ignore' };

const splitRel = (rel: string): string[] | null => {
  if (path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  return parts.includes('..') ? null : parts;
};

/** projects ディレクトリからの相対の部品を振り分ける。listUnderProjects と同じ規則で本文を見分ける。 */
function classifyParts(root: string, parts: string[], deviceId: string | null): WatchedEntry {
  const [proj, name, sub, leaf] = parts;
  // projects そのものとプロジェクトのディレクトリは、中身ごと現れたり消えたりする。
  if (parts.length <= 1) return { kind: 'rescan' };
  if (parts.length === 2) {
    if (name!.endsWith('.jsonl')) {
      const sessionId = name!.slice(0, -'.jsonl'.length);
      return UUID_RE.test(sessionId) ? { kind: 'file', file: { path: path.join(root, proj!, name!), sessionId, agentId: null, deviceId } } : { kind: 'ignore' };
    }
    // セッションのディレクトリ（サブエージェントの入れ物）。
    return UUID_RE.test(name!) ? { kind: 'rescan' } : { kind: 'ignore' };
  }
  if (!UUID_RE.test(name!) || sub !== 'subagents') return { kind: 'ignore' };
  if (parts.length === 3) return { kind: 'rescan' };
  const m = parts.length === 4 ? AGENT_FILE_RE.exec(leaf!) : null;
  return m ? { kind: 'file', file: { path: path.join(root, proj!, name!, sub, leaf!), sessionId: name!, agentId: m[1]!, deviceId } } : { kind: 'ignore' };
}

/**
 * ~/.claude/projects の監視が渡した相対の名前を振り分ける。
 * 本文のファイルならそのファイルを返し、入れ物のディレクトリや置き場の外の名前は全件走査に回す。
 */
export function classifyProjectsEntry(projectsRoot: string, rel: string, deviceId: string | null): WatchedEntry {
  const parts = splitRel(rel);
  return parts ? classifyParts(projectsRoot, parts, deviceId) : { kind: 'rescan' };
}

/** ~/.agent-hangar/remote の監視が渡した相対の名前を振り分ける。<端末>/projects/ の下を手元と同じ規則で見る。 */
export function classifyRemoteEntry(remoteRootDir: string, rel: string): WatchedEntry {
  const parts = splitRel(rel);
  if (!parts || parts.length <= 1) return { kind: 'rescan' };
  if (parts[1] !== 'projects') return { kind: 'ignore' };
  if (parts.length === 2) return { kind: 'rescan' };
  return classifyParts(path.join(remoteRootDir, parts[0]!, 'projects'), parts.slice(2), parts[0]!);
}

export type SelectOptions = { statOf?: (p: string) => { mtimeMs: number } | null; isYielded?: (sessionUuid: string) => boolean };

const defaultStat = (p: string): { mtimeMs: number } | null => {
  try { return fs.statSync(p); } catch { return null; }
};

/**
 * 同じセッションの同じ位置（主線かサブエージェント）にあるファイルから、索引化する 1 つを選ぶ。
 * 手元のファイルを優先し、無ければ更新時刻が最新の写しを採る。
 * 引き継ぎで譲ったセッションは持ち主が他端末なので、手元を優先しない。
 * 選ばれなかったものは drop に入る。呼び手が forgetTranscriptFile で索引から外す。
 */
export function selectFilesToIndex(files: DiscoveredFile[], opts: SelectOptions = {}): { index: DiscoveredFile[]; drop: DiscoveredFile[] } {
  const statOf = opts.statOf ?? defaultStat;
  const groups = new Map<string, DiscoveredFile[]>();
  for (const f of files) {
    const k = `${f.sessionId}:${f.agentId ?? ''}`;
    const g = groups.get(k);
    if (g) g.push(f);
    else groups.set(k, [f]);
  }
  const index: DiscoveredFile[] = [];
  const drop: DiscoveredFile[] = [];
  for (const g of groups.values()) {
    const yielded = opts.isYielded?.(g[0]!.sessionId) === true;
    const locals = g.filter((f) => f.deviceId === null);
    const pool = !yielded && locals.length > 0 ? locals : g;
    const chosen = pool.reduce((a, b) => ((statOf(b.path)?.mtimeMs ?? 0) > (statOf(a.path)?.mtimeMs ?? 0) ? b : a));
    for (const f of g) (f === chosen ? index : drop).push(f);
  }
  return { index: index.sort(byPath), drop: drop.sort(byPath) };
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
 * projects を読めなかったときは null を返す。
 * 読めないことと本文が無いことは違うので、呼び手が「無い」として扱わないようにする。
 */
export function hasTranscriptFile(claudeDir: string, sessionUuid: string, cwd?: string | null): boolean | null {
  if (!sessionUuid) return false;
  const root = path.join(claudeDir, 'projects');
  if (cwd && hasSessionFilesIn(path.join(root, mangleCwd(cwd)), sessionUuid)) return true;
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  return dirs.some((d) => d.isDirectory() && hasSessionFilesIn(path.join(root, d.name), sessionUuid));
}

export type HistoryEntry = { cwd: string; firstTs: number; lastTs: number; firstDisplay: string; count: number };

/**
 * history.jsonl の 1 行を畳む。行の中身は書き換えず、同じセッションの項目は新しい物に置き換える。
 * 返した Map の写しを後から畳み足しても、前の写しの項目は変わらない。
 */
function foldHistoryLine(map: Map<string, HistoryEntry>, line: string): void {
  if (!line.trim()) return;
  let rec: { sessionId?: string; project?: string; timestamp?: number; display?: string };
  try { rec = JSON.parse(line); } catch { return; }
  if (!rec.sessionId) return;
  const ts = typeof rec.timestamp === 'number' ? rec.timestamp : 0;
  const cur = map.get(rec.sessionId);
  if (!cur) {
    map.set(rec.sessionId, { cwd: rec.project ?? '', firstTs: ts, lastTs: ts, firstDisplay: rec.display ?? '', count: 1 });
    return;
  }
  const next = { ...cur, count: cur.count + 1 };
  if (ts < next.firstTs) { next.firstTs = ts; next.firstDisplay = rec.display ?? next.firstDisplay; }
  if (ts > next.lastTs) next.lastTs = ts;
  if (rec.project) next.cwd = rec.project;
  map.set(rec.sessionId, next);
}

/** ~/.claude/history.jsonl を読み、セッション ID ごとにまとめる。 */
export function readHistoryIndex(claudeDir: string): Map<string, HistoryEntry> {
  const file = path.join(claudeDir, 'history.jsonl');
  const map = new Map<string, HistoryEntry>();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) foldHistoryLine(map, line);
  return map;
}

export type HistoryRead = {
  index: Map<string, HistoryEntry>;
  /** 読んだ中身が変わるたびに増える。呼び手は前に見た値と比べて、変わったときだけ後の処理を回す。 */
  version: number;
};

/** 継ぎ目の確かめに、読み終えた位置の直前から読み直すバイト数。 */
const SEAM_BYTES = 64;
const NEWLINE = 0x0a;

/**
 * history.jsonl を、前に読んだ所から読み足す。
 * Claude Code は利用者が打つたびにこのファイルへ 1 行足すだけなので、毎回頭から読むと長く使うほど重くなる。
 * 大きさも更新時刻も同じなら読まない。
 * 同じファイルが大きくなっていて、前に読み終えた位置の直前の数十バイトが変わっていなければ、増えた分だけ読む。
 * それ以外（切り詰め、差し替え、同じ大きさの書き直し）は全部読み直す。
 * 結果は readHistoryIndex と同じになる。改行の無い最後の行も数え、続きが来たら改めて読む。
 */
export class HistoryIndexReader {
  /** 改行まで読み終えた行だけを畳んだもの。 */
  private base = new Map<string, HistoryEntry>();
  /** base に畳んだバイト数。最後の改行の次の位置。 */
  private offset = 0;
  /** offset の直前の数十バイト。追記かどうかの見分けに使う。 */
  private seam: Buffer = Buffer.alloc(0);
  private stamp: { ino: number; size: number; mtimeMs: number } | null = null;
  private current = new Map<string, HistoryEntry>();
  private version = 0;

  constructor(private readonly claudeDir: string) {}

  read(): HistoryRead {
    const file = path.join(this.claudeDir, 'history.jsonl');
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      if (this.stamp !== null) {
        this.reset();
        this.current = new Map();
        this.version++;
      }
      return { index: this.current, version: this.version };
    }
    const prev = this.stamp;
    if (prev && prev.ino === st.ino && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return { index: this.current, version: this.version };
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return { index: this.current, version: this.version };
    }
    try {
      const now = fs.fstatSync(fd);
      const appended = prev !== null && prev.ino === now.ino && now.size > prev.size && this.readAppended(fd, now.size);
      if (!appended) this.readAll(fd, now.size);
      this.stamp = { ino: now.ino, size: now.size, mtimeMs: now.mtimeMs };
    } finally {
      fs.closeSync(fd);
    }
    this.version++;
    return { index: this.current, version: this.version };
  }

  private reset(): void {
    this.base = new Map();
    this.offset = 0;
    this.seam = Buffer.alloc(0);
    this.stamp = null;
  }

  /** 前に読み終えた位置から末尾まで読む。継ぎ目が前と違えば読まずに偽を返す。 */
  private readAppended(fd: number, size: number): boolean {
    const start = this.offset - this.seam.length;
    if (start < 0 || this.offset > size) return false;
    const buf = readRange(fd, start, size - start);
    if (!buf.subarray(0, this.seam.length).equals(this.seam)) return false;
    this.consume(buf, this.seam.length, start);
    return true;
  }

  private readAll(fd: number, size: number): void {
    this.reset();
    this.consume(readRange(fd, 0, size), 0, 0);
  }

  /** buf の from から先を畳む。buf の頭はファイルの base の位置にある。改行の無い最後の行は current にだけ足す。 */
  private consume(buf: Buffer, from: number, base: number): void {
    const lastNl = buf.lastIndexOf(NEWLINE);
    const end = lastNl >= from ? lastNl + 1 : from;
    if (end > from) {
      for (const line of buf.toString('utf8', from, end).split('\n')) foldHistoryLine(this.base, line);
      this.offset = base + end;
      this.seam = Buffer.from(buf.subarray(Math.max(0, end - SEAM_BYTES), end));
    }
    const rest = buf.toString('utf8', end);
    if (rest.trim()) {
      this.current = new Map(this.base);
      foldHistoryLine(this.current, rest);
    } else {
      this.current = new Map(this.base);
    }
  }
}

/** fd の position から length バイトを読む。途中で短く返ったら、読めた所までにする。 */
function readRange(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}
