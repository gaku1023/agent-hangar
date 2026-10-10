import type { SyncSkippedDto, SyncStatusDto } from '@agent-hangar/shared';
import type { NoticeEvent } from '../events/publisher.ts';
import type { SyncListener } from './engine.ts';
import type { Toast } from './notices.ts';

export type SyncFeedDeps = {
  hub: { broadcast(ev: NoticeEvent): void };
  puller: { skippedEntries(): SyncSkippedDto[]; pullNow(): Promise<unknown> } | null;
  uploader: { pendingSweep(): number | null } | null;
  /** 一時停止のまま頼まれた 1 巡の最中か。 */
  oncePass: () => boolean;
  /** 本文と設定の出し入れを止めるか（sync/halt.ts の syncHalted）。 */
  isPaused: () => boolean;
  cloudUsage: { refresh(): Promise<unknown> };
  toast: Toast;
  log?: (...a: unknown[]) => void;
};

export type SyncFeed = {
  /** 降ろすのを諦めた項目。 */
  skipped(): SyncSkippedDto[];
  /** 取り残した本文の件数。数えられない端末では null。 */
  sweep(): number | null;
  oncePass(): boolean;
  /** 同期の状態を、付録を添えて画面へ配る。 */
  broadcastSync(s: SyncStatusDto): void;
  /** ファイルの取り込みを頼む。 */
  pullFiles(): void;
  /** SyncEngine.on に渡す受け手を作る。 */
  listener(): SyncListener;
};

/**
 * 同期の状態を画面へ届ける道と、メタデータの後のファイルの取り込みを組む。
 *
 * 状態に添える付録について。
 * 諦めた本文を覚えているのは RemotePuller、取り残しを数えられるのは TranscriptUploader だけで、
 * どちらも SyncEngine の外にある。だから状態を配る手前で、ここが足す。
 * HTTP の応答（createApp の deps）と websocket の通知の、両方がこれを通る。
 */
export function createSyncFeed(deps: SyncFeedDeps): SyncFeed {
  const log = deps.log ?? console.error;
  const skipped = (): SyncSkippedDto[] => deps.puller?.skippedEntries() ?? [];
  const sweep = (): number | null => deps.uploader?.pendingSweep() ?? null;
  const oncePass = (): boolean => deps.oncePass();
  const broadcastSync = (s: SyncStatusDto): void => {
    deps.hub.broadcast({ type: 'sync.status', status: { ...s, skipped: skipped(), sweepPending: sweep(), oncePass: oncePass() } });
  };
  // 重なりは RemotePuller が自分の鎖で防ぐので、ここでは頼むだけでよい。
  const pullFiles = (): void => {
    // 一時停止のあいだは降ろしにも行かない。止めた意味が無くなる。
    if (deps.isPaused()) return;
    void deps.puller?.pullNow().catch((e: unknown) => log('[files]', e instanceof Error ? e.message : e));
  };
  // pull で入れ替わった行は、適用の側が行の変化の口へ知らせ、events/publisher.ts が画面に届ける。
  // 一時停止が解けたら使用量を取り直す。止まっている間は取りに行かないので、画面の値が古いままになる。
  const listener = (): SyncListener => {
    let wasPaused = deps.isPaused();
    return {
      // 付録を添えてから流す。添えないと、画面の件数が一度受け取った値のまま固まる。
      status: (s) => {
        broadcastSync(s);
        const pausedNow = s.state === 'paused';
        if (wasPaused && !pausedNow) void deps.cloudUsage.refresh();
        wasPaused = pausedNow;
      },
      toast: (level, message) => deps.toast(level, message),
      // メタデータの pull の後に、ファイルの新着を取りに行く。
      // 頼まれた 1 巡の最中は、その巡が自分で降ろしに行く（sync/oncePass.ts の rest）。
      pulled: () => { if (!deps.oncePass()) pullFiles(); },
    };
  };
  return { skipped, sweep, oncePass, broadcastSync, pullFiles, listener };
}
