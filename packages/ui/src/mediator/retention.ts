import type { Input, State, Step } from './types.ts';

/**
 * retention 領域：書き込む前の確認。
 * 保持期間の帯はヘッダーの下から無くなり、ベルの一覧の行になった（presenters/notices.ts）。
 * 確認は開いた時点で下見を取りに行き、書き込みは送信中の間もう一度押しても重ねない。
 * 閉じる（overlay.close）は overlay 領域がまとめて扱う。ただし書き込んでいる間だけは、ここで握りつぶす（overlay 領域より前に置く）。
 * 書けたときのトーストは、日数の言い方を知っているランタイムが出す（Mediator は表示の言い方を持たない）。
 */
export function retentionStep(state: State, input: Input): Step | null {
  const o = state.overlay;
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type === 'retention.written') return { state: { ...state, overlay: o.kind === 'retention' ? { kind: 'none' } : o }, effects: [] };
    if (o.kind !== 'retention') return null;
    if (e.type === 'retention.conflict') return { state: { ...state, overlay: { ...o, reloaded: true, writing: false, previewError: null } }, effects: [{ kind: 'api.retentionPreview', days: o.days }] };
    // 下見を断られたら、理由をダイアログに残す。トーストだと、ダイアログが読み込み中のまま止まって見える。
    // 別の日数の下見の失敗は、いま開いている確認のものではないので書かない。
    if (e.type === 'retention.previewFailed') return e.days === o.days ? { state: { ...state, overlay: { ...o, previewError: e.message } }, effects: [] } : { state, effects: [] };
    if (e.type === 'retention.failed') return { state: { ...state, overlay: { ...o, writing: false } }, effects: [{ kind: 'toast', level: 'error', message: e.message }] };
    return null;
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'retention.edit': return { state: { ...state, overlay: { kind: 'retention', days: i.days, from: i.from, reloaded: false, writing: false, previewError: null } }, effects: [{ kind: 'api.retentionPreview', days: i.days }] };
    // 書き込んでいる間は閉じさせない。閉じても書き込みは止まらず、結果だけが見えなくなる。
    case 'overlay.close': return o.kind === 'retention' && o.writing ? { state, effects: [] } : null;
    case 'retention.write':
      if (o.kind !== 'retention' || o.writing) return { state, effects: [] };
      return { state: { ...state, overlay: { ...o, writing: true } }, effects: [{ kind: 'api.writeRetention', days: o.days }] };
    case 'retention.settings': return { state: { ...state, overlay: { kind: 'none' } }, effects: [{ kind: 'navigate', route: { name: 'settings' } }] };
    default: return null;
  }
}
