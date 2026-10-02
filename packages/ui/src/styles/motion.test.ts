import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const read = (f: string) => fs.readFileSync(new URL(f, dir), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const sheets = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
const tokens = read('tokens.css');
/** 宣言を（名前、値）の組で取り出す。 */
const decls = (css: string) => [...strip(css).matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)].map((m) => ({ prop: m[1]!, value: m[2]!.trim() }));
/** :root に書いたトークンの値。reduced motion の節より前にある最初の定義を読む。 */
const value = (t: string) => tokens.match(new RegExp(`${t}:\\s*([^;]+);`))?.[1]?.trim();

describe('動きのトークン', () => {
  // 性格は「なめらか」。すっと出て、長く静かに止まる（仕様の「4 動き」）。
  it('仕様の値を持つ', () => {
    expect(value('--dur-fast')).toBe('200ms');
    expect(value('--dur')).toBe('420ms');
    expect(value('--dur-exit')).toBe('250ms');
    expect(value('--ease-out')).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(value('--ease-in')).toBe('cubic-bezier(0.4, 0, 1, 1)');
    expect(value('--rise')).toBe('6px');
    expect(value('--blur-in')).toBe('6px');
    expect(value('--breathe-period')).toBe('3.2s');
  });
  it('reduced motion では、長さと移動とぼかしが 0 になる', () => {
    const block = strip(tokens).match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/)?.[1] ?? '';
    for (const t of ['--dur-fast', '--dur', '--dur-exit']) expect(block, t).toMatch(new RegExp(`${t}: 0ms;`));
    for (const t of ['--rise', '--blur-in']) expect(block, t).toMatch(new RegExp(`${t}: 0px;`));
  });
  it('古いトークンの名前は、定義にも参照にも残さない', () => {
    for (const f of sheets) {
      const css = strip(read(f));
      for (const old of ['--dur-slow', '--dur-pop', 'var(--ease)', '--ease:']) expect(css, `${f}: ${old}`).not.toContain(old);
    }
  });
  it('transition と animation の長さは、トークンを通して書く', () => {
    for (const f of sheets.filter((f) => f !== 'tokens.css')) {
      for (const d of decls(read(f)).filter((d) => /^(transition|animation)(-duration|-delay)?$/.test(d.prop))) {
        expect(d.value, `${f}: ${d.prop}: ${d.value}`).not.toMatch(/(^|[\s,(])\d+(\.\d+)?m?s\b/);
      }
    }
  });
});

