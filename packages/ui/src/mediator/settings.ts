import { ITERM_HINT, type Effect, type Input, type SaveMark, type State, type Step } from './types.ts';

/** 欄の知らせを 1 つ差し替える。undefined はその欄の知らせを消す。 */
function mark(state: State, field: string, next: SaveMark | undefined): State {
  const { [field]: _old, ...rest } = state.settingsSave;
  return { ...state, settingsSave: next ? { ...rest, [field]: next } : rest };
}

/**
 * settings 領域：設定の保存と、準備の確かめと、殻に頼む操作。
 * 欄ごとの保存は、結果をその欄に返す（✓ 保存しました、または欄の下の理由）。
 */
export function settingsStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type === 'settings.saved') {
      const prev = state.settingsSave[e.field];
      return { state: mark(state, e.field, { kind: 'saved', n: prev?.kind === 'saved' ? prev.n + 1 : 1 }), effects: [] };
    }
    if (e.type === 'settings.failed') return { state: mark(state, e.field, { kind: 'error', message: e.message }), effects: [] };
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'settings.update': {
      const effects: Effect[] = [i.field ? { kind: 'api.updateSettings', patch: i.patch, field: i.field } : { kind: 'api.updateSettings', patch: i.patch }];
      if (i.patch.terminalApp === 'iterm') effects.push({ kind: 'toast', level: 'info', message: ITERM_HINT });
      // 保存し直し始めたら、前の理由は消す。印（saved）は番号を続けたいので残す。
      const next = i.field && state.settingsSave[i.field]?.kind === 'error' ? mark(state, i.field, undefined) : state;
      return { state: next, effects };
    }
    case 'readiness.check': return { state, effects: [{ kind: 'api.readiness' }] };
    case 'shell.openLog': return { state, effects: [{ kind: 'shell.openLog' }] };
    case 'shell.restart': return { state, effects: [{ kind: 'shell.restart' }] };
    case 'clipboard.copy': return { state, effects: [{ kind: 'clipboard.copy', text: i.text }] };
    default: return null;
  }
}
