import type { Store } from '../store/store.ts';
import { screenStep } from './screen.ts';
import type { Input, State, Step } from './types.ts';

/** 未検証の Codex の版の札を閉じた版を残す localStorage の鍵。端末ごとで、同期しない（opencode の札と同じ扱い）。 */
export const CODEX_VERSION_SEEN_KEY = 'codex.versionSeen';

/** 保存してあった版を読む。文字列でないもの（未保存、手で書き換えられた）は、まだ知らせていないことにする。 */
export function readCodexVersionSeen(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * codexVersion 領域：未検証の Codex の版の右下の札（C4）。決まりは opencode の札（mediator/opencodeVersion.ts）と同じ。
 * 「このまま続行」と閉じるは、その版を知らせ終えたことにするだけである。
 * 「設定を開く」も知らせ終えたことにし、設定の Codex の面へ移る（版の行が同じ注意を残している）。
 */
export function codexVersionStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind !== 'action') return null;
  const a = input.action;
  if (a.type !== 'codex.version.continue' && a.type !== 'codex.version.settings') return null;
  const seen: Step = { state: { ...state, codexVersionSeen: a.version }, effects: [{ kind: 'storage.save', key: CODEX_VERSION_SEEN_KEY, value: a.version }] };
  if (a.type === 'codex.version.continue') return seen;
  const moved = screenStep(seen.state, store, { kind: 'action', action: { type: 'nav.go', to: { name: 'settings', at: 'codex' } } });
  return moved ? { state: moved.state, effects: [...seen.effects, ...moved.effects] } : seen;
}