describe('JS の動き', () => {
  const src = (p: string) => fs.readFileSync(new URL(`../views/primitives/${p}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  it('FLIP の滑りは、長さと曲線をトークンで書く', () => {
    expect(src('flip.ts')).toContain("'transform var(--dur) var(--ease-out)'");
    expect(src('flip.ts')).not.toMatch(/\d+ms/);
  });
  it('サイドバーの開閉は、長さと曲線をトークンで書く', () => {
    expect(src('sidebarMotion.ts')).toContain("motionMs('--dur', shell)");
    expect(src('sidebarMotion.ts')).toContain("motionEase('--ease-out', shell)");
    expect(src('sidebarMotion.ts')).not.toMatch(/\d+ms/);
  });
  it('出入りの形は、長さと曲線をトークンで書く', () => {
    const kit = src('motionKit.ts');
    for (const t of ["motionMs('--dur', el)", "motionMs('--dur-exit', el)", "motionMs('--dur-fast', el)", "motionEase('--ease-out', el)", "motionEase('--ease-in', el)"]) expect(kit).toContain(t);
    expect(kit).not.toMatch(/\d+ms/);
  });
  it('数字の回転は、長さを --dur から読む', () => {
    expect(src('RollingText.tsx')).toContain("motionMs('--dur')");
    expect(src('RollingText.tsx')).not.toMatch(/setTimeout\([^)]*,\s*\d+\)/);
  });
});

describe('現れる動き', () => {
  const base = strip(read('base.css'));
  // 規則は base.css のほか session.css にもある。keyframes は base.css に集める。
  const rules = base + strip(read('session.css'));
  const keyframes = (name: string) => base.match(new RegExp(`@keyframes ${name} \\{ from \\{([^}]*)\\} 20% \\{([^}]*)\\} \\}`));
  // 現れるものは、ぼかしが晴れながら来る。
  // WebKit は 0 より大きいぼかしを 0.2px でも 1px と同じに描くので、晴れきる手前のもやが動きの終わりまで残る。
  // ぼかしは 20% の時点で none にして晴らし切り、残りは薄れと移動だけで入る。
  it.each([
    ['.screen', 'enter'],
    ['.dialog', 'pop'],
    ['.toast', 'slide'],
    ['.conn-banner', 'drop-in'],
    ['.session-oneliner', 'enter-x'],
  ])('%s は %s で、--dur と --ease-out で、ぼかしが晴れながら現れる', (selector, name) => {
    expect(rules).toMatch(new RegExp(`${selector.replace('.', '\\.')} \\{[^}]*animation: ${name} var\\(--dur\\) var\\(--ease-out\\);`));
    const k = keyframes(name);
    expect(k?.[1]).toContain('opacity: 0;');
    expect(k?.[1]).toContain('filter: blur(var(--blur-in));');
    expect(k?.[2]?.trim()).toBe('filter: none;');
  });
  it('画面は --rise だけ上がって入り、ダイアログは 96% から開く', () => {
    expect(keyframes('enter')?.[1]).toContain('transform: translateY(var(--rise));');
    expect(keyframes('pop')?.[1]).toContain('transform: scale(0.96);');
  });
});

describe('画面の移り変わり', () => {
  // 出る画面と入る画面を同じ長さと曲線で重ねる。揃えないと、変わらないヘッダとサイドバーが途中で明滅する。
  it('View Transitions の組は、どれも --dur と --ease-out で動く', () => {
    expect(strip(read('base.css'))).toContain('::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: var(--dur); animation-timing-function: var(--ease-out); }');
  });
  // 行の器は上段の大きさへ広がるが、写しは引き伸ばさない。札の写しが 3 倍に伸びた影になるのを防ぐ。
  it('行の器の写しは引き伸ばさず、左の中ほどに寄せて器で切る', () => {
    const css = strip(read('base.css'));
    expect(css).toContain('::view-transition-old(session-morph), ::view-transition-new(session-morph) { height: 100%; object-fit: none; object-position: left center; }');
    expect(css).toContain('::view-transition-group(session-morph) { overflow: clip; }');
  });
  // 名前の箱は、一覧の行では行の幅いっぱい、上段では文字の幅だけである。
  // 写しを既定のまま器の幅に合わせると、動きの初めに上段の名前が行の幅まで拡大され、文字が 2 倍以上に膨らむ。
  it('名前と状態の点の写しも引き伸ばさない', () => {
    const css = strip(read('base.css'));
    for (const name of ['session-morph-name', 'session-morph-dot']) {
      expect(css, name).toContain(`::view-transition-old(${name}), ::view-transition-new(${name}) { height: 100%; object-fit: none; object-position: left center; }`);
    }
  });
});

// 仕様：デスクトップの起動画面は、読み込みが終わった合図の後、UI の背景の光だけを描いて終わる（起動画面の F4）。
// 頁が替わった後は、その光の上にガラスが浮かんで来る。殻は作り直されないので、動くのは頁を開いた最初の 1 回だけである。
describe('頁を開いたときの入場', () => {
  const css = strip(read('base.css'));
  it('サイドバーは左から、ヘッダは上から、光の上に浮かんで来る', () => {
    expect(css).toContain('.shell > .sidebar { animation: glass-arrive-side var(--dur) var(--ease-out) backwards; }');
    expect(css).toContain('.shell > .header { animation: glass-arrive-head var(--dur) var(--ease-out) backwards; }');
    expect(css).toContain('@keyframes glass-arrive-side { from { opacity: 0; transform: translateX(-28px); } }');
    expect(css).toContain('@keyframes glass-arrive-head { from { opacity: 0; transform: translateY(-14px); } }');
  });
  // 起動画面から移った直後に「読み込んでいます」が一瞬だけ光の上に出ると、継ぎ目に見える。
  // ガラスが浮かび終わるまでに読み込めれば、文は一度も出ない。
  it('読み込み中の文は、ガラスが浮かび終わってから出る', () => {
    expect(css).toContain('.boot-wait { animation: enter var(--dur) var(--ease-out) var(--dur) backwards; }');
  });
});
