import fs from 'node:fs';
import type { FileTranscriptSource, TranscriptFile, TranscriptSink } from '../../../agent/types.ts';
import { readCodexBatch } from './batch.ts';
import { archivedDirOf, classifyCodexEntry, listRolloutFiles, parseRolloutName, sessionsDirOf, type CodexWatched } from './discover.ts';
import { statLogical } from './logical.ts';
import { readCodexPage } from './page.ts';

/** fs.watch の形。試験が通知を自分で起こすために差し替える。 */
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
 */
export function codexTranscriptSource(o: {
  codexHome: () => string;
  enabled: () => boolean;
  isLive?: (providerSessionId: string) => boolean;
  importLimit?: number;
  watch?: WatchFn;
  now?: () => number;
}): CodexTranscriptSource {
  const watchers = new Map<WatchKey, { close(): void }>();
  const watchFailReported = new Set<WatchKey>();
  let sink: TranscriptSink | null = null;
  /** 最後に歩いた置き場の、会話の ID から本文の論理パスへの表。実行中の会話の本文を引くのに使う。 */
  let byId = new Map<string, TranscriptFile>();
  let listedAt = -Infinity;
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
    read: (file, from) => readCodexBatch(file, from),
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

    scan({ isIndexed }) {
      if (!o.enabled()) return none({ seen: null });
      const { files, drop, sessionsVisible } = relist();
      const limit = o.importLimit ?? CODEX_IMPORT_LIMIT;
      let budget = limit;
      const index: TranscriptFile[] = [];
      const stats = new Map<string, { size: number; mtimeMs: number } | null>();
      for (const f of files) {
        // すでに索引に入ったものと、hangar が起こした実行中の会話は、上限に数えず常に入れる（さもないと、古い会話が上限で押し出されて消える）。
        const free = (isIndexed?.(f.path) ?? false) || (o.isLive?.(f.sessionId) ?? false);
        if (!free) {
          if (budget <= 0) continue;
          budget--;
        }
        index.push(f);
        stats.set(f.path, statLogical(f.path));
      }
      // sessions が見えないとき（外れたなど）は、索引の全部を消してしまわないよう、列挙したものを渡さない。
      const seen = sessionsVisible ? new Set(files.map((f) => f.path)) : null;
      return { index, drop, stats, seen };
    },

    pick(file, stat) {
      if (!o.enabled()) return none({ lost: false });
      return { index: [file], drop: [], stats: new Map([[file.path, stat]]), lost: false };
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

