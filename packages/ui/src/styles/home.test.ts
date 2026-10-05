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
    // 戻る時点を過ぎたものだけを塗る。当日の時刻の前のものは、枠と黄土の文字だけにする。
    expect(css).toMatch(/\.return-when\[data-due='true'\] \{[^}]*color: var\(--surface\);[^}]*background: var\(--st-paused\);/);
    expect(css).toMatch(/\.return-when \{[^}]*color: var\(--st-paused\);[^}]*box-shadow: inset 0 0 0 1px var\(--st-paused\);/);
    expect(css).toMatch(/\.home-cand \{[^}]*color: var\(--cand\);[^}]*box-shadow: inset 0 0 0 1px var\(--cand\);/);
  });
  it('1 列に置く。実行中の札は件数ぶんの列で幅を使い切り、最近は残りの高さを受け取って 5 行を下限にする', () => {
    expect(css).not.toMatch(/\.home-two/);
    expect(css).toMatch(/\.live-grid \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(340px, 1fr\)\);/);
    expect(css).toMatch(/\.home-recent \{[^}]*flex: 1 1 auto;/);
    expect(css).toMatch(/\.home-fit \{[^}]*flex: 1 1 0;[^}]*min-height: calc\(var\(--session-row-h\) \* 5\);/);
  });
  it('今日戻るの札は 1 行にし、溢れたら理由から切る', () => {
    expect(css).toMatch(/\.return-card \{[^}]*height: 40px;/);
    expect(css).toMatch(/\.return-card \.ask-q \{[^}]*flex: 1 1 0;/);
    expect(css).toMatch(/\.return-proj \{[^}]*flex: none;/);
  });
  it('プロジェクトの 1 行は折り返した分を切り取って隠す', () => {
    expect(css).toMatch(/\.home-pj-items \{[^}]*flex-wrap: wrap;[^}]*height: 24px;[^}]*overflow: hidden;/);
  });
});
