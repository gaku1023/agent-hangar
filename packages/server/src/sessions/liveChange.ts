import type { LiveSessionDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import type { NoticeEvent } from '../events/publisher.ts';
import { writeBaselineIfNeeded } from '../indexer/baseline.ts';
import { statusChanged } from './park.ts';
import { getSessionState } from './states.ts';

export type LiveChangeDeps = {
  db: Db; deviceId: string;
  hub: { broadcast(ev: NoticeEvent): void };
  /** 休みの数え直し（ParkWatch.reset）。動きが変わった会話に呼ぶ。 */
  resetPark: (sessionId: string) => void;
  /** hangar が起こした run に Claude の pid を書き込む（RunManager.linkRegistry）。書き込むのはここだけである。 */
  linkRegistry: (live: LiveSessionDto[]) => void;
};

/**
 * 実行中の一覧（Claude の登録）が変わったときの受け手を作る。RegistryWatcher.onChange に渡す。
 *
 * 持っているのは、直前の一覧の写しである。
 * 出入りしたセッションを見て土台の要約と問いを直し、動きが変わった印付きのセッションを配り直す。
 * 最初の読み取りは onChange を通らないので、一覧を読み始めた直後に prime で覚えさせる。
 */
export function createLiveChangeHandler(deps: LiveChangeDeps): { prime(live: readonly LiveSessionDto[]): void; onChange(live: LiveSessionDto[]): void } {
  const { db, deviceId, hub } = deps;
  // 実行中だったセッションの id。出入りを見て土台の要約の状態を書き替えるために持つ。
  let liveIds = new Set<string>();
  // 会話ごとの直前の動き。動きが変わった印付きのセッションを配り直すために持つ。
  let liveStatus = new Map<string, LiveSessionDto['status']>();
  const sessionIdOf = (providerSessionId: string): string | null =>
    (db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ?").get(providerSessionId) as { id: string } | undefined)?.id ?? null;
  return {
    prime(live) {
      liveIds = new Set(live.map((l) => l.sessionId));
      // 起動のときに動いていた会話の動きも覚えておく。
      liveStatus = new Map(live.map((l) => [l.sessionId, l.status]));
    },
    onChange(live) {
      hub.broadcast({ type: 'live.update', live });
      // Claude の最後の書き込みは登録ファイルの削除より前に起きるので、索引の側では終了に気付けない。
      // 出入りしたセッションだけ、ここで土台の要約を書き直す。
      const now = new Set(live.map((l) => l.sessionId));
      const moved = [...new Set([...now, ...liveIds])].filter((id) => now.has(id) !== liveIds.has(id));
      liveIds = now;
      for (const providerSessionId of moved) {
        const sessionId = sessionIdOf(providerSessionId);
        if (!sessionId) continue;
        // 終わったセッションの問いにはもう答えられない。
        // 行を残すと、再開した直後の要対応の札に前の run の問いが出てしまうので、問いだけを消す。
        if (!now.has(providerSessionId)) db.prepare('update session_activity set question = null where session_id = ?').run(sessionId);
        writeBaselineIfNeeded(db, sessionId, deviceId, now.has(providerSessionId));
        // 実行中かどうかは行に無い。行は変わらなくても中身が変わるので、名指しして配り直してもらう。
        touchRow(db, 'sessions', sessionId);
      }
      // 区切りを付けたセッションは、動きが変わると実行中に数えるか（parked）も変わる。
      // UI は live.update から動きしか直せないので、印の付いたものだけ行ごと配り直す。
      for (const providerSessionId of statusChanged(liveStatus, live)) {
        const sessionId = sessionIdOf(providerSessionId);
        if (!sessionId) continue;
        // 動きが変わったら、休みの数え直しにする。
        deps.resetPark(sessionId);
        if (getSessionState(db, sessionId)?.status) touchRow(db, 'sessions', sessionId);
      }
      liveStatus = new Map(live.map((l) => [l.sessionId, l.status]));
      // 実行中の数はどのプロジェクトでも変わりうるので、全部を名指しする。組むのは配る層で、受け手がいなければ組まない。
      for (const p of db.prepare('select id from projects where deleted_at is null').all() as { id: string }[]) touchRow(db, 'projects', p.id);
      deps.linkRegistry(live);
    },
  };
}
