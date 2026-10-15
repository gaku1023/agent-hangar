import { translatorOf } from '../presenters/i18n.ts';
import { sessionAddressLine } from '../presenters/session.ts';
import type { Store } from '../store/store.ts';
import type { Effect, Input, SaveMark, State, Step } from './types.ts';

/** 欄の知らせを 1 つ差し替える。undefined はその欄の知らせを消す。 */
function mark(state: State, field: string, next: SaveMark | undefined): State {
  const { [field]: _old, ...rest } = state.settingsSave;
  return { ...state, settingsSave: next ? { ...rest, [field]: next } : rest };
}

/** 変わると準備の確かめ（道具のパス、作業フォルダ、claude の置き場）の答えが変わる欄。 */
const READINESS_KEYS: ReadonlySet<string> = new Set(['claudePath', 'tmuxPath', 'nodePath', 'editor', 'workspaceRoot', 'claudeDir']);

/**
 * settings 領域：設定の保存と、準備の確かめと、殻に頼む操作。
 * 欄ごとの保存は、結果をその欄に返す（✓ 保存しました、または欄の下の理由）。
 */
export function settingsStep(state: State, store: Store, input: Input): Step | null {
  // API やほかの窓から設定が直された。自分の保存でも届くが、取り直しは番号で最新の答えだけを採るので二重になってよい。
  if (input.kind === 'server') {
    if (input.event.type !== 'settings.changed') return null;
    return { state, effects: input.event.keys.some((k) => READINESS_KEYS.has(k)) ? [{ kind: 'api.readiness' }] : [] };
  }
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type === 'settings.saved') {
      const prev = state.settingsSave[e.field];
      return { state: mark(state, e.field, { kind: 'saved', n: prev?.kind === 'saved' ? prev.n + 1 : 1 }), effects: [] };
    }
    if (e.type === 'settings.failed') return { state: mark(state, e.field, { kind: 'error', message: e.message }), effects: [] };
    if (e.type === 'clipboard.copied') return { state: { ...state, copied: { text: e.text, n: (state.copied?.n ?? 0) + 1 } }, effects: [] };
    return null;
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'settings.update': {
      const effects: Effect[] = [i.field ? { kind: 'api.updateSettings', patch: i.patch, field: i.field } : { kind: 'api.updateSettings', patch: i.patch }];
      if (i.patch.terminalApp === 'iterm') effects.push({ kind: 'toast', level: 'info', message: translatorOf(store)('mediator.settings.itermHint') });
      // 保存し直し始めたら、前の理由は消す。印（saved）は番号を続けたいので残す。
      const next = i.field && state.settingsSave[i.field]?.kind === 'error' ? mark(state, i.field, undefined) : state;
      return { state: next, effects };
    }
    case 'readiness.check': return { state, effects: [{ kind: 'api.readiness' }] };
    case 'shell.openLog': return { state, effects: [{ kind: 'shell.openLog' }] };
    case 'shell.restart': return { state, effects: [{ kind: 'shell.restart' }] };
    case 'clipboard.copy': return { state, effects: [{ kind: 'clipboard.copy', text: i.text, ...(i.done !== undefined ? { done: i.done } : {}) }] };
    case 'session.copyAddress': {
      const text = sessionAddressLine(store, i.id);
      return { state, effects: text === null ? [] : [{ kind: 'clipboard.copy', text, done: translatorOf(store)('session.address.copied') }] };
    }
    default: return null;
  }
}
