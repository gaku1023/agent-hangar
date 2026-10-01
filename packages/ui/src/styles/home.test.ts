import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./home.css', import.meta.url), 'utf8');

describe('ホームの細部（試作 home-lists）', () => {
  it('何も動いていないときの 1 行は高さ 44px で、ボタンを右へ寄せる（F1）', () => {
    expect(css).toMatch(/\.idle-line \{[^}]*height: 44px;/);
    expect(css).toMatch(/\.idle-text \{[^}]*flex: 1;/);
  });
  it('「すべて見る」は見出しの行の右端に置く（H1）', () => {
    expect(css).toMatch(/\.home-head \{[^}]*display: flex;/);
    expect(css).toMatch(/\.home-more \{[^}]*margin-left: auto;/);
  });
  it('見出しの行の中の見出しは、行のほうの余白だけを使う', () => {
    expect(css).toMatch(/\.home-head \.home-label \{[^}]*margin: 0;/);
  });
  it('確かめるのまとめの行は候補の色の文字で、押せる行にする（E1）', () => {
    expect(css).toMatch(/\.more-line \{[^}]*color: var\(--cand\);[^}]*cursor: pointer;/);
  });
  it('今日戻るの札は戻る日の黄土で塗り、提案の札は候補の色の枠だけにする（C1 と Q3）', () => {
    expect(css).toMatch(/\.return-when \{[^}]*color: var\(--surface\);[^}]*background: var\(--st-paused\);/);
    expect(css).toMatch(/\.home-cand \{[^}]*color: var\(--cand\);[^}]*box-shadow: inset 0 0 0 1px var\(--cand\);/);
  });
});
