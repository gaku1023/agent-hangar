import type { ConfigSyncPart } from '@agent-hangar/shared';
import { configPartsToLoad, type ConfigDetailPart, type Store } from '../store/store.ts';
import { overlayReplaceable } from './overlay.ts';
import type { Effect, Input, State, Step } from './types.ts';

/** ダイアログごとに、開いたとき（と状態が動いたとき）に取り直す中身。 */
const PARTS_OF: Record<ConfigSyncPart, ConfigDetailPart[]> = { send: ['outgoing'], review: ['inbox'], approve: ['inbox'], conflicts: ['conflicts'] };

const load = (parts: ConfigDetailPart[]): Effect[] => (parts.length > 0 ? [{ kind: 'api.configSyncLoad', parts }] : []);

/**
 * configSync 領域：設定の同期（作り直した実装）のダイアログ。
 * ダイアログは 1 つの overlay（configSync）で、part が 4 つの顔（送る一覧、適用内容の確認、承諾、競合）を決める。
 * 選んだ項目（チェック、採る側）は View が持ち、適用の Intent で 1 度に渡す。Mediator は、開く、適用の最中に閉じさせない、結果で閉じる、だけを持つ。
 * 適用は、サーバに指示書を書かせてから、殻のネイティブの確認へ進む（runtime）。この領域は ~/.claude に何も書かない。
 * 画面の中身（件数でなく項目）は、設定の画面を見ているあいだと、ダイアログを開いているあいだだけ、状態が動くたびに取り直す。
 */
export function configSyncStep(state: State, store: Store, input: Input): Step | null {
  const o = state.overlay;
  if (input.kind === 'server') {
    if (input.event.type !== 'config.update') return null;
    if (o.kind === 'configSync') return { state, effects: load(PARTS_OF[o.part]) };
    if (state.screen.name === 'settings') return { state, effects: load(configPartsToLoad(store.configSync)) };
    return { state, effects: [] };
  }
  if (input.kind === 'runtime') {
    if (input.event.type !== 'configSync.done') return null;
    if (o.kind !== 'configSync') return { state, effects: [] };
    return { state: { ...state, overlay: input.event.close ? { kind: 'none' } : { ...o, working: false } }, effects: [] };
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'configSync.open': {
      // 適用の返事を待つあいだは別の部分へ移さない。ほかのダイアログは黙って差し替えない。
      const movable = overlayReplaceable(o) || (o.kind === 'configSync' && !o.working);
      if (!movable) return { state, effects: [] };
      return { state: { ...state, overlay: { kind: 'configSync', part: i.part, working: false } }, effects: load(PARTS_OF[i.part]) };
    }
    // 送る一覧を承諾した。スイッチを入れる。
    case 'configSync.send.confirm':
      if (o.kind !== 'configSync' || o.part !== 'send') return { state, effects: [] };
      return { state: { ...state, overlay: { kind: 'none' } }, effects: [{ kind: 'api.updateSettings', patch: { configBundleSync: true } }] };
    case 'configSync.apply':
      if (o.kind !== 'configSync' || o.working || i.entries.length === 0) return { state, effects: [] };
      return { state: { ...state, overlay: { ...o, working: true } }, effects: [{ kind: 'api.configSyncApply', entries: i.entries }] };
    case 'configSync.order.apply': return { state, effects: [{ kind: 'api.configSyncApply', entries: null }] };
    case 'configSync.restore': return { state, effects: [{ kind: 'api.configSyncRestore', name: i.name }] };
    // 書き込んでいる（指示書を書いて、ネイティブの確認を待っている）あいだは閉じさせない。閉じても適用は止まらず、結果だけが見えなくなる。
    case 'overlay.close': return o.kind === 'configSync' && o.working ? { state, effects: [] } : null;
    default: return null;
  }
}
