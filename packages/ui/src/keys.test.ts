import { describe, expect, it } from 'vitest';
import { translator } from '@agent-hangar/shared';
import { bindingLabel, clientPlatform, isMacClient, keyLabel, KEYMAP, matchKey } from './keys.ts';
import { LINUX_UA, MAC_UA, setClientUserAgent, WINDOWS_UA } from './test/client.ts';

const ja = translator('ja');
const en = translator('en');
/** 行の説明を日本語で引く。 */
const labelOf = (id: string) => {
  const b = KEYMAP.find((k) => k.id === id);
  return b ? bindingLabel(ja, b) : undefined;
};

describe('キーマップ', () => {
  it('⌘ でも Ctrl でも同じ操作に当たる', () => {
    expect(matchKey({ key: 'b', metaKey: true })).toBe('sidebar.toggle');
    expect(matchKey({ key: 'B', metaKey: true, shiftKey: true })).toBeNull();
    expect(matchKey({ key: 'k', metaKey: true })).toBe('palette.open');
    expect(matchKey({ key: 'k', ctrlKey: true })).toBe('palette.open');
    expect(matchKey({ key: '\\', ctrlKey: true })).toBe('split.toggle');
    expect(matchKey({ key: 'j', ctrlKey: true })).toBe('transcript.toggle');
  });

  it('⌘F はトランスクリプト内を検索する。一覧に「トランスクリプト内を検索」として出る', () => {
    expect(matchKey({ key: 'f', metaKey: true })).toBe('transcript.find');
    expect(matchKey({ key: 'f', ctrlKey: true })).toBe('transcript.find');
    expect(matchKey({ key: 'f' })).toBeNull();
    expect(KEYMAP.find((b) => b.id === 'transcript.find')).toMatchObject({ group: 'session', keys: '⌘F' });
    expect(labelOf('transcript.find')).toBe('トランスクリプト内を検索');
  });

  it('⇧ の有無で新規とスクラッチを分ける', () => {
    expect(matchKey({ key: 'n', metaKey: true })).toBe('session.new');
    expect(matchKey({ key: 'N', metaKey: true, shiftKey: true })).toBe('session.newScratch');
  });

  it('⌘W の説明は、閉じるのがフォーカスのある枠のシェルタブだけだと書く', () => {
    expect(labelOf('tab.close')).toBe('フォーカスのある枠のシェルタブを閉じる');
  });

  it('文字キーは大小を問わない', () => {
    expect(matchKey({ key: 'W', metaKey: true })).toBe('tab.close');
  });

  it('タブの選択は ⌘1–9 と ⌃⌥1–9 の両方で当たる', () => {
    expect(matchKey({ key: '3', metaKey: true })).toBe('tab.select');
    expect(matchKey({ key: '3', ctrlKey: true, altKey: true })).toBe('tab.select');
    expect(matchKey({ key: '0', metaKey: true })).not.toBe('tab.select');
  });

  it('⌘+ ⌘− ⌘0 で端末の文字の大きさを変える', () => {
    // US 配列の ⌘+ は ⌘⇧= なので、⇧ の有無を問わず = と + の両方で当たる。
    expect(matchKey({ key: '=', metaKey: true })).toBe('terminal.fontBigger');
    expect(matchKey({ key: '+', metaKey: true, shiftKey: true })).toBe('terminal.fontBigger');
    // JIS 配列の + は ; のキーの ⇧ にある。ブラウザと同じく ⇧ 無しの ⌘; でも大きくする。
    expect(matchKey({ key: ';', metaKey: true })).toBe('terminal.fontBigger');
    expect(matchKey({ key: '-', metaKey: true })).toBe('terminal.fontSmaller');
    expect(matchKey({ key: '0', metaKey: true })).toBe('terminal.fontReset');
    expect(matchKey({ key: '0', ctrlKey: true })).toBe('terminal.fontReset');
    // 修飾の無い - や 0 は文字である。
    expect(matchKey({ key: '-' })).toBeNull();
    expect(matchKey({ key: '0' })).toBeNull();
  });

  it('戻ると進むは括弧でも矢印でも当たる', () => {
    expect(matchKey({ key: '[', metaKey: true })).toBe('nav.back');
    expect(matchKey({ key: 'ArrowLeft', metaKey: true })).toBe('nav.back');
    expect(matchKey({ key: ']', metaKey: true })).toBe('nav.forward');
    expect(matchKey({ key: 'ArrowRight', metaKey: true })).toBe('nav.forward');
  });

  it('? と ⌘/ でキーの一覧、/ でパレット', () => {
    expect(matchKey({ key: '?', shiftKey: true })).toBe('shortcuts.open');
    expect(matchKey({ key: '/', metaKey: true })).toBe('shortcuts.open');
    expect(matchKey({ key: '/' })).toBe('palette.open');
  });

  it('修飾の無い文字キーは一覧の中の操作なので、ここでは当たらない', () => {
    expect(matchKey({ key: 'j' })).toBeNull();
    expect(matchKey({ key: 'm' })).toBeNull();
  });

  it('⌥ の付いた組み合わせは、⌃⌥ のタブ切替を除いて当たらない', () => {
    expect(matchKey({ key: 'k', metaKey: true, altKey: true })).toBeNull();
  });

  it('同じ打鍵を 2 つの操作に割り当てていない', () => {
    const seen = new Map<string, string>();
    for (const b of KEYMAP) {
      for (const c of b.chords) {
        const sig = `${c.key.toLowerCase()}|${c.mod ? 'mod' : ''}${c.ctrlAlt ? 'ctrlAlt' : ''}|${c.shift ?? 'any'}`;
        expect(seen.get(sig), `${sig} が ${seen.get(sig)} と ${b.id} で重なっている`).toBeUndefined();
        seen.set(sig, b.id);
      }
    }
  });

  it('一覧の上下は矢印でも動くことを一覧に書く', () => {
    expect(KEYMAP.find((b) => b.id === 'list.move')?.keys).toBe('j / k / ↑ / ↓');
    expect(KEYMAP.find((b) => b.id === 'list.state')?.keys).toBe('.');
  });

  it('タブの列とターンの目次の矢印も、セッションの節に載せる', () => {
    const session = KEYMAP.filter((b) => b.group === 'session').map((b) => b.keys);
    expect(session).toContain('← / →');
    expect(session).toContain('j / k / ↑ / ↓');
  });

  it('⌘I で次の入力待ちへ。Ctrl+I でも当たる', () => {
    expect(matchKey({ key: 'i', metaKey: true })).toBe('session.nextWaiting');
    expect(matchKey({ key: 'i', ctrlKey: true })).toBe('session.nextWaiting');
    expect(matchKey({ key: 'I', metaKey: true, shiftKey: true })).toBeNull();
    expect(matchKey({ key: 'i' })).toBeNull();
    expect(KEYMAP.find((b) => b.id === 'session.nextWaiting')).toMatchObject({ group: 'global', keys: '⌘I' });
    expect(labelOf('session.nextWaiting')).toBe('次の入力待ちへ');
  });

  it('どの行にも表示するキーと説明がある', () => {
    for (const b of KEYMAP) {
      expect(b.keys, b.id).not.toBe('');
      // 日本語と英語の両方に説明があり、鍵のまま返ってはいない。
      expect(bindingLabel(ja, b), b.id).not.toBe(b.labelKey);
      expect(bindingLabel(en, b), b.id).not.toBe(b.labelKey);
      // 引数の置き場が残っていない。
      expect(bindingLabel(ja, b), b.id).not.toContain('{');
    }
  });
});

