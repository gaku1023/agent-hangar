import fs from 'node:fs';
import path from 'node:path';
import type { FileTranscriptSource, TranscriptFile, TranscriptPick, TranscriptSink } from '../../../agent/types.ts';
import {
  AGENT_FILE_RE, classifyProjectsEntry, classifyRemoteEntry, HistoryIndexReader, listRemoteTranscriptFiles, listTranscriptFiles, mangleCwd, selectFilesToIndex,
  type WatchedEntry,
} from './discover.ts';
import { readClaudePage } from './page.ts';

/** fs.watch の形。試験が通知を自分で起こすために差し替える。 */
export type WatchFn = (
  dir: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => { close(): void; on(event: 'error', listener: (e: Error) => void): unknown };

type WatchKey = 'projects' | 'claude' | 'remote';
type Stat = { size: number; mtimeMs: number };

const realWatch: WatchFn = (dir, options, listener) => fs.watch(dir, options, listener);
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const groupKey = (f: TranscriptFile): string => `${f.sessionId}:${f.agentId ?? ''}`;

/** ファイルの大きさと更新時刻。読めなければ null。 */
function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/** Claude のトランスクリプトの面。中身は本文の置き場（~/.claude/projects と、ほかの PC の写しの置き場）の発見と見張りである。 */
export type ClaudeTranscriptSource = FileTranscriptSource;

/**
 * Claude のトランスクリプトの面を作る。
 * ~/.claude 配下は fs.watch と読み取りだけで触り、書き込みは一切しない。
 * remoteRoot はほかの PC から降ろした本文の置き場（~/.agent-hangar/remote）で、省けば手元だけを見る。
 * watch は fs.watch の代わりで、試験が差し替える。
 *
 * いつ全件を見比べるか、名指しされた本文をいつ索引化するかは、hangar の索引（indexer/service.ts）が決める。
 * ここは、どのファイルが本文か、どれを索引化するか、どこを見張るかだけを受け持つ。
 */
export function claudeTranscriptSource(o: { claudeDir: string; remoteRoot?: string; watch?: WatchFn }): ClaudeTranscriptSource {
  const projectsDir = path.join(o.claudeDir, 'projects');
  const history = new HistoryIndexReader(o.claudeDir);
  const watchers = new Map<WatchKey, { close(): void }>();
  /** 見張りを付けられなかったと知らせた置き場。同じ失敗を走査のたびにくり返さない。 */
  const watchFailReported = new Set<WatchKey>();
  /** 最後の全件走査で見た、同じ位置（主線かサブエージェント）ごとの候補。名指しされたファイルを全件走査と同じ規則で選ぶのに使う。 */
  let groups = new Map<string, TranscriptFile[]>();
  let sink: TranscriptSink | null = null;

  const attach = (key: WatchKey, dir: string, recursive: boolean, onName: (name: string | null) => void): void => {
    if (watchers.has(key) || !sink) return;
    const to = sink;
    const watchFn = o.watch ?? realWatch;
    try {
      const w = watchFn(dir, { recursive }, (_event, name) => onName(name === null || name === undefined ? null : String(name)));
      w.on('error', (e) => {
        to.error(dir, `fs.watch error: ${errorMessage(e)}`);
        // 見張りが壊れた。外して短めの周期の全件走査に切り替え、次の走査で付け直す。
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

  /** 見張りの知らせを索引の側へ渡す。名指しされた本文はそのまま、名前の分からない通知は全件の見比べを頼む。 */
  const onWatched = (entry: WatchedEntry | null): void => {
    if (!sink) return;
    if (entry === null || entry.kind === 'rescan') {
      sink.rescan();
      return;
    }
    if (entry.kind === 'ignore') return;
    sink.named(entry.file);
  };

  /** ~/.claude そのものの通知。history.jsonl の追記と、projects が現れたことだけを見る。 */
  const onClaudeDirName = (name: string | null): void => {
    if (!sink) return;
    if (name === null || name === 'history.jsonl') sink.historyChanged();
    if (name === 'projects' && !watchers.has('projects')) {
      ensureWatchers();
      sink.rescan();
    }
  };

  /** 付いていない見張りを付ける。置き場がまだ無いものは、現れてから付ける。 */
  const ensureWatchers = (): void => {
    attach('claude', o.claudeDir, false, (name) => onClaudeDirName(name));
    if (fs.existsSync(projectsDir)) {
      attach('projects', projectsDir, true, (name) => onWatched(name === null ? null : classifyProjectsEntry(projectsDir, name, null)));
    }
    const remoteRoot = o.remoteRoot;
    if (remoteRoot) {
      attach('remote', remoteRoot, true, (name) => onWatched(name === null ? null : classifyRemoteEntry(remoteRoot, name)));
    }
  };

  return {
    start(s) {
      sink = s;
      // 他端末の会話の本文なので、本人だけが読める権限で作る（puller 側も同じ 0700 で作る）。
      if (o.remoteRoot) fs.mkdirSync(o.remoteRoot, { recursive: true, mode: 0o700 });
      ensureWatchers();
    },
    stop() {
      sink = null;
      for (const w of watchers.values()) {
        try { w.close(); } catch { /* もう閉じている */ }
      }
      watchers.clear();
    },
    readPage: readClaudePage,
    where: { scan: projectsDir, history: path.join(o.claudeDir, 'history.jsonl') },

    scan({ isYielded }) {
      const local = listTranscriptFiles(o.claudeDir);
      const remote = o.remoteRoot ? listRemoteTranscriptFiles(o.remoteRoot) : [];
      const all = [...local, ...remote];
      const stats = new Map<string, fs.Stats | null>();
      const statOf = (p: string): fs.Stats | null => {
        if (!stats.has(p)) stats.set(p, statOrNull(p));
        return stats.get(p) ?? null;
      };
      const { index, drop } = selectFilesToIndex(all, { statOf, isYielded });
      // projects そのものが見えないとき（置き場が外れたなど）は、索引の全部を消してしまわないよう、列挙したものを渡さない。
      const seen = fs.existsSync(projectsDir) ? new Set(all.map((f) => f.path)) : null;
      const next = new Map<string, TranscriptFile[]>();
      for (const f of all) {
        const g = next.get(groupKey(f));
        if (g) g.push(f);
        else next.set(groupKey(f), [f]);
      }
      groups = next;
      return { index, drop, stats, seen };
    },

    pick(file, stat, { isYielded }) {
      const key = groupKey(file);
      const others = (groups.get(key) ?? []).filter((g) => g.path !== file.path);
      if (others.length === 0) {
        groups.set(key, [file]);
        return { index: [file], drop: [], stats: new Map([[file.path, stat]]), lost: false };
      }
      const stats = new Map<string, Stat>([[file.path, stat]]);
      const alive = [file];
      let lost = false;
      for (const g of others) {
        const s = statOrNull(g.path);
        if (s) {
          stats.set(g.path, s);
          alive.push(g);
        } else {
          lost = true;
        }
      }
      groups.set(key, alive);
      const picked: TranscriptPick = { ...selectFilesToIndex(alive, { statOf: (p) => stats.get(p) ?? null, isYielded }), stats };
      return { ...picked, lost };
    },

    /**
     * 実行中のセッションの手元の本文。主線は全件走査で見た場所を使い、まだ見ていなければ cwd から組む。
     * サブエージェントは、主線の隣の <セッション>/subagents を読んで、途中で増えたものも拾う。
     */
    liveFiles(sessionId, cwd) {
      const known = (groups.get(`${sessionId}:`) ?? []).find((f) => f.deviceId === null);
      const main: TranscriptFile = known ?? { path: path.join(projectsDir, mangleCwd(cwd), `${sessionId}.jsonl`), sessionId, agentId: null, deviceId: null };
      const out = [main];
      let names: string[] = [];
      try {
        names = fs.readdirSync(path.join(path.dirname(main.path), sessionId, 'subagents'));
      } catch {
        // サブエージェントがまだ無い。
      }
      for (const n of names) {
        const m = AGENT_FILE_RE.exec(n);
        if (m) out.push({ path: path.join(path.dirname(main.path), sessionId, 'subagents', n), sessionId, agentId: m[1]!, deviceId: null });
      }
      return out;
    },

    history: () => history.read(),
    rewatch() {
      if (sink) ensureWatchers();
    },
    healthy: () => watchers.has('claude') && watchers.has('projects') && (!o.remoteRoot || watchers.has('remote')),
  };
}
