import type { Input, State, Step } from './types.ts';

/** 帯を閉じたことを残す localStorage の鍵。値は真偽値そのもの。 */
export const RETENTION_BANNER_KEY = 'retention.bannerDismissed';

/**
 * retention 領域：保持期間の帯と、書き込む前の確認。
 * 確認は開いた時点で下見を取りに行き、書き込みは送信中の間もう一度押しても重ねない。
 * 閉じる（overlay.close）は overlay 領域がまとめて扱う。
 * 書けたときのトーストは、日数の言い方を知っているランタイムが出す（Mediator は表示の言い方を持たない）。
 */
export function retentionStep(state: State, input: Input): Step | null {
  const o = state.overlay;
  if (input.kind === 'runtime') {
    const e = input.event;
    if (e.type === 'retention.written') return { state: { ...state, overlay: o.kind === 'retention' ? { kind: 'none' } : o }, effects: [] };
    if (o.kind !== 'retention') return null;
    if (e.type === 'retention.conflict') return { state: { ...state, overlay: { ...o, reloaded: true, writing: false } }, effects: [{ kind: 'api.retentionPreview', days: o.days }] };
    if (e.type === 'retention.failed') return { state: { ...state, overlay: { ...o, writing: false } }, effects: [{ kind: 'toast', level: 'error', message: e.message }] };
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'retention.dismiss': return { state: { ...state, retentionBannerDismissed: true }, effects: [{ kind: 'storage.save', key: RETENTION_BANNER_KEY, value: true }] };
    case 'retention.edit': return { state: { ...state, overlay: { kind: 'retention', days: i.days, from: i.from, reloaded: false, writing: false } }, effects: [{ kind: 'api.retentionPreview', days: i.days }] };
    case 'retention.write':
      if (o.kind !== 'retention' || o.writing) return { state, effects: [] };
      return { state: { ...state, overlay: { ...o, writing: true } }, effects: [{ kind: 'api.writeRetention', days: o.days }] };
    case 'retention.settings': return { state: { ...state, overlay: { kind: 'none' } }, effects: [{ kind: 'navigate', route: { name: 'settings' } }] };
    default: return null;
  }
}
