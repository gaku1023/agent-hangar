import { describe, expect, it, vi } from 'vitest';
import { openAnchorInShell } from './anchorLinks.ts';

/** 押された要素の祖先に a を持つクリック。closest だけを読む。 */
function clickOn(a: { href: string; target: string } | null, over: { button?: number; defaultPrevented?: boolean } = {}) {
  const preventDefault = vi.fn();
  const target = { closest: (sel: string) => (sel === 'a[href]' ? a : null) };
  return { e: { target, button: over.button ?? 0, defaultPrevented: over.defaultPrevented ?? false, preventDefault }, preventDefault };
}

describe('新しいタブへのリンクを殻に開かせる', () => {
  it('target="_blank" の http と https のリンクは、既定の動きを止めて殻に渡す', () => {
    const open = vi.fn();
    const { e, preventDefault } = clickOn({ href: 'https://github.com/a/b/pull/1', target: '_blank' });
    expect(openAnchorInShell(e, open)).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('https://github.com/a/b/pull/1');
  });
  it('中ボタンのクリックでも開く', () => {
    const open = vi.fn();
    const { e } = clickOn({ href: 'https://example.com/', target: '_blank' }, { button: 1 });
    expect(openAnchorInShell(e, open)).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/');
  });
  it('頁の中の移動（target の無いリンク）、http と https のほか、右ボタン、止められたクリックは触らない', () => {
    const open = vi.fn();
    const cases = [
      clickOn({ href: 'http://127.0.0.1:4177/#/settings', target: '' }),
      clickOn({ href: 'file:///etc/passwd', target: '_blank' }),
      clickOn({ href: 'javascript:alert(1)', target: '_blank' }),
      clickOn({ href: 'https://example.com/', target: '_blank' }, { button: 2 }),
      clickOn({ href: 'https://example.com/', target: '_blank' }, { defaultPrevented: true }),
      clickOn(null),
    ];
    for (const { e, preventDefault } of cases) {
      expect(openAnchorInShell(e, open)).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(open).not.toHaveBeenCalled();
  });
  it('押されたのが要素でないとき（文字の節など）は何もしない', () => {
    const open = vi.fn();
    expect(openAnchorInShell({ target: {}, button: 0, defaultPrevented: false, preventDefault: vi.fn() }, open)).toBe(false);
    expect(openAnchorInShell({ target: null, button: 0, defaultPrevented: false, preventDefault: vi.fn() }, open)).toBe(false);
  });
});

describe('hangar 自身のリンクは、アプリの中で開く', () => {
  it('会話のリンクは、target があってもなくても、既定の動きを止めて hangar に渡す（殻の外へは出さない）', () => {
    for (const target of ['_blank', '']) {
      const open = vi.fn();
      const hangar = vi.fn();
      const { e, preventDefault } = clickOn({ href: 'http://127.0.0.1:4177/#/session/s1?device=d2', target });
      expect(openAnchorInShell(e, open, hangar)).toBe(true);
      expect(preventDefault).toHaveBeenCalled();
      expect(hangar).toHaveBeenCalledWith({ kind: 'session', id: 's1', deviceId: 'd2' });
      expect(open).not.toHaveBeenCalled();
    }
  });
  it('hangar:// のプロジェクトのリンクも渡す', () => {
    const hangar = vi.fn();
    expect(openAnchorInShell(clickOn({ href: 'hangar://project/p1', target: '_blank' }).e, null, hangar)).toBe(true);
    expect(hangar).toHaveBeenCalledWith({ kind: 'project', id: 'p1' });
  });
  it('ブラウザで開いた UI（殻の open が無い）でも、hangar のリンクだけ受け、ほかの外へのリンクは触らない', () => {
    const hangar = vi.fn();
    const other = clickOn({ href: 'https://example.com/', target: '_blank' });
    expect(openAnchorInShell(other.e, null, hangar)).toBe(false);
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(hangar).not.toHaveBeenCalled();
  });
  it('右ボタンと止められたクリックは渡さない', () => {
    const hangar = vi.fn();
    expect(openAnchorInShell(clickOn({ href: 'hangar://session/s1', target: '_blank' }, { button: 2 }).e, null, hangar)).toBe(false);
    expect(openAnchorInShell(clickOn({ href: 'hangar://session/s1', target: '_blank' }, { defaultPrevented: true }).e, null, hangar)).toBe(false);
    expect(hangar).not.toHaveBeenCalled();
  });
});

