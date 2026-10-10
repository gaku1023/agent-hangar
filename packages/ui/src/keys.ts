import type { MessageKey, MessageParamName } from '@agent-hangar/shared';

/** 引数を取らない文の鍵。行の説明と群の名前は、引数なしで引くのでこの形にする。 */
type PlainKey = { [K in MessageKey]: [MessageParamName<K>] extends [never] ? K : never }[MessageKey];

/**
 * アプリのキーの表。
 * 照合もヘルプの表示もこの 1 つの配列から引くので、覚え書きと実装がずれない。
 * 一覧の中の j や k のように、画面の中の部品が自分で処理するものは打鍵を持たない行として並べる。
 * 行の説明は文ではなく辞書の鍵（`shortcuts.key.*`）で持ち、見せるときに言語で引く。
 */

export type KeyId =
  | 'palette.open' | 'session.new' | 'session.newScratch' | 'session.nextWaiting' | 'settings.open' | 'shortcuts.open' | 'sidebar.toggle'
  | 'nav.back' | 'nav.forward' | 'overlay.close'
  | 'tab.select' | 'tab.close' | 'split.toggle' | 'transcript.toggle' | 'transcript.find' | 'tab.move' | 'turn.move'
  | 'terminal.fontBigger' | 'terminal.fontSmaller' | 'terminal.fontReset'
  | 'list.move' | 'list.open' | 'list.terminal' | 'list.editor' | 'list.memo' | 'list.state';

export type KeyGroup = 'global' | 'session' | 'list';

/**
 * 1 つの打鍵。
 * `mod` は ⌘ と Ctrl のどちらでもよいことを表す。対象は macOS だが、素のブラウザでは ⌘ を渡さない場面があるためである。
 * `shift` を書かない行は ⇧ の有無を問わない。`?` のように ⇧ でしか打てない文字があるからである。
 */
export type KeyChord = { key: string; mod?: boolean; ctrlAlt?: boolean; shift?: boolean };

export type KeyBinding = { id: KeyId; group: KeyGroup; keys: string; labelKey: PlainKey; chords: KeyChord[] };

