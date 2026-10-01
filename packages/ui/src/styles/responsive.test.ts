import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// 窓の大きさによらず崩れないための規則。WebKit で 900×600 から 1920×1080 まで測って見つけた崩れを、ここで止める。
const read = (f: string) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const body = (css: string, selector: string) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1]!.trim() === selector)?.[2] ?? '';
const base = read('base.css');

describe('ボタン', () => {
  it('ボタンの文字は折り返さず、箱の幅を超えない', () => {
    // 高さの決まったボタンで折り返すと、2 行目が箱の外へはみ出す（サブエージェントを見るボタンで起きた）。
    const b = body(base, '.btn');
    expect(b).toMatch(/white-space: nowrap;/);
    expect(b).toMatch(/max-width: 100%;/);
  });
  it('長い名前は .btn-label の中で省略する', () => {
    const b = body(base, '.btn > .btn-label');
    expect(b).toMatch(/min-width: 0;/);
    expect(b).toMatch(/text-overflow: ellipsis;/);
  });
  it('見出しの行が縮められたら、名前を隠して印だけの丸いボタンにする', () => {
    expect(body(base, '.page-title-row[data-compact] .btn-label')).toMatch(/clip-path: inset\(50%\);/);
    expect(body(base, '.page-title-row[data-compact] .btn:has(> .btn-label)')).toMatch(/width: var\(--row-h\);/);
  });
});

describe('広い窓', () => {
  it('セッション画面だけは幅の上限を外す', () => {
    // 外す画面は presenters/shell.ts の wide が決め、Shell が data-wide を付ける。
    expect(body(read('session.css'), '.shell[data-wide]')).toMatch(/--main-w: 100vw;/);
  });
});

describe('一覧と絞り込み', () => {
  it('プロジェクトのカードは、幅に合わせて列の数を変える', () => {
    expect(body(base, '.cards')).toMatch(/repeat\(auto-fill, minmax\(\d+px, 1fr\)\)/);
  });
  it('セッションの絞り込みは、入り切らなければ次の行へ送る', () => {
    expect(body(read('rows.css'), '.sessions-filters')).toMatch(/flex-wrap: wrap;/);
  });
  it('一覧の画面も、一覧が窓の下端までの残りを受け取る', () => {
    expect(body(base, '.screen-fill > .rows-host, .project-main > .rows-host')).toMatch(/flex: 1 1 0;/);
    expect(body(base, '.rows-host > .list > .list-scroll')).toMatch(/flex: 1;/);
  });
  it('プロジェクトの右の欄は、窓が狭いときに細くなる', () => {
    expect(body(read('workbench.css'), '.project-screen')).toMatch(/clamp\(/);
  });
});

describe('右ペインと会話の行', () => {
  it('ツールの行の補足は縮んで、行の幅を超えない', () => {
    const t = read('transcript.css');
    expect(body(t, '.trow .meta')).toMatch(/min-width: 0;/);
    expect(body(t, '.trow .meta')).not.toMatch(/flex: none;/);
  });
  it('ツールの札も縮んで省略する', () => {
    const b = body(read('transcript.css'), '.trow .badge');
    expect(b).not.toMatch(/flex: none;/);
    expect(b).toMatch(/text-overflow: ellipsis;/);
  });
  it('窓が低いときは「いま」の上段が縮んでスクロールし、目次を押し出さない', () => {
    const b = body(base, '.live-top');
    expect(b).toMatch(/min-height: 0;/);
    expect(b).toMatch(/overflow-y: auto;/);
    expect(b).not.toMatch(/flex: none;/);
  });
});
