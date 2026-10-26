import { IndexerService } from '../indexer/service.ts';
import { gitPath } from '../git/find.ts';
import { GitService } from '../git/service.ts';
import { spawnGit } from '../git/status.ts';
import { MemoStore } from '../projects/memo.ts';
import { createSessionChangeHandler } from '../projects/onSessionChanged.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { fillProjectRemotes } from '../projects/link.ts';
import { checkRoots } from '../projects/rootCheck.ts';
import { ensureScratchProject } from '../projects/scratch.ts';
import { processStartOfPrompt } from '../sessions/promptProcess.ts';
import { remoteRoot } from '../config/cloud.ts';
import { opencodeExportDir } from '../provider/opencode/export.ts';
import { RemoteOpencodeTranscripts } from '../provider/opencode/transcript/remote.ts';
import type { DeliveryParts } from './delivery.ts';
import type { HomeParts } from './home.ts';
import type { SyncParts } from './sync.ts';

const ROOT_CHECK_MS = 30_000;

export type IndexingParts = {
  indexer: IndexerService;
  memos: MemoStore;
  /** git の表示。実行中のセッションの本文が伸びたら、ここが作業ツリーを読み直して配る。 */
  git: GitService;
  /**
   * 最初の索引づけと、プロジェクトへの紐づけを済ませる。
   * 全走査、プロジェクトの git の remote の空きを埋める、ワークスペースからのプロジェクトの登録、紐づけ、クイックセッションの用意、メモの突き合わせと監視、ルートの確かめ、の順である。
   */
  start(): Promise<void>;
  /** ルートの確かめの周期を止める。 */
  stopTimers(): void;
  /** メモのファイルの監視を止める。 */
  stopMemoWatch(): void;
  /**
   * opencode のモデルのコンテキストの長さを引く口を渡す。opencode の部品（boot/opencode.ts）は索引より後に組むので、組んでから渡す。
   * 渡すまでは、opencode の使用量の context_size を書かない。
   */
  bindContextSize(of: (model: string) => number | null): void;
};

/**
 * 索引と、索引から決まるプロジェクトの持ち場を組む。
 * 索引は、本文のファイルを読んでセッションの行を書く。行は配る層が画面へ届ける。
 * ここで結ぶのは、行に対応しない知らせ（進み、本文の伸び）と、現れたセッションのプロジェクトへの紐づけである。
 * 手元の本文が動いたら、同期の上げ手へ知らせる。
 */
