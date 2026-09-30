import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const base = fs.readFileSync(new URL('./base.css', import.meta.url), 'utf8');
const palette = fs.readFileSync(new URL('./palette.css', import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** 入れ子の無い規則を、選択子と中身の組で取り出す。@supports の中の規則も、内側の規則として拾える。 */
const rulesOf = (css: string) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
const rules = rulesOf(base);
const body = (selector: string) => rules.filter((r) => r.selector === selector).map((r) => r.body).join(';');

// 新規セッションの詳細を開くと、ダイアログが窓の下へはみ出し、起動のボタンに届かなかった。
// 殻（views/primitives/Dialog.tsx）は見出しと下端を固定し、中身だけをスクロールする（A1）。
describe('ダイアログの殻の高さ', () => {
  it('器は窓の高さから上下 32px ずつを引いた分までで、器そのものはスクロールしない', () => {
    const dialog = body('.dialog');
    expect(dialog).toContain('max-height: calc(100vh - 64px);');
    expect(dialog).toContain('overflow: hidden;');
    expect(dialog).toContain('display: flex;');
    expect(dialog).toContain('flex-direction: column;');
    expect(dialog).toContain('padding: 0;');
  });
  it('見出しと下端は縮まず、中身だけが縮んでスクロールする', () => {
    expect(body('.dialog-head')).toContain('flex: none;');
    expect(body('.dialog-foot')).toContain('flex: none;');
    const b = body('.dialog-body');
    expect(b).toContain('flex: 1 1 auto;');
    expect(b).toContain('min-height: 0;');
    expect(b).toContain('overflow-y: auto;');
    expect(b).toContain('overscroll-behavior: contain;');
  });
  // 縮められると、入力欄やテキストエリアが潰れて、中身ではなく段の中でスクロールしてしまう。
  it('中身の段は縮めない', () => {
    expect(body('.dialog-body > *')).toContain('flex-shrink: 0;');
  });
  it('中身が見出しの下をくぐると見出しの下に、続きがあると下端の上に影を出す', () => {
    expect(body(".dialog[data-top='true'] .dialog-head")).toMatch(/box-shadow: 0 8px/);
    expect(body(".dialog[data-bottom='true'] .dialog-foot")).toMatch(/box-shadow: 0 -8px/);
  });
  // 前の作り（器ごとスクロールし、下端を sticky で貼り付ける）は残さない。
  it('器のスクロールの進みで塗る前の作りは残さない', () => {
    expect(strip(base)).not.toContain('--dialog-scroll');
    expect(strip(base)).not.toContain('dialog-foot-cover');
    expect(body('.dialog-foot')).not.toContain('position: sticky;');
  });
  // パレットも .dialog の器を使うので、入力欄が縮まないよう自分で止める。
  it('パレットの入力欄は縮まない', () => {
    expect(rulesOf(palette).find((r) => r.selector === '.palette-input')?.body).toContain('flex: none;');
  });
});

describe('危険な操作の確認（E1）', () => {
  it('赤い丸のアイコンを見出しの前に置き、中身は見出しの文の頭にそろえる', () => {
    expect(body('.dialog-disc')).toContain('border-radius: 50%;');
    expect(body('.dialog-disc')).toContain('color: var(--error);');
    expect(body('.dialog-danger .dialog-body')).toMatch(/padding-left:/);
  });
});

describe('新しいセッションのダイアログ', () => {
  it('起動ボタンの中のキー帽は、主ボタンの地の上で読める淡い白にする（B1）', () => {
    expect(body('.btn .kc')).toContain('background: rgba(255, 255, 255, 0.22);');
  });
  it('下書きの札は Paused の色を借りる（C1）', () => {
    expect(body('.draft-tag')).toContain('color: var(--st-paused);');
    expect(body('.draft-tag')).toContain('background: var(--st-paused-soft);');
  });
  it('前回と同じの札は候補の色を借りる（D1）', () => {
    expect(body('.prev-tag')).toContain('color: var(--cand);');
    expect(body('.prev-tag')).toContain('background: var(--cand-soft);');
  });
});
