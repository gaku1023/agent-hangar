import { remoteRoot } from '../config/cloud.ts';
import { moveToTrash } from '../platform/trash.ts';
import { sessionRunsAnywhere } from '../runs/announce.ts';
import { SessionTrash } from '../sessions/trash.ts';
import type { DeliveryParts } from './delivery.ts';
import type { HomeParts } from './home.ts';
import type { IndexingParts } from './indexing.ts';
import type { SyncParts } from './sync.ts';

export type TrashParts = {
  /** セッションの削除と、届いた印の処理と、ゴミ箱からの復元。 */
  trash: SessionTrash;
  /** 周期の処理を始め、すぐに 1 回回す。起きていなかった間に届いた印も、ここで処理する。 */
  start(): void;
  /** 周期の処理を止め、走っている回を待つ。 */
  stop(): Promise<void>;
};

/**
 * セッションの削除の受け持ち（sessions/trash.ts）を組む。
 * 本文は OS のゴミ箱へ移す（platform/trash.ts）。実行中かどうかは、run の行と実行中の一覧から見る。
 * 同期で session_states が届いたとき、索引が削除したセッションの本文を見たときに、次の回を回す。
 * この PC で戻したら索引に全件走査を頼み、ほかの PC で戻されたら写しを降ろし直す。
 */
export function bootTrash(
  home: Pick<HomeParts, 'home' | 'db' | 'device' | 'claudeDir'>,
  delivery: Pick<DeliveryParts, 'live'>,
  sync: Pick<SyncParts, 'onStatesApplied' | 'refetchSession'>,
  indexing: Pick<IndexingParts, 'indexer'>,
): TrashParts {
  const { db, claudeDir } = home;
  const deviceId = home.device.id;
  const live = () => delivery.live.current();
  const runHere = db.prepare('select 1 from runs where session_id = ? and device_id = ? and ended_at is null and deleted_at is null limit 1');
  const providerOf = db.prepare('select provider_session_id p from sessions where id = ?');
  const trash = new SessionTrash({
    db, deviceId, claudeDir, remoteRoot: remoteRoot(home.home),
    trash: (p) => moveToTrash(p),
    runsAnywhere: (id) => sessionRunsAnywhere({ db, deviceId, live }, id),
    runsHere: (id) => {
      if (runHere.get(id, deviceId)) return true;
      const s = providerOf.get(id) as { p: string } | undefined;
      return !!s && live().some((l) => l.sessionId === s.p);
    },
    onRestored: () => indexing.indexer.requestSweep(),
    onRestoredElsewhere: (uuid) => sync.refetchSession(uuid),
  });
  const offStates = sync.onStatesApplied(() => trash.schedule());
  const offIndexer = indexing.indexer.on({ deletedSeen: () => trash.schedule() });
  return {
    trash,
    start: () => trash.start(),
    stop: async () => {
      offStates();
      offIndexer();
      trash.stop();
      await trash.idle();
    },
  };
}