export function bootIndexing(
  home: Pick<HomeParts, 'home' | 'db' | 'device' | 'settings' | 'language' | 'life'>,
  delivery: Pick<DeliveryParts, 'hub' | 'live' | 'claude' | 'opencode'>,
  sync: Pick<SyncParts, 'uploader' | 'syncState' | 'onRemoteChange'>,
): IndexingParts {
  const { db, settings, life } = home;
  const { hub, live } = delivery;
  const deviceId = home.device.id;
  // opencode のモデルのコンテキストの長さ。opencode の部品を組んだら bindContextSize で渡される。
  let contextSize: ((model: string) => number | null) | null = null;
  // ほかの PC から降ろした opencode の本文の写し（export の JSON）を、閲覧のために索引へ入れる。
  const remoteOpencode = new RemoteOpencodeTranscripts({
    db, remoteRoot: remoteRoot(home.home), exportDir: opencodeExportDir(home.home),
    marks: { get: (id) => sync.syncState.get(`opencodeView:${id}`), set: (id, v) => { sync.syncState.set(`opencodeView:${id}`, v); } },
    isRunningHere: (id) => live.current().some((l) => l.sessionId === id),
  });
  const indexer = new IndexerService({
    db, deviceId,
    contextSizeOf: (model) => contextSize?.(model) ?? null,
    // ファイル型の本文の発見と見張りは、各 driver のトランスクリプトの面が受け持つ（いまは Claude だけ。Codex は driver ができたらここへ足す）。他端末から降ろした本文も、Claude の面が見つける。
    transcripts: [delivery.claude.transcript],
    // opencode（ベータ）の本文は serve の API から読んで束で押し込む。hangar が起こした会話だけを読むので、設定が切なら何も読まない。
    // ほかの PC の opencode の会話は、降ろした export の写しから読む（設定に依らず閲覧できる）。
    stored: [delivery.opencode.transcript, remoteOpencode],
    // 実行中の一覧の agent は Claude のとき省かれている。ID が別のエージェントと重ならないよう、agent も合わせる。
    isRunning: (id, agent) => live.current().some((l) => l.sessionId === id && (agent === undefined || (l.agent ?? 'claude-code') === agent)),
    // 譲ったセッションは相手が持ち主なので見ない。
    isYielded: (uuid) => sync.syncState.isYielded(uuid),
    // 実行中のセッションの本文は、通知に頼らず 2 秒ごとにも見る。Windows では開いたままの追記で通知が遅れうる。
    liveSessions: () => live.current().map((l) => ({ sessionId: l.sessionId, cwd: l.cwd, agent: l.agent ?? 'claude-code' })),
    // 状態を外すのは resume した後の発言だけである。発言を出したプロセスの起動時刻を、登録と runs から引く。
    processStartOf: (q) => processStartOfPrompt(db, deviceId, live.current(), q),
  });
  // git の表示。値は端末ローカルで、変わったときだけ git.upsert を配る。
  const git = new GitService({
    db, deviceId, live: () => live.current(),
    broadcast: (g) => hub.broadcast({ type: 'git.upsert', git: g }),
    exec: () => { const f = gitPath(); return f ? spawnGit(f) : null; },
  });
  indexer.on({
    progress: (p) => hub.broadcast({ type: 'index.progress', progress: p }),
    // 本文が消えて hasTranscript が偽に変わったとき（transcriptGone）は、索引が行の変化の口へ知らせるので、ここでは受けない。
    sessionChanged: createSessionChangeHandler({
      db, deviceId, hub,
      started: () => life.started,
      workspaceRoot: () => settings.current.workspaceRoot,
      onLocalTranscript: (f) => sync.uploader?.noteChanged(f),
      onAppended: (id) => { void git.noteAppended(id); },
    }),
    error: (e) => console.error('[indexer]', e.path, e.message),
  });
  // 実行中のセッションが増えたり減ったりしたら、見張りの周期を張り直す（0 本なら張らない）。
  live.onChange(() => indexer.noteLiveChanged());
  // 他の PC の行や本文の写しが届いたら、全件走査を 1 回予約する。予約済みなら重ねない。
  sync.onRemoteChange(() => indexer.requestSweep());
  // 写しが降りたときと会話の行が届いたときに、opencode の写しも見直す（行が後から届いた写しも、ここで入る）。
  sync.onRemoteChange(() => { remoteOpencode.refresh(); });
  const memos = new MemoStore({ db, deviceId, home: home.home });
  let stopMemoWatch: () => void = () => undefined;
  let rootTimer: ReturnType<typeof setInterval> | null = null;
  return {
    indexer, memos, git,
    bindContextSize(of) { contextSize = of; },
    async start() {
      await indexer.start();
      // この PC に場所のあるプロジェクトの git の remote の空きを埋める。ほかの PC が同じリポジトリを見分けるのに使う（projects/link.ts）。
      fillProjectRemotes(db, deviceId);
      syncProjectsFromWorkspace(db, deviceId, settings.current.workspaceRoot);
      assignSessions(db, deviceId);
      ensureScratchProject(db, deviceId, home.home);
      // メモは DB とファイルの両方にある。起動時に食い違いを直し、以後はファイルの外部編集を監視で取り込む。
      // 取り込んだメモは project_memos の行を書くので、memo.update とプロジェクトの配り直しは events/publisher.ts が受け持つ。
      memos.reconcileAll();
      stopMemoWatch = memos.watch(() => undefined);
      const checkRootsNow = () => checkRoots({ db, deviceId, broadcast: (ev) => hub.broadcast(ev) });
      checkRootsNow();
      rootTimer = setInterval(checkRootsNow, ROOT_CHECK_MS);
      rootTimer.unref();
    },
    stopTimers() { if (rootTimer) clearInterval(rootTimer); },
    stopMemoWatch: () => stopMemoWatch(),
  };
}
