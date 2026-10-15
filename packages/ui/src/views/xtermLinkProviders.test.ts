import { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { describe, expect, it } from 'vitest';
import { linkProvidersOf } from '../runtime/terminalLinks.ts';

// runtime/xterm.ts は xterm の内側の提供元の一覧（OSC 8 の組み込みの分）を包む。
// xterm を上げて置き場が変わったら、ここで落として知らせる（落ちても動きは xterm の既定の飾りに戻るだけ）。
// 本物の xterm は DOM が要るので、jsdom で走る views の下に置く。
describe('xterm のリンクの提供元', () => {
  it('作った直後に OSC 8 の組み込みの提供元があり、web-links を足すと 1 つ増える', () => {
    const term = new Terminal({ allowProposedApi: true });
    const list = linkProvidersOf(term);
    expect(list).not.toBeNull();
    const before = list!.length;
    expect(before).toBeGreaterThanOrEqual(1);
    term.loadAddon(new WebLinksAddon(() => {}));
    expect(linkProvidersOf(term)!.length).toBe(before + 1);
    term.dispose();
  });
});
