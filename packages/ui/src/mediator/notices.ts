import type { Input, State, Step } from './types.ts';

/** ベルの既読の鍵を残す localStorage の鍵。値は行の鍵（種類、対象、事実の版）の並びで、新しいものが後ろ。端末ごとで、同期しない。 */
export const NOTICES_READ_KEY = 'notices.read';
/** 残す既読の鍵の数の上限。事実が無くなった行の鍵は誰も消さないので、古い側から捨てて育ちきらないようにする。 */
export const NOTICES_READ_MAX = 200;

/** 保存してあった鍵の並びを読む。文字列でないものと重なりは捨て、多すぎれば新しい側を残す。 */
export function readNoticesRead(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const keys = [...new Set(v.filter((k): k is string => typeof k === 'string'))];
  return keys.slice(-NOTICES_READ_MAX);
}

/**
 * notices 領域：ベルの一覧の既読。
 * 一覧の行は事実から Presenter が組むので、ここが持つのは既読の鍵だけである（presenters/notices.ts）。
 * 「すべて既読にする」も、View が、いま一覧にある鍵を全部送ってくる。サーバと DB は動かさない。
 * ベルが開いているかは View の中に持つ（Mediator は読まない）。
 */
export function noticesStep(state: State, input: Input): Step | null {
  if (input.kind !== 'action' || input.action.type !== 'notices.read') return null;
  const seen = new Set(state.noticesRead);
  const added = [...new Set(input.action.keys)].filter((k) => !seen.has(k));
  if (added.length === 0) return { state, effects: [] };
  const next = [...state.noticesRead, ...added].slice(-NOTICES_READ_MAX);
  return { state: { ...state, noticesRead: next }, effects: [{ kind: 'storage.save', key: NOTICES_READ_KEY, value: next }] };
}