describe('画面を開いている OS', () => {
  it('ブラウザの名乗りから macOS かを読む。名乗りが無ければ macOS とみなす', () => {
    expect(isMacClient(MAC_UA)).toBe(true);
    expect(isMacClient(WINDOWS_UA)).toBe(false);
    expect(isMacClient(LINUX_UA)).toBe(false);
    expect(isMacClient(undefined)).toBe(true);
  });

  it('macOS かどうかは、画面の OS（clientPlatform）と同じ判定から決める', () => {
    for (const ua of [MAC_UA, WINDOWS_UA, LINUX_UA, undefined]) expect(isMacClient(ua)).toBe(clientPlatform(ua) === 'darwin');
    expect(clientPlatform(LINUX_UA)).toBe('linux');
  });

  it('引数を省くと、いまの名乗りを読む', () => {
    expect(isMacClient()).toBe(true);
    setClientUserAgent(WINDOWS_UA);
    expect(isMacClient()).toBe(false);
  });
});

describe('キーの表示', () => {
  it('macOS では記号のまま見せる', () => {
    for (const b of KEYMAP) expect(keyLabel(b.keys, true)).toBe(b.keys);
    expect(keyLabel('⌘↵', true)).toBe('⌘↵');
  });

  it('Windows と Linux では、⌘ を Ctrl に、記号を名前に読み替える', () => {
    expect(keyLabel('⌘K / /', false)).toBe('Ctrl+K / /');
    expect(keyLabel('⌘⇧N', false)).toBe('Ctrl+Shift+N');
    expect(keyLabel('⌘1–⌘9', false)).toBe('Ctrl+1–Ctrl+9');
    expect(keyLabel('⌘[ / ⌘←', false)).toBe('Ctrl+[ / Ctrl+←');
    expect(keyLabel('? / ⌘/', false)).toBe('? / Ctrl+/');
    expect(keyLabel('⌃⌥1–⌃⌥9', false)).toBe('Ctrl+Alt+1–Ctrl+Alt+9');
    expect(keyLabel('⌘↵', false)).toBe('Ctrl+Enter');
    expect(keyLabel('⇧⏎', false)).toBe('Shift+Enter');
    expect(keyLabel('⌥↑', false)).toBe('Alt+↑');
    expect(keyLabel('Esc', false)).toBe('Esc');
    // 修飾を持たない一覧のキーは変わらない。
    expect(keyLabel('j / k / ↑ / ↓', false)).toBe('j / k / ↑ / ↓');
  });

  it('OS を省くと、いまの名乗りで決める', () => {
    expect(keyLabel('⌘B')).toBe('⌘B');
    setClientUserAgent(WINDOWS_UA);
    expect(keyLabel('⌘B')).toBe('Ctrl+B');
  });

  it('表のどの行も、Windows では ⌘ と記号を残さない', () => {
    for (const b of KEYMAP) expect(keyLabel(b.keys, false), b.id).not.toMatch(/[⌘⌃⌥⇧↵⏎]/);
    for (const b of KEYMAP) expect(bindingLabel(ja, b, false), b.id).not.toMatch(/[⌘⌃⌥⇧↵⏎]/);
  });

  it('タブの選択の説明に添える打鍵も、OS の書き方にする', () => {
    const b = KEYMAP.find((k) => k.id === 'tab.select')!;
    expect(bindingLabel(ja, b, true)).toBe('タブを選択（⌃⌥1–⌃⌥9 でも）');
    expect(bindingLabel(ja, b, false)).toBe('タブを選択（Ctrl+Alt+1–Ctrl+Alt+9 でも）');
    expect(bindingLabel(en, b, false)).toBe('Select tab (also Ctrl+Alt+1–Ctrl+Alt+9)');
  });
});
