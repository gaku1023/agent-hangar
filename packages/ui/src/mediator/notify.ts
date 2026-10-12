import { stopReasonOf } from '@agent-hangar/shared';
import { waitingSessionIds, type Store } from '../store/store.ts';
import { dueReturnKeys, sessionIdOfReturnKey } from './returnDue.ts';
import type { Input, State, Step } from './types.ts';

/**
 * 通知を受け取るかを残す localStorage の鍵。
 * 値は真偽値そのもの。
 * 無ければ環境ごとの既定に従う。
 */
export const NOTIFY_KEY = 'notify.waiting';

/**
 * 通知の受け取りの切り替え。
 * 通知を出せるか、受け取るかは Runtime しか知らない事実なので、Store が持つ（store.ts の notify）。ここは切り替えを効果にするだけである。
 * 受け取るにするときは許可を求める。切り替わるのは、許可の結果を Runtime が Store に入れたときである。
 * ブラウザの許可ダイアログは利用者の操作の中でしか出せないので、この効果は押した操作のその場で走る。
 * 受け取らないにするときは、Runtime がその場で切り替えて覚える。
 */
export function notifyStep(state: State, input: Input): Step | null {
  if (input.kind !== 'action' || input.action.type !== 'notify.set') return null;
  return { state, effects: [{ kind: input.action.on ? 'notify.request' : 'notify.off' }] };
}

/**
 * 通知センターに残してよい知らせの顔ぶれ。
 * 入力待ちの知らせは、いま入力待ちのセッションのものだけを残す（答えた、止めた、Archived や Done にしたものは外す）。
 * 戻る時刻の知らせは、今日その時刻を過ぎてまだ Paused のセッションのものだけを残す（resume した、時点を付け直した、日が変わったものは外す）。
 * 使用制限の知らせは、使用制限でリセットを待っているセッションのものだけを残す（リセット済みになった、続きが始まった、終わったものは外す）。
 * Runtime は、これが変わるたびと、起動して一覧を読み終えたときに、殻（notify_prune）とブラウザの通知へ渡す。
 * 同じ顔ぶれなら同じ答えになるよう、id の順に並べる。入力待ちの並び（最後の動きの順）が変わるたびに殻を呼ばないためである。
 */
export function notifyKeep(store: Store, now: number): { waiting: string[]; returning: string[]; limited: string[] } {
  const sorted = (ids: string[]) => [...new Set(ids)].sort();
  return {
    waiting: sorted(waitingSessionIds(store)),
    returning: sorted(dueReturnKeys(store.sessions, now).map(sessionIdOfReturnKey)),
    // 使用制限の知らせ（デスクトップの殻だけが出す）は、そのセッションがまだリセットを待っている間だけ残す。
    limited: sorted(Object.values(store.sessions).filter((s) => stopReasonOf(s) === 'limit').map((s) => s.id)),
  };
}
