import { translatorOf } from '../presenters/i18n.ts';
import type { Store } from '../store/store.ts';
import { overlayReplaceable } from './overlay.ts';
import type { Input, LinkRepairState, State, Step } from './types.ts';

const EMPTY: LinkRepairState = { detail: null, working: false, error: null };

/** 閉じたあとの戻り先。新しいセッションのダイアログから来たときだけ、そのダイアログを開き直す。 */
const backOf = (o: State['overlay']) => (o.kind === 'linkRepair' && o.back ? o.back : { kind: 'none' as const });

/** 修復の対象のアカウントの名前。一覧に無ければ id のまま言う。 */
function accountName(store: Store, agent: 'claude-code' | 'codex', id: string): string {
  const list = agent === 'codex' ? store.accounts?.codex?.accounts : store.accounts?.accounts;
  return list?.find((a) => a.id === id)?.name ?? id;
}

/**
 * linkRepair 領域：共有のリンクが実ファイルに置き換わった衝突の修復のダイアログ（#513）。
 * 開くと両側の中身を読み、選んだとおりに直す。直せたら閉じて、右下に知らせを出す。
 * 新しいセッションのダイアログから開いたときは、閉じるか直せたらそこへ戻る（直せたときは起動の失敗の行を消す）。
 * 起動の失敗の入口（トーストの「修復…」）は launchStep が組む。
 */
export function linkRepairStep(state: State, store: Store, input: Input): Step | null {
  const o = state.overlay;
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type !== 'linkRepair.loaded' && e.type !== 'linkRepair.loadFailed' && e.type !== 'linkRepair.done' && e.type !== 'linkRepair.failed') return null;
    // 閉じたあとに届いたものは捨てる。
    if (o.kind !== 'linkRepair') return { state, effects: [] };
    switch (e.type) {
      case 'linkRepair.loaded':
        // ほかで直っていた。見せるものが無いので閉じる。
        if (e.detail.entries.length === 0) return { state: { ...state, overlay: backOf(o), linkRepair: EMPTY }, effects: [] };
        return { state: { ...state, linkRepair: { detail: e.detail, working: false, error: null } }, effects: [] };
      case 'linkRepair.loadFailed': return { state: { ...state, linkRepair: { ...state.linkRepair, error: e.message } }, effects: [] };
      case 'linkRepair.failed': return { state: { ...state, linkRepair: { ...state.linkRepair, working: false, error: e.message } }, effects: [] };
      case 'linkRepair.done': {
        const t = translatorOf(store);
        const message = t('account.repair.done', { account: accountName(store, o.agent, o.accountId), names: e.names.join(t('common.list.separator')) });
        const launch = o.back ? { kind: 'idle' as const } : state.launch;
        return { state: { ...state, overlay: backOf(o), linkRepair: EMPTY, launch }, effects: [{ kind: 'toast', level: 'info', message }] };
      }
    }
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'linkRepair.open': {
      // 新しいセッションのダイアログだけは、戻り先に覚えて重ねる。確認など決めるまで閉じないものの上には重ねない。
      const back = o.kind === 'newSession' ? o : null;
      if (!back && !overlayReplaceable(o)) return { state, effects: [] };
      return { state: { ...state, overlay: { kind: 'linkRepair', agent: i.agent, accountId: i.accountId, back }, linkRepair: EMPTY }, effects: [{ kind: 'api.linkRepair.load', agent: i.agent, accountId: i.accountId }] };
    }
    case 'linkRepair.apply': {
      if (o.kind !== 'linkRepair' || state.linkRepair.detail === null || state.linkRepair.working || i.entries.length === 0) return { state, effects: [] };
      return { state: { ...state, linkRepair: { ...state.linkRepair, working: true, error: null } }, effects: [{ kind: 'api.linkRepair.apply', agent: o.agent, accountId: o.accountId, entries: i.entries }] };
    }
    case 'overlay.close':
      // overlayStep より先に横取りする。直している最中は閉じない（返事を待つ）。
      if (o.kind !== 'linkRepair') return null;
      if (state.linkRepair.working) return { state, effects: [] };
      return { state: { ...state, overlay: backOf(o), linkRepair: EMPTY }, effects: [] };
    default: return null;
  }
}
