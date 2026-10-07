import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** 入れ子の無い規則を、選択子と中身の組で取り出す。最初に見つかったもの（@media の外）を返す。 */
const body = (css: string, selector: string) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1]!.trim() === selector)?.[2] ?? '';

describe('アプリ全体の箱', () => {
  it('.shell は overflow: clip で、どのコードからもスクロールさせない', () => {
    // hidden はスクロールバーが無いだけで、scrollIntoView などからは動く。WebKit では一度ずれると手で戻せない。
    const b = body(read('base.css'), '.shell');
    expect(b).toMatch(/overflow: clip;/);
    expect(b).not.toMatch(/overflow: hidden;/);
  });
});

describe('セッション画面の高さ', () => {
  // 上の帯（見出し、札、要約、タブ）の高さは折り返しで変わる。
  // 100vh から決め打ちで引くと、帯が想定より高いぶん板の下端が窓の外へ出る（WebKit で実測 26px）。
  const css = read('base.css');
  it('.split と .tr は 100vh からの引き算で高さを決めない', () => {
    expect(body(css, '.split')).not.toMatch(/100vh/);
    expect(body(css, '.tr')).not.toMatch(/100vh/);
  });
});
