/**
 * アプリのキーの表。
 * 照合もヘルプの表示もこの 1 つの配列から引くので、覚え書きと実装がずれない。
 * 一覧の中の j や k のように、画面の中の部品が自分で処理するものは打鍵を持たない行として並べる。
 */

export type KeyId =
  | 'palette.open' | 'session.new' | 'session.newScratch' | 'settings.open' | 'shortcuts.open' | 'sidebar.toggle'
  | 'nav.back' | 'nav.forward' | 'search.focus' | 'overlay.close'
  | 'tab.select' | 'tab.close' | 'split.toggle' | 'transcript.toggle'
  | 'list.move' | 'list.open' | 'list.terminal' | 'list.editor' | 'list.memo';

export type KeyGroup = 'global' | 'session' | 'list';

/**
 * 1 つの打鍵。
 * `mod` は ⌘ と Ctrl のどちらでもよいことを表す。対象は macOS だが、素のブラウザでは ⌘ を渡さない場面があるためである。
 * `shift` を書かない行は ⇧ の有無を問わない。`?` のように ⇧ でしか打てない文字があるからである。
 */
export type KeyChord = { key: string; mod?: boolean; ctrlAlt?: boolean; shift?: boolean };

export type KeyBinding = { id: KeyId; group: KeyGroup; keys: string; label: string; chords: KeyChord[] };

/** 照合に使う打鍵の形。KeyboardEvent をそのまま渡せる。 */
export type KeyEventLike = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export const KEYMAP: KeyBinding[] = [
  { id: 'palette.open', group: 'global', keys: '⌘K', label: 'コマンドパレット', chords: [{ key: 'k', mod: true, shift: false }] },
  { id: 'session.new', group: 'global', keys: '⌘N', label: '新規セッション', chords: [{ key: 'n', mod: true, shift: false }] },
  { id: 'session.newScratch', group: 'global', keys: '⌘⇧N', label: 'スクラッチで始める', chords: [{ key: 'n', mod: true, shift: true }] },
  { id: 'settings.open', group: 'global', keys: '⌘,', label: '設定', chords: [{ key: ',', mod: true, shift: false }] },
  { id: 'nav.back', group: 'global', keys: '⌘[ / ⌘←', label: '戻る', chords: [{ key: '[', mod: true, shift: false }, { key: 'ArrowLeft', mod: true, shift: false }] },
  { id: 'nav.forward', group: 'global', keys: '⌘] / ⌘→', label: '進む', chords: [{ key: ']', mod: true, shift: false }, { key: 'ArrowRight', mod: true, shift: false }] },
  { id: 'sidebar.toggle', group: 'global', keys: '⌘B', label: 'サイドバーの開閉', chords: [{ key: 'b', mod: true, shift: false }] },
  { id: 'search.focus', group: 'global', keys: '/', label: '検索欄へ', chords: [{ key: '/', shift: false }] },
  { id: 'shortcuts.open', group: 'global', keys: '? / ⌘/', label: 'キーの一覧', chords: [{ key: '?' }, { key: '/', mod: true }] },
  { id: 'overlay.close', group: 'global', keys: 'Esc', label: '開いているものを閉じる', chords: [{ key: 'Escape' }] },
  { id: 'tab.select', group: 'session', keys: '⌘1–⌘9', label: 'タブを選ぶ（⌃⌥1–⌃⌥9 でも）', chords: [...digits.map((d) => ({ key: d, mod: true, shift: false })), ...digits.map((d) => ({ key: d, ctrlAlt: true }))] },
  { id: 'tab.close', group: 'session', keys: '⌘W', label: 'シェルタブを閉じる', chords: [{ key: 'w', mod: true, shift: false }] },
  { id: 'split.toggle', group: 'session', keys: '⌘\\', label: 'タブを横に並べる', chords: [{ key: '\\', mod: true, shift: false }] },
  { id: 'transcript.toggle', group: 'session', keys: '⌘J', label: 'トランスクリプトの開閉', chords: [{ key: 'j', mod: true, shift: false }] },
  { id: 'list.move', group: 'list', keys: 'j / k / ↑ / ↓', label: '下へ / 上へ', chords: [] },
  { id: 'list.open', group: 'list', keys: 'Enter', label: '開く', chords: [] },
  { id: 'list.terminal', group: 'list', keys: 'o', label: 'ターミナルで開く', chords: [] },
  { id: 'list.editor', group: 'list', keys: 'e', label: 'エディタで開く', chords: [] },
  { id: 'list.memo', group: 'list', keys: 'm', label: 'メモを書く', chords: [] },
];

export const GROUP_LABEL: Record<KeyGroup, string> = { global: 'どこでも', session: 'セッション', list: '一覧' };

function hits(c: KeyChord, e: KeyEventLike): boolean {
  if (c.key.toLowerCase() !== e.key.toLowerCase()) return false;
  if (c.shift !== undefined && c.shift !== !!e.shiftKey) return false;
  // ⌃⌥ の組み合わせは、素のブラウザが ⌘1–⌘9 を渡さないときの逃げ道なので、この 1 通りだけを認める。
  if (c.ctrlAlt) return !!e.ctrlKey && !!e.altKey && !e.metaKey;
  if (c.mod) return (!!e.metaKey || !!e.ctrlKey) && !e.altKey;
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** 打鍵に当たる操作を返す。当たらなければ null。 */
export function matchKey(e: KeyEventLike): KeyId | null {
  for (const b of KEYMAP) for (const c of b.chords) if (hits(c, e)) return b.id;
  return null;
}
