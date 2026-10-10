import type { MessageKey, MessageParamName, Translate } from '@agent-hangar/shared';

/** 引数を取らない文の鍵。行の説明と群の名前は、引数なしで引くのでこの形にする。 */
type PlainKey = { [K in MessageKey]: [MessageParamName<K>] extends [never] ? K : never }[MessageKey];
/** 打鍵（keys）だけを引数に取る文の鍵。説明の中に別の打鍵を添える行が使う。 */
type KeysKey = { [K in MessageKey]: [MessageParamName<K>] extends ['keys'] ? K : never }[MessageKey];

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
 * `mod` は ⌘ と Ctrl のどちらでもよいことを表す。macOS では素のブラウザが ⌘ を渡さない場面があり、Windows と Linux では Ctrl が ⌘ の役をするためである。
 * `shift` を書かない行は ⇧ の有無を問わない。`?` のように ⇧ でしか打てない文字があるからである。
 */
export type KeyChord = { key: string; mod?: boolean; ctrlAlt?: boolean; shift?: boolean };

/**
 * 表の 1 行。also は説明に添える別の打鍵（⌃⌥1–⌃⌥9）で、あれば labelKey は打鍵を引数に取る文になる。
 * 打鍵の表示は keys も also も macOS の記号で書き、見せるときに keyLabel で OS の書き方にする。
 */
export type KeyBinding = { id: KeyId; group: KeyGroup; keys: string; chords: KeyChord[] } & ({ labelKey: PlainKey; also?: undefined } | { labelKey: KeysKey; also: string });

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
  { id: 'tab.select', group: 'session', keys: '⌘1–⌘9', labelKey: 'shortcuts.key.tabSelect', also: '⌃⌥1–⌃⌥9', chords: [...digits.map((d) => ({ key: d, mod: true, shift: false })), ...digits.map((d) => ({ key: d, ctrlAlt: true }))] },
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

/**
 * 画面を開いている PC の OS（Node の process.platform の値）。
 * hangar の画面は、サーバと同じ PC のブラウザか WebView で開くので、ブラウザの名乗りから読む。
 * 名乗りに Windows があれば win32、Macintosh か Mac OS X があるか名乗りが無ければ darwin、ほか（ブラウザで開いた Linux など）は linux とする。
 * 打鍵と表示（⌘ か Ctrl か）、tmux の入れ方、通知の案内は、どれもこの 1 つの判定から決める。
 */
export function clientPlatform(userAgent: string | undefined = globalThis.navigator?.userAgent): 'darwin' | 'win32' | 'linux' {
  if (userAgent === undefined) return 'darwin';
  if (/Windows/.test(userAgent)) return 'win32';
  return /Macintosh|Mac OS X/.test(userAgent) ? 'darwin' : 'linux';
}

/** 画面を開いている PC が macOS か。clientPlatform と同じ判定である。 */
export function isMacClient(userAgent: string | undefined = globalThis.navigator?.userAgent): boolean {
  return clientPlatform(userAgent) === 'darwin';
}

/** macOS の外での、記号の読み替え。修飾は「名前+」にして、次のキーへつなぐ。 */
const NAMED: Record<string, string> = { '⌘': 'Ctrl+', '⌃': 'Ctrl+', '⌥': 'Alt+', '⇧': 'Shift+', '↵': 'Enter', '⏎': 'Enter' };

/**
 * 表と画面に書くキーを、画面を開いている OS の書き方にする。
 * 表と辞書は macOS の記号で書き（⌘K、⌘⇧N、⌃⌥1）、Windows と Linux ではここで Ctrl+K、Ctrl+Shift+N、Ctrl+Alt+1 にする。
 * 照合は `mod` が ⌘ と Ctrl の両方で受けるので、見せ方だけを変える。
 */
export function keyLabel(text: string, mac: boolean = isMacClient()): string {
  return mac ? text : text.replace(/[⌘⌃⌥⇧↵⏎]/g, (c) => NAMED[c]!);
}

/** 行の説明。添える打鍵も OS の書き方にする。 */
export function bindingLabel(t: Translate, b: KeyBinding, mac: boolean = isMacClient()): string {
  return b.also === undefined ? t(b.labelKey) : t(b.labelKey, { keys: keyLabel(b.also, mac) });
}

/** 打鍵に当たる操作を返す。当たらなければ null。 */
export function matchKey(e: KeyEventLike): KeyId | null {
  for (const b of KEYMAP) for (const c of b.chords) if (hits(c, e)) return b.id;
  return null;
}