/** 照合に使う打鍵の形。KeyboardEvent をそのまま渡せる。 */
export type KeyEventLike = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export const KEYMAP: KeyBinding[] = [
  // / も同じパレットを開く。ヘッダーの入口が打つ欄ではなく押す錠剤になったので、欄へ移る打鍵は無い。
  { id: 'palette.open', group: 'global', keys: '⌘K / /', labelKey: 'shortcuts.key.paletteOpen', chords: [{ key: 'k', mod: true, shift: false }, { key: '/', shift: false }] },
  { id: 'session.new', group: 'global', keys: '⌘N', labelKey: 'shortcuts.key.sessionNew', chords: [{ key: 'n', mod: true, shift: false }] },
  { id: 'session.newScratch', group: 'global', keys: '⌘⇧N', labelKey: 'shortcuts.key.sessionNewQuick', chords: [{ key: 'n', mod: true, shift: true }] },
  // ⌘I は、macOS の既定、Chrome（⌥⌘I や ⇧⌘I とは別）、Tauri の既定のメニュー、xterm、Claude Code のどれも使っていない。
  // ⌘ 付きなので、ターミナルにフォーカスがあっても Root に届く。I は「入力（input）待ち」の頭文字である。
  { id: 'session.nextWaiting', group: 'global', keys: '⌘I', labelKey: 'shortcuts.key.sessionNextWaiting', chords: [{ key: 'i', mod: true, shift: false }] },
  { id: 'settings.open', group: 'global', keys: '⌘,', labelKey: 'shortcuts.key.settingsOpen', chords: [{ key: ',', mod: true, shift: false }] },
  { id: 'nav.back', group: 'global', keys: '⌘[ / ⌘←', labelKey: 'shortcuts.key.navBack', chords: [{ key: '[', mod: true, shift: false }, { key: 'ArrowLeft', mod: true, shift: false }] },
  { id: 'nav.forward', group: 'global', keys: '⌘] / ⌘→', labelKey: 'shortcuts.key.navForward', chords: [{ key: ']', mod: true, shift: false }, { key: 'ArrowRight', mod: true, shift: false }] },
  { id: 'sidebar.toggle', group: 'global', keys: '⌘B', labelKey: 'shortcuts.key.sidebarToggle', chords: [{ key: 'b', mod: true, shift: false }] },
  { id: 'shortcuts.open', group: 'global', keys: '? / ⌘/', labelKey: 'shortcuts.key.shortcutsOpen', chords: [{ key: '?' }, { key: '/', mod: true }] },
  { id: 'overlay.close', group: 'global', keys: 'Esc', labelKey: 'shortcuts.key.overlayClose', chords: [{ key: 'Escape' }] },
  { id: 'tab.select', group: 'session', keys: '⌘1–⌘9', labelKey: 'shortcuts.key.tabSelect', chords: [...digits.map((d) => ({ key: d, mod: true, shift: false })), ...digits.map((d) => ({ key: d, ctrlAlt: true }))] },
  { id: 'tab.close', group: 'session', keys: '⌘W', labelKey: 'shortcuts.key.tabClose', chords: [{ key: 'w', mod: true, shift: false }] },
  { id: 'split.toggle', group: 'session', keys: '⌘\\', labelKey: 'shortcuts.key.splitToggle', chords: [{ key: '\\', mod: true, shift: false }] },
  { id: 'transcript.toggle', group: 'session', keys: '⌘J', labelKey: 'shortcuts.key.transcriptToggle', chords: [{ key: 'j', mod: true, shift: false }] },
  // 終わったセッションのトランスクリプトが出ているときだけ受ける。ターミナルが出ているときは奪わない（Root.tsx）。
  { id: 'transcript.find', group: 'session', keys: '⌘F', labelKey: 'shortcuts.key.transcriptFind', chords: [{ key: 'f', mod: true, shift: false }] },
  { id: 'tab.move', group: 'session', keys: '← / →', labelKey: 'shortcuts.key.tabMove', chords: [] },
  { id: 'turn.move', group: 'session', keys: 'j / k / ↑ / ↓', labelKey: 'shortcuts.key.turnMove', chords: [] },
  // US 配列の ⌘+ は ⌘⇧= なので = と + の両方で受ける。JIS 配列の + は ; のキーにあり、ブラウザと同じく ⌘; でも受ける。
  { id: 'terminal.fontBigger', group: 'session', keys: '⌘+', labelKey: 'shortcuts.key.terminalFontBigger', chords: [{ key: '+', mod: true }, { key: '=', mod: true }, { key: ';', mod: true }] },
  { id: 'terminal.fontSmaller', group: 'session', keys: '⌘−', labelKey: 'shortcuts.key.terminalFontSmaller', chords: [{ key: '-', mod: true }] },
  { id: 'terminal.fontReset', group: 'session', keys: '⌘0', labelKey: 'shortcuts.key.terminalFontReset', chords: [{ key: '0', mod: true, shift: false }] },
  { id: 'list.move', group: 'list', keys: 'j / k / ↑ / ↓', labelKey: 'shortcuts.key.listMove', chords: [] },
  { id: 'list.open', group: 'list', keys: 'Enter', labelKey: 'shortcuts.key.listOpen', chords: [] },
  { id: 'list.terminal', group: 'list', keys: 'o', labelKey: 'shortcuts.key.listTerminal', chords: [] },
  { id: 'list.editor', group: 'list', keys: 'e', labelKey: 'shortcuts.key.listEditor', chords: [] },
  { id: 'list.memo', group: 'list', keys: 'm', labelKey: 'shortcuts.key.listNote', chords: [] },
  { id: 'list.state', group: 'list', keys: '.', labelKey: 'shortcuts.key.listStatus', chords: [] },
];

export const GROUP_KEY: Record<KeyGroup, PlainKey> = { global: 'shortcuts.group.global', session: 'shortcuts.group.session', list: 'shortcuts.group.list' };

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
