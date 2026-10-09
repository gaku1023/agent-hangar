import { isReturnOn, isReturnTime, localDate, returnAtMs, type SessionDto } from '@agent-hangar/shared';
import type { Effect, Input, State, Step } from './types.ts';

/**
 * returnDue 領域：時刻つきの Paused が、その時刻を過ぎたことの知らせ。
 * 過ぎたものの一覧は、ストアと時計を持つランタイムが届ける（return.due）。
 * 新しく過ぎたものに通知の効果（OS の通知）を出す。知らせるのは戻る時点ごとに 1 回だけである。
 * 右下の札は入力待ちだけなので、画面の知らせはここでは持たない。ベルの一覧の行は、事実から Presenter が組む（presenters/notices.ts）。
 * 日付だけの Paused は知らせない（Home の「今日戻る」に朝から出ている）。
 */

/** 知らせ終えた鍵を残す localStorage の鍵。値は鍵の並び。開き直しても同じ時点をもう一度知らせないために覚える。 */
export const RETURN_SEEN_KEY = 'return.notified';

/** 保存してあった鍵の並びを読む。文字列でないものは捨てる。 */
export function readReturnSeen(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
}

/** 鍵は「セッションの id|戻る日 戻る時刻」。時刻を付け直したら別の鍵になり、もう一度知らせる。 */
const keyOf = (id: string, returnOn: string, returnTime: string) => `${id}|${returnOn} ${returnTime}`;
export const sessionIdOfReturnKey = (key: string): string => key.slice(0, key.lastIndexOf('|'));

/** 時刻つきの Paused と、その戻る時点。形の違う日付と時刻は除く。 */
function timed(sessions: Record<string, SessionDto>): { id: string; returnOn: string; returnTime: string; at: number }[] {
  const out: { id: string; returnOn: string; returnTime: string; at: number }[] = [];
  for (const s of Object.values(sessions)) {
    const st = s.state;
    if (st?.status !== 'paused' || typeof st.returnOn !== 'string' || typeof st.returnTime !== 'string') continue;
    if (!isReturnOn(st.returnOn) || !isReturnTime(st.returnTime)) continue;
    out.push({ id: s.id, returnOn: st.returnOn, returnTime: st.returnTime, at: returnAtMs(st.returnOn, st.returnTime) });
  }
  return out;
}

/**
 * 時刻つきの Paused のうち、今日その時刻を過ぎたものの鍵。並びは鍵の順で、同じ中身なら同じ並びになる。
 * 前の日に過ぎたものは入れない。何日も閉じていた後に開いて、古い時点をまとめて知らせないためである（それらは Home の「今日戻る」に残る）。
 */
export function dueReturnKeys(sessions: Record<string, SessionDto>, now: number): string[] {
  const today = localDate(now);
  return timed(sessions).filter((t) => t.returnOn === today && t.at <= now).map((t) => keyOf(t.id, t.returnOn, t.returnTime)).sort();
}

/** これから来る、いちばん近い戻る時点。無ければ null。ランタイムが次に見直す時刻に使う。 */
export function nextReturnAt(sessions: Record<string, SessionDto>, now: number): number | null {
  let next: number | null = null;
  for (const t of timed(sessions)) if (t.at > now && (next === null || t.at < next)) next = t.at;
  return next;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function returnStep(state: State, input: Input): Step | null {
  if (input.kind !== 'runtime' || input.event.type !== 'return.due') return null;
  const keys = input.event.keys;
  if (same(keys, state.returnSeen)) return { state, effects: [] };
  const seen = new Set(state.returnSeen);
  const added = keys.filter((k) => !seen.has(k)).map(sessionIdOfReturnKey);
  // 通知を出すかどうかは、ランタイムが窓の様子と設定を見て決める。
  const effects: Effect[] = added.map((sessionId) => ({ kind: 'notify.return', sessionId }));
  effects.push({ kind: 'storage.save', key: RETURN_SEEN_KEY, value: keys });
  return { state: { ...state, returnSeen: keys }, effects };
}
