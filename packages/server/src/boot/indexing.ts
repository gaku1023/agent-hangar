import { remoteRoot } from '../config/cloud.ts';
import { IndexerService } from '../indexer/service.ts';
import { MemoStore } from '../projects/memo.ts';
import { createSessionChangeHandler } from '../projects/onSessionChanged.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { checkRoots } from '../projects/rootCheck.ts';
import { ensureScratchProject } from '../projects/scratch.ts';
import { VERIFIED_CLAUDE_VERSION } from '../provider/claude-code/compat/version.ts';
import { processStartOfPrompt } from '../sessions/promptProcess.ts';
import type { DeliveryParts } from './delivery.ts';
import type { HomeParts } from './home.ts';
import type { SyncParts } from './sync.ts';

const ROOT_CHECK_MS = 30_000;

export type IndexingParts = {
  indexer: IndexerService;
  memos: MemoStore;
  /**
   * 最初の索引づけと、プロジェクトへの紐づけを済ませる。
   * 全走査、ワークスペースからのプロジェクトの登録、紐づけ、スクラッチの用意、メモの突き合わせと監視、ルートの確かめ、の順である。
   */
  start(): Promise<void>;
  /** ルートの確かめの周期を止める。 */
  stopTimers(): void;
  /** メモのファイルの監視を止める。 */
  stopMemoWatch(): void;
};

/**
 * 索引と、索引から決まるプロジェクトの持ち場を組む。
 * 索引は、本文のファイルを読んでセッションの行を書く。行は配る層が画面へ届ける。
 * ここで結ぶのは、行に対応しない知らせ（進み、本文の伸び）と、現れたセッションのプロジェクトへの紐づけである。
 * 手元の本文が動いたら、同期の上げ手へ知らせる。
 */
export function bootIndexing(
  home: Pick<HomeParts, 'home' | 'db' | 'device' | 'claudeDir' | 'settings' | 'language' | 'life'>,
  delivery: Pick<DeliveryParts, 'hub' | 'registry' | 'compatLog' | 'claudeVersion'>,
  sync: Pick<SyncParts, 'uploader' | 'syncState'>,
): IndexingParts {
  const { db, claudeDir, settings, life } = home;
  const { hub, registry } = delivery;
  const deviceId = home.device.id;
  const indexer = new IndexerService({
    db, deviceId, claudeDir,
    isRunning: (id) => registry.current().some((l) => l.sessionId === id),
    // 他端末から降ろした本文も索引化の対象にする。譲ったセッションは相手が持ち主なので見ない。
    remoteRoot: remoteRoot(home.home),
    isYielded: (uuid) => sync.syncState.isYielded(uuid),
    // 状態を外すのは resume した後の発言だけである。発言を出したプロセスの起動時刻を、登録と runs から引く。
    processStartOf: (q) => processStartOfPrompt(db, deviceId, registry.current(), q),
    // 手元の本文の行を見張る。手元の claude の版より古い行は昔の形として見ない。版が読めるまでは確かめた版を床にする。
    compat: { sink: delivery.compatLog, since: () => delivery.claudeVersion.current ?? VERIFIED_CLAUDE_VERSION },
  });
  indexer.on({
    progress: (p) => hub.broadcast({ type: 'index.progress', progress: p }),
    // 本文が消えて hasTranscript が偽に変わったとき（transcriptGone）は、索引が行の変化の口へ知らせるので、ここでは受けない。
    sessionChanged: createSessionChangeHandler({
      db, deviceId, hub, language: home.language,
      started: () => life.started,
      workspaceRoot: () => settings.current.workspaceRoot,
      onLocalTranscript: (f) => sync.uploader?.noteChanged(f),
    }),
    error: (e) => console.error('[indexer]', e.path, e.message),
  });
  const memos = new MemoStore({ db, deviceId, home: home.home });
  let stopMemoWatch: () => void = () => undefined;
  let rootTimer: ReturnType<typeof setInterval> | null = null;
  return {
    indexer, memos,
    async start() {
      await indexer.start();
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
