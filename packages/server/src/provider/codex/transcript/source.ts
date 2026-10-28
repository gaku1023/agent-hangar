import fs from 'node:fs';
import type { FileTranscriptSource, TranscriptFile, TranscriptSink } from '../../../agent/types.ts';
import { readCodexBatch } from './batch.ts';
import { archivedDirOf, classifyCodexEntry, listRemoteRolloutFiles, listRolloutFiles, parseRolloutName, sessionsDirOf, type CodexWatched } from './discover.ts';
import { readHeadLine, statLogical } from './logical.ts';
import { readCodexPage } from './page.ts';

/** fs.watch の形。試験が通知を自分で起こすために差し替える。 */
/** rollout の先頭行（session_meta）の payload.creator_account_id。読めなければ null。 */
export function creatorAccountIdOf(path: string): string | null {
  try {
    const head = readHeadLine(path);
    if (!head) return null;
    const raw: unknown = JSON.parse(head);
    const p = typeof raw === 'object' && raw !== null ? (raw as { payload?: unknown }).payload : undefined;
    const id = typeof p === 'object' && p !== null ? (p as { creator_account_id?: unknown }).creator_account_id : undefined;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch { return null; }
}

export type WatchFn = (
  dir: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => { close(): void; on(event: 'error', listener: (e: Error) => void): unknown };

/** hangar の外で始まった会話を、索引に入れる最大の件数（索引に無いものを、新しい方から）。 */
export const CODEX_IMPORT_LIMIT = 300;

type WatchKey = 'sessions' | 'archived' | 'home';

const realWatch: WatchFn = (dir, options, listener) => fs.watch(dir, options, listener);
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
/** 実行中の会話の本文を引き直す間隔の下限（毎周期、置き場を歩かないため）。 */
const LIVE_RELIST_MS = 3000;

export type CodexTranscriptSource = FileTranscriptSource;

/**
 * Codex のトランスクリプトの面。中身は $CODEX_HOME の sessions と archived_sessions の発見と見張りである。
 * $CODEX_HOME は読み取りと fs.watch だけで触り、書き込みは一切しない。auth.json、config.toml、sqlite は開かない。
 *
 * enabled が偽（設定の codexEnabled が切）のとき、start は何もせず、scan と pick は空を返し（seen は null で、既存の索引を消さない）、見張りも付けない。
 * codexHome は呼ばれた時点の値を読む（設定やアカウントの切り替えに追う）。
 * isLive は、hangar が起こして実行中の会話か。取り込みの上限に数えず、常に索引に入れる。
 *
 * remoteRoot を渡すと、ほかの PC から降ろした写し（remote/<PC>/codex/ の下）も、その PC の deviceId で列挙する。Claude の写し（remote/<PC>/projects）と同じ扱いである。
 * 写しは会話の行が届いていなければ索引が飛ばすので、取り込みの上限には数えない。
 * 同じ会話が手元（$CODEX_HOME）にもあれば手元を採り、写しは drop に入れる（「この PC で再開」の後）。譲った会話だけは、更新時刻の新しい方を採る。
 * 写しの到着は同期の知らせ（全件走査の予約）で拾うので、写しの置き場には見張りを付けない。
 */
export function codexTranscriptSource(o: {
  codexHome: () => string;
  enabled: () => boolean;
  isLive?: (providerSessionId: string) => boolean;
  /** 読んだ束の中の、最後の meta rate_limits（B5 の `{ rate_limits, … }` とその行の ts）。使用量の面（B7）へ渡す。切のときは呼ばない。 */
  onRateLimits?: (value: unknown, ts: unknown, creatorAccountId: string | null) => void;
  importLimit?: number;
  /** ほかの PC から降ろした写しの根（~/.agent-hangar/remote）。 */
  remoteRoot?: string;
  watch?: WatchFn;
  now?: () => number;
}): CodexTranscriptSource {
  const watchers = new Map<WatchKey, { close(): void }>();
  const watchFailReported = new Set<WatchKey>();
  let sink: TranscriptSink | null = null;
  /** 最後に歩いた置き場の、会話の ID から本文の論理パスへの表。実行中の会話の本文を引くのに使う。 */
  let byId = new Map<string, TranscriptFile>();
  let listedAt = -Infinity;
  /** 最後に歩いた写しの、会話の ID から写しへの表。手元の本文が名指しされたとき、写しを外すのに使う。 */
  let remoteById = new Map<string, TranscriptFile[]>();
  const now = o.now ?? Date.now;

  const closeAll = (): void => {
    for (const w of watchers.values()) {
      try { w.close(); } catch { /* もう閉じている */ }
    }
    watchers.clear();
  };

  const attach = (key: WatchKey, dir: string, recursive: boolean, onName: (name: string | null) => void): void => {
    if (watchers.has(key) || !sink) return;
    const to = sink;
    const watchFn = o.watch ?? realWatch;
    try {
      const w = watchFn(dir, { recursive }, (_event, name) => onName(name === null || name === undefined ? null : String(name)));
      w.on('error', (e) => {
        to.error(dir, `fs.watch error: ${errorMessage(e)}`);
        if (watchers.get(key) === w) {
          watchers.delete(key);
          try { w.close(); } catch { /* もう閉じている */ }
        }
        to.rescan();
      });
      watchers.set(key, w);
      watchFailReported.delete(key);
    } catch (e) {
      if (!watchFailReported.has(key)) {
        watchFailReported.add(key);
        to.error(dir, `fs.watch failed, polling only: ${errorMessage(e)}`);
      }
    }
  };

  const onWatched = (entry: CodexWatched): void => {
    if (!sink || !o.enabled()) return;
    if (entry.kind === 'rescan') sink.rescan();
    else if (entry.kind === 'file') sink.named(entry.file);
  };

  /** 付いていない見張りを付ける。置き場がまだ無いものは、現れてから付ける。 */
  const ensureWatchers = (): void => {
    if (!sink || !o.enabled()) return;
    const home = o.codexHome();
    const sessions = sessionsDirOf(home);
    const archived = archivedDirOf(home);
    if (isDir(sessions)) {
      attach('sessions', sessions, true, (name) => onWatched(classifyCodexEntry(sessions, name)));
      // 置き場が現れたので、ホームの見張りは要らない。
      const h = watchers.get('home');
      if (h) { try { h.close(); } catch { /* もう閉じている */ } watchers.delete('home'); }
    } else {
      // sessions がまだ無い。ホームを見て、現れたら付ける（ホームの通知は sessions と archived_sessions の名前だけを見る）。
      attach('home', home, false, (name) => {
        if (name === null || name === 'sessions' || name === 'archived_sessions') {
          ensureWatchers();
          onWatched({ kind: 'rescan' });
        }
      });
    }
    if (isDir(archived)) attach('archived', archived, false, (name) => onWatched(classifyCodexEntry(archived, name)));
  };

  const relist = (): { files: TranscriptFile[]; drop: TranscriptFile[]; sessionsVisible: boolean } => {
    const r = listRolloutFiles(o.codexHome());
    byId = new Map(r.files.map((f) => [f.sessionId, f]));
    listedAt = now();
    return r;
  };

  const none = <T extends object>(extra: T) => ({ index: [] as TranscriptFile[], drop: [] as TranscriptFile[], stats: new Map<string, { size: number; mtimeMs: number } | null>(), ...extra });

  return {
    agent: 'codex',
    read: (file, from) => {
      const batch = readCodexBatch(file, from);
      if (o.onRateLimits && o.enabled()) {
        let last: { value: unknown; ts: unknown } | null = null;
        for (const r of batch.records) for (const e of r.events) if (e.kind === 'meta' && e.name === 'rate_limits') last = { value: e.value, ts: e.ts };
        if (last) o.onRateLimits(last.value, last.ts, creatorAccountIdOf(file.path));
      }
      return batch;
    },
    start(s) {
      sink = s;
      ensureWatchers();
    },
    stop() {
      sink = null;
      closeAll();
    },
    readPage: readCodexPage,
    where: { scan: sessionsDirOf(o.codexHome()), history: o.codexHome() },

    enabled: () => o.enabled(),
    setEnabled(on) {
      if (!on) { closeAll(); return; }
      ensureWatchers();
      sink?.rescan();
    },

    stat: statLogical,

    scan({ isIndexed, isYielded }) {
      if (!o.enabled()) return none({ seen: null });
      const { files: localFiles, drop: localDrop, sessionsVisible } = relist();
      const remote = o.remoteRoot ? listRemoteRolloutFiles(o.remoteRoot) : { files: [], drop: [] };
      const stats = new Map<string, { size: number; mtimeMs: number } | null>();
      const statOf = (p: string) => {
        if (!stats.has(p)) stats.set(p, statLogical(p));
        return stats.get(p) ?? null;
      };
      const { local, remoteKeep, drop } = chooseCopies(localFiles, remote.files, { isYielded, statOf });
      remoteById = groupById(remote.files);
      const limit = o.importLimit ?? CODEX_IMPORT_LIMIT;
      let budget = limit;
      const index: TranscriptFile[] = [];
      for (const f of local) {
        // すでに索引に入ったものと、hangar が起こした実行中の会話は、上限に数えず常に入れる（さもないと、古い会話が上限で押し出されて消える）。
        const free = (isIndexed?.(f.path) ?? false) || (o.isLive?.(f.sessionId) ?? false);
        if (!free) {
          if (budget <= 0) continue;
          budget--;
        }
        index.push(f);
        statOf(f.path);
      }
      for (const f of remoteKeep) { index.push(f); statOf(f.path); }
      const kept = new Map<string, { size: number; mtimeMs: number } | null>();
      for (const f of index) kept.set(f.path, stats.get(f.path) ?? null);
      // sessions が見えないとき（外れたなど）は、索引の全部を消してしまわないよう、列挙したものを渡さない。
      const seen = sessionsVisible ? new Set([...localFiles, ...remote.files].map((f) => f.path)) : null;
      return { index, drop: [...localDrop, ...remote.drop, ...drop], stats: kept, seen };
    },

    pick(file, stat, { isYielded } = {}) {
      if (!o.enabled()) return none({ lost: false });
      // 手元の本文が現れたら、同じ会話の写しを外す（譲った会話は全件の見比べで新しい方を選ぶ）。
      const drop = file.deviceId === null && isYielded?.(file.sessionId) !== true
        ? (remoteById.get(file.sessionId) ?? []).filter((r) => statLogical(r.path) !== null)
        : [];
      return { index: [file], drop, stats: new Map([[file.path, stat]]), lost: false };
    },

    liveFiles(providerSessionId) {
      if (!o.enabled()) return [];
      let f = byId.get(providerSessionId);
      if (!f && now() - listedAt >= LIVE_RELIST_MS) f = relist().files.find((x) => x.sessionId === providerSessionId);
      return f ? [f] : [];
    },

    // 本文の無い会話の覚えは持たない（threads の title や session_index.jsonl は読まない）。
    history: () => EMPTY_HISTORY,
    rewatch() { ensureWatchers(); },
    healthy() {
      if (!o.enabled()) return true;
      const home = o.codexHome();
      const sessionsOk = isDir(sessionsDirOf(home)) ? watchers.has('sessions') : watchers.has('home');
      return sessionsOk && (!isDir(archivedDirOf(home)) || watchers.has('archived'));
    },
  };
}

const EMPTY_HISTORY = { index: new Map(), version: 0 };

function groupById(files: TranscriptFile[]): Map<string, TranscriptFile[]> {
  const m = new Map<string, TranscriptFile[]>();
  for (const f of files) {
    const g = m.get(f.sessionId);
    if (g) g.push(f);
    else m.set(f.sessionId, [f]);
  }
  return m;
}

/**
 * 手元の本文と写しから、会話ごとに索引へ入れる 1 つを選ぶ（Claude の selectFilesToIndex と同じ規則）。
 * 手元があれば手元を採る。譲った会話か、手元が無い会話は、更新時刻の新しいものを採る。選ばれなかったものは drop。
 */
function chooseCopies(
  local: TranscriptFile[],
  remote: TranscriptFile[],
  o: { isYielded?: (id: string) => boolean; statOf: (p: string) => { mtimeMs: number } | null },
): { local: TranscriptFile[]; remoteKeep: TranscriptFile[]; drop: TranscriptFile[] } {
  const byRemote = groupById(remote);
  const localIds = new Set(local.map((f) => f.sessionId));
  const drop: TranscriptFile[] = [];
  const remoteKeep: TranscriptFile[] = [];
  const localDropped = new Set<string>();
  for (const [id, copies] of byRemote) {
    const mine = localIds.has(id) ? local.filter((f) => f.sessionId === id) : [];
    const pool = mine.length > 0 && o.isYielded?.(id) !== true ? mine : [...mine, ...copies];
    const chosen = pool.reduce((a, b) => ((o.statOf(b.path)?.mtimeMs ?? 0) > (o.statOf(a.path)?.mtimeMs ?? 0) ? b : a));
    for (const f of [...mine, ...copies]) {
      if (f === chosen) { if (f.deviceId !== null) remoteKeep.push(f); continue; }
      drop.push(f);
      if (f.deviceId === null) localDropped.add(f.path);
    }
  }
  return { local: local.filter((f) => !localDropped.has(f.path)), remoteKeep, drop };
}

