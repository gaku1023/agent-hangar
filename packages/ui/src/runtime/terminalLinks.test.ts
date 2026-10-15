import type { ILink, ILinkProvider } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';
import { activateLink, createLinkGate, isLinkClick, linkOpener, openableUrl } from './terminalLinks.ts';

const click = (over: Partial<MouseEvent> = {}) => ({ metaKey: false, ctrlKey: false, ...over }) as MouseEvent;

describe('ターミナルのリンク', () => {
  it('開く修飾キーは、mac では ⌘、ほかでは Ctrl', () => {
    expect(isLinkClick(click({ metaKey: true }), true)).toBe(true);
    expect(isLinkClick(click({ ctrlKey: true }), true)).toBe(false);
    expect(isLinkClick(click({ ctrlKey: true }), false)).toBe(true);
    expect(isLinkClick(click({ metaKey: true }), false)).toBe(false);
    expect(isLinkClick(click(), true)).toBe(false);
  });
  it('http と https だけを開き、file: や javascript: は開かない', () => {
    expect(openableUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(openableUrl('http://127.0.0.1:4177/x')).toBe('http://127.0.0.1:4177/x');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'hangar://session/1', 'mailto:a@b.c', 'not a url', '']) expect(openableUrl(bad)).toBeNull();
  });
  it('修飾キー付きのクリックだけで開き、素のクリックは何もしない（選択とフォーカスのまま）', () => {
    const open = vi.fn();
    expect(activateLink(click(), 'https://example.com', open, true)).toBe(false);
    expect(activateLink(click({ metaKey: true }), 'file:///etc/passwd', open, true)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(activateLink(click({ metaKey: true }), 'https://example.com', open, true)).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/');
  });
  it('デスクトップ版は殻に開かせ、ブラウザで開いた UI では新しいタブで開く', () => {
    const desktop = { openLink: vi.fn(async () => {}) };
    const win = vi.fn();
    linkOpener(desktop, win)('https://example.com/');
    expect(desktop.openLink).toHaveBeenCalledWith('https://example.com/');
    expect(win).not.toHaveBeenCalled();
    linkOpener(null, win)('https://example.com/');
    expect(win).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
  });

  describe('下線とポインタは修飾キーを押している間だけ（案 A）', () => {
    const base = (): ILink => ({ text: 'https://example.com', range: { start: { x: 1, y: 1 }, end: { x: 19, y: 1 } }, activate: vi.fn() });
    const provider = (links: ILink[]): ILinkProvider => ({ provideLinks: (_y, cb) => cb(links) });
    const provided = (p: ILinkProvider): ILink[] => { let out: ILink[] = []; p.provideLinks(1, (l) => { out = l ?? []; }); return out; };
    it('提供元を包み、押していなければ下線もポインタも出さない', () => {
      const gate = createLinkGate(true);
      const list = [provider([base()]), provider([base()])];
      gate.wrapAll(list);
      for (const p of list) expect(provided(p)[0]!.decorations).toEqual({ underline: false, pointerCursor: false });
      gate.setHeld(true);
      expect(provided(list[0]!)[0]!.decorations).toEqual({ underline: true, pointerCursor: true });
    });
    it('置いている最中に押したり離したりすると、そのリンクの飾りを切り替える', () => {
      const gate = createLinkGate(true);
      const [p] = gate.wrapAll([provider([base()])]);
      const link = provided(p!)[0]!;
      link.hover!(click(), link.text);
      gate.setHeld(true);
      expect(link.decorations).toEqual({ underline: true, pointerCursor: true });
      gate.setHeld(false);
      expect(link.decorations).toEqual({ underline: false, pointerCursor: false });
      // 離れたあとは触らない。
      link.leave!(click(), link.text);
      gate.setHeld(true);
      expect(link.decorations).toEqual({ underline: false, pointerCursor: false });
    });
    it('⌘ を押したまま入ってきたら、入ったときの押し下げで飾る', () => {
      const gate = createLinkGate(true);
      const [p] = gate.wrapAll([provider([base()])]);
      const link = provided(p!)[0]!;
      link.hover!(click({ metaKey: true }), link.text);
      expect(gate.held()).toBe(true);
      expect(link.decorations).toEqual({ underline: true, pointerCursor: true });
    });
    it('元の hover・leave・activate はそのまま呼ぶ', () => {
      const gate = createLinkGate(false);
      const orig = { ...base(), hover: vi.fn(), leave: vi.fn() };
      const [p] = gate.wrapAll([provider([orig])]);
      const link = provided(p!)[0]!;
      link.hover!(click(), 'x'); link.leave!(click(), 'x'); link.activate(click({ ctrlKey: true }), 'x');
      expect(orig.hover).toHaveBeenCalled();
      expect(orig.leave).toHaveBeenCalled();
      expect(orig.activate).toHaveBeenCalled();
    });
    it('2 度包まない', () => {
      const gate = createLinkGate(true);
      const list = [provider([base()])];
      gate.wrapAll(list);
      const once = list[0];
      gate.wrapAll(list);
      expect(list[0]).toBe(once);
    });
  });
});
