import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const base = fs.readFileSync(new URL('./base.css', import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** 入れ子の無い規則を、選択子と中身の組で取り出す。@supports の中の規則も、内側の規則として拾える。 */
const rules = [...strip(base).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
const body = (selector: string) => rules.filter((r) => r.selector === selector).map((r) => r.body).join(';');

// 新規セッションの詳細を開くと、ダイアログが窓の下へはみ出し、起動のボタンに届かなかった。
describe('ダイアログの高さ', () => {
  it('器は窓の高さから上下の余白を引いた分までで、溢れた中身は器の中でスクロールする', () => {
    const dialog = body('.dialog');
    expect(dialog).toContain('max-height: calc(100vh - 48px);');
    expect(dialog).toContain('overflow-y: auto;');
  });
  // 縮められると、入力欄やテキストエリアが潰れて、器ではなく段の中でスクロールしてしまう。
  it('器の中の段は縮めない', () => {
    expect(body('.dialog > *')).toContain('flex-shrink: 0;');
  });
  it('ボタンの段は下端に貼り付き、下の余白は段が持つ', () => {
    const foot = body('.dialog-foot');
    expect(foot).toContain('position: sticky;');
    expect(foot).toContain('bottom: 0;');
    expect(foot).toContain('padding: var(--dialog-gap) var(--dialog-pad) var(--dialog-pad);');
    expect(body('.dialog:has(> .dialog-foot)')).toContain('padding-bottom: 0;');
  });
  // 地を塗ったままだと、スクロールしないダイアログでもガラスの上に白い帯が浮く。
  it('段の地は、中身がその下をくぐるときだけ塗る', () => {
    expect(body('.dialog')).toContain('scroll-timeline: --dialog-scroll block;');
    // @supports の中の規則を除いた、最初の規則だけを見る。
    const foot = rules.find((r) => r.selector === '.dialog-foot')!.body;
    expect(foot).not.toMatch(/(^|;)\s*background:/);
    expect(foot).toContain('animation-timeline: --dialog-scroll;');
    expect(strip(base)).toMatch(/@keyframes dialog-foot-cover \{ from, to \{ background: var\(--surface\);/);
    expect(strip(base)).toMatch(/@supports not \(animation-timeline: scroll\(\)\) \{ \.dialog-foot \{ background: var\(--surface\);/);
  });
});
