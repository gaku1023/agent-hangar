import type { Store } from '../store/store.ts';
import { screenStep } from './screen.ts';
import type { Input, State, Step } from './types.ts';

/** 未検証の opencode の版の札を閉じた版を残す localStorage の鍵。端末ごとで、同期しない（更新の札の update.dismissed と同じ扱い）。 */
export const OPENCODE_VERSION_SEEN_KEY = 'opencode.versionSeen';

/** 保存してあった版を読む。文字列でないもの（未保存、手で書き換えられた）は、まだ知らせていないことにする。 */
export function readOpencodeVersionSeen(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * opencodeVersion 領域：未検証の opencode の版の右下の札（C7、試作の N1）。
 * 札を出すかは Presenter が事実（設定、検出の答え）とここが持つ閉じた版から決める（presenters/opencodeNotice.ts）。
 * 「このまま続行」と閉じるは、その版を知らせ終えたことにするだけである。
 * 「設定を開く」も知らせ終えたことにし、設定の opencode の面へ移る（版の行が同じ注意を残している）。
 */
export function opencodeVersionStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind !== 'action') return null;
  const a = input.action;
  if (a.type !== 'opencode.version.continue' && a.type !== 'opencode.version.settings') return null;
  const seen: Step = { state: { ...state, opencodeVersionSeen: a.version }, effects: [{ kind: 'storage.save', key: OPENCODE_VERSION_SEEN_KEY, value: a.version }] };
  if (a.type === 'opencode.version.continue') return seen;
  const moved = screenStep(seen.state, store, { kind: 'action', action: { type: 'nav.go', to: { name: 'settings', at: 'opencode' } } });
  return moved ? { state: moved.state, effects: [...seen.effects, ...moved.effects] } : seen;
}
