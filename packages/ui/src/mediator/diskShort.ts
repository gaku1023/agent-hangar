import { diskShortTitle } from '../presenters/notices.ts';
import { translatorOf } from '../presenters/i18n.ts';
import type { Store } from '../store/store.ts';
import type { State } from './types.ts';

/**
 * 空きが足りずに本文の取得を止めた瞬間に、札を 1 回だけ出す（2026-10-26 の利用者の決定、案 C）。
 * 札は気づかせる役で、空けるまで残る事実は注意の一覧の行が持つ（presenters/notices.ts）。札の文は行の題と同じである。
 * 止めている間は二度出さず、解けたら印を戻す。次にまた止まれば、また 1 回出す。
 * 同期を使っていない端末（off）では出さない。動かなければ同じ state を返す。
 */
export function diskShortStep(state: State, store: Store): State {
  const short = store.sync && store.sync.state !== 'off' ? store.sync.diskShort : null;
  if (!short) return state.diskShortToasted ? { ...state, diskShortToasted: false } : state;
  if (state.diskShortToasted) return state;
  const toast = { id: String(state.nextToastId), level: 'info' as const, message: diskShortTitle(translatorOf(store), short) };
  return { ...state, toasts: [...state.toasts, toast], nextToastId: state.nextToastId + 1, diskShortToasted: true };
}
