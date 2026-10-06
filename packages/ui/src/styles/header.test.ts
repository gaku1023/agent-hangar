import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const base = read('./base.css');
/** セレクタがちょうど一致する規則の中身。 */
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(base)?.[1] ?? '';
};

/** 注釈を外した base.css。 */
const bare = base.replace(/\/\*[\s\S]*?\*\//g, '');
/**
 * 入れ子の無い規則を、選択子と中身の組で取り出す。
 * コンテナクエリの中の規則も、内側の規則として拾える。
 */
const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));

describe('ヘッダーの使用率のゲージ', () => {
  it('見出し（5 時間、週）はどの幅でも隠さない', () => {
    const keys = rules.filter((r) => r.selector.split(',').some((s) => s.trim() === '.header .gauge-key'));
    expect(keys.length).toBeGreaterThan(0);
    for (const r of keys) expect(r.body).not.toMatch(/display:\s*none/);
  });
  // 見出しは、ゲージの組ごと畳むまで残す（headerFold.ts の順）。CSS のどこでも、見出しだけを隠さない。
  it('見出しを隠す規則はどこにも無い', () => {
    for (const r of rules.filter((x) => x.selector.includes('gauge-key'))) expect(r.body).not.toMatch(/display:\s*none|clip-path/);
  });
  it('棒を畳んだら、数字の幅の下限を外す', () => {
    expect(rule('.header .gauge:has(> .gauge-bar[data-folded]) > .gauge-num')).toContain('min-width: 0;');
  });
});

/** sync.css も同じ形で読む。 */
const sync = read('./sync.css').replace(/\/\*[\s\S]*?\*\//g, '');
const syncRule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(sync)?.[1] ?? '';
};

describe('ヘッダーの右の列を畳む仕組み', () => {
  // 決め打ちの幅で畳むと、同期の文や件数の長さの変化に追いつかず、隣に重なって描かれた。畳むのは測る仕組み（useHeaderFold.ts）だけにする。
  it('決め打ちの幅で畳むコンテナクエリを置かない', () => {
    expect(bare).not.toMatch(/@container header \(max-width/);
  });
  // 畳んだ部品は見えなくするが、読み上げには残す（sr-only と同じ形）。
  it('畳んだ部品は、見えなくして読み上げに残す', () => {
    const folded = rule('.header-row [data-folded]');
    expect(folded).toContain('position: absolute;');
    expect(folded).toContain('clip-path: inset(50%);');
    expect(folded).not.toMatch(/display:\s*none/);
  });
  // 見えないボタンにフォーカスが止まると、どこにいるのか分からなくなる。同期の操作は設定の画面から押せる。
  it('畳んだ同期の操作は、フォーカスも止めない', () => {
    expect(rule('.header-row .sync-action[data-folded]')).toMatch(/display:\s*none/);
  });
  it('錠剤と新しいセッションは、文字を畳むと丸いボタンになる', () => {
    expect(rule('.header .search-pill:has(> [data-folded]), .header .btn.new-session:has(> [data-folded])')).toMatch(/width: var\(--row-h\);[^}]*padding: 0;/);
  });
  // 測るあいだは、部品が縮まない形にして、その段で要る幅をそのまま出す。
  it('測るあいだは、右の塊とその中身を縮ませず、間の伸びる余白も伸ばさない', () => {
    expect(rule('.header-row[data-fold-measuring] .header-end, .header-row[data-fold-measuring] .header-end *')).toContain('flex-shrink: 0;');
    expect(rule('.header-row[data-fold-measuring] > .spacer')).toContain('flex-grow: 0;');
  });
  // 測る仕組みが追いつかない一瞬や、測れない環境でも、はみ出しは切り詰めになり、隣に重ならない。
  it('右の塊の部品は 0 まで縮み、はみ出しは切り詰める', () => {
    for (const sel of ['.header .gauges', '.header .btn.new-session', '.header .progress']) {
      expect(rule(sel), sel).toContain('min-width: 0;');
      expect(rule(sel), sel).toContain('overflow: hidden;');
    }
    for (const sel of ['.header .new-session .btn-label', '.header .progress']) expect(rule(sel), sel).toContain('text-overflow: ellipsis;');
    expect(syncRule('.sync')).toContain('min-width: 0;');
    expect(syncRule('.sync')).toContain('overflow: hidden;');
    expect(syncRule('.sync > *')).toContain('min-width: 0;');
    expect(syncRule('.sync > *')).toContain('overflow: hidden;');
    expect(syncRule('.sync > *')).toContain('text-overflow: ellipsis;');
    expect(syncRule('.sync-label-text')).toContain('text-overflow: ellipsis;');
    expect(syncRule('.sync-dot')).toContain('flex: none;');
  });
});

describe('ヘッダのアカウントの切り替え', () => {
  const controls = read('./controls.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const controlsRule = (sel: string) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(controls)?.[1] ?? '';
  };
  // 窓を掴む領域の中で、ほかの部品と同じく 0 まで縮み、はみ出しは切る。
  it('ボタンは 0 まで縮み、はみ出しは切る', () => {
    expect(rule('.header .account-switch')).toContain('min-width: 0;');
    expect(rule('.header .account-switch')).toContain('overflow: hidden;');
    expect(rule('.header .account-switch')).toContain('flex: 0 100 auto;');
  });
  // 切る箱の中では、外へ描く輪が欠ける。
  it('フォーカスの輪は内側に描く', () => {
    expect(rule('.header .account-switch:focus-visible')).toContain('outline-offset: -2px;');
  });
  // 仕切りの線はボタンの面に替わる。ボタンの中の計器に、もう 1 本引かない。
  it('ボタンの中の計器には、仕切りの線も左の余白も付けない', () => {
    expect(rule('.header .account-switch .gauges')).toContain('padding-left: 0;');
    expect(rule('.header .account-switch .gauges::before')).toContain('display: none;');
  });
  // 名前は畳んでも読み上げに残す。隠すのは畳む印（data-folded）だけが行う。
  it('名前を隠す規則はどこにも無い', () => {
    for (const r of rules.filter((x) => x.selector.includes('account-name'))) expect(r.body).not.toMatch(/display:\s*none|clip-path/);
  });
  it('名前は、ゲージの見出しと同じ大きさ（--fs-xs）の 600 の字', () => {
    expect(rule('.header .account-name')).toContain('font-size: var(--fs-xs);');
    expect(rule('.header .account-name')).toContain('font-weight: 600;');
  });
  // 開いた先の面は .menu-pop で、ぼかしは新しい選択子に書かない（glass.test.ts）。
  it('開いた先の規則に backdrop-filter を書かない', () => {
    expect(controlsRule('.account-pop')).not.toContain('backdrop-filter');
    expect(controlsRule('.account-pop')).toContain('outline: none;');
  });
  it('選んだ札は青い 2px の輪、押せない札は薄くする', () => {
    expect(controlsRule(".account-card[aria-checked='true']")).toContain('inset 0 0 0 2px var(--accent)');
    expect(controlsRule(".account-card[aria-disabled='true'] .account-meters")).toContain('opacity: 0.6;');
  });
});

describe('ヘッダの列と検索欄の位置', () => {
  // ヘッダは殻の列を subgrid で使う。container はレイアウトの封じ込めを伴い、封じ込めのある要素では subgrid が効かない。
  it('ヘッダは subgrid で殻の列を使い、大きさの入れ物は内側の行に付ける', () => {
    expect(rule('.header')).toContain('grid-template-columns: subgrid;');
    expect(rule('.header')).not.toContain('container');
    expect(rule('.header-row')).toContain('container: header / inline-size;');
  });
  // 本文と検索欄は同じ左の余白（--gutter-l）で始まる。本文は --main-w で中央に寄るので、検索欄もその分を足す。
  // 余白を広げるのは、中央へ寄った本文がロゴの右端より左に来るときだけにする。いつも足すと、広い窓で畳んだときに本文が右へ逃げる。
  it('本文の左の余白は、中央へ寄った分を引いてから、ロゴの右端に届く分だけ広げる', () => {
    expect(base).toContain('--gutter-l: max(calc(var(--u) * 4), calc(var(--head-end) - var(--col1) - var(--box-l)));');
    expect(base).toContain('--box-l: max(0px, calc((100vw - var(--col1) - var(--main-w)) / 2));');
  });
  it('探す・移動の錠剤の左端は、本文の左端と同じ式で決まる', () => {
    expect(rule('.main-inner')).toMatch(/max-width: var\(--main-w\);[^}]*margin: 0 auto;[^}]*var\(--gutter-l\);/);
    expect(rule('.header-row > .search-pill')).toContain('margin-left: max(var(--gutter-l), calc((100cqw - var(--main-w)) / 2 + var(--gutter-l)));');
  });
  // 錠剤は押すボタンで、幅は中身の分だけにする（A1）。欄のように伸ばすと、打てる欄に見える。
  it('探す・移動の錠剤は浮いた錠剤で、幅は中身の分だけ', () => {
    expect(rule('.search-pill')).toContain('border-radius: var(--r-pill);');
    expect(rule('.search-pill')).toContain('flex: none;');
    expect(rule('.search-pill')).not.toMatch(/flex: 1/);
  });
  it('狭いときは錠剤の文字とキー帽を畳み、虫眼鏡だけを残す（畳む印は headerFold.ts が付ける）', () => {
    expect(rule('.header .search-pill:has(> [data-folded]), .header .btn.new-session:has(> [data-folded])')).toContain('justify-content: center;');
    expect(base).not.toContain('search-icon');
    expect(base).not.toContain('.search-box');
  });
  // 開閉の動きは --col1 も動かす。登録していないと途中の値が補間されず、本文と検索欄の余白だけが跳ぶ。
  it('左の列の幅は、登録したカスタムプロパティ --col1 に持つ', () => {
    expect(base).toContain("@property --col1 { syntax: '<length>'; inherits: true;");
    expect(base).toMatch(/\.shell \{[^}]*grid-template-columns: var\(--col1\) minmax\(0, 1fr\);/);
    expect(rule(".shell[data-sidebar='collapsed']")).toContain('--col1:');
    expect(base).not.toMatch(/\.shell\[data-sidebar='collapsed'\] \{[^}]*grid-template-columns/);
  });
  // 畳んだ帯ではロゴが列の外まで伸びる。ロゴの箱の幅を決め打ちにしておかないと、字形の読み込みの前後で本文の位置が動く。
  it('ロゴの箱の幅は tokens の --brand-w に決め打ちし、はみ出した分は切る', () => {
    expect(read('./tokens.css')).toMatch(/--brand-w: \d+px;/);
    expect(rule('.brand')).toMatch(/width: var\(--brand-w\);[^}]*overflow: hidden;/);
    expect(base).toMatch(/--head-end: calc\(var\(--head-lead\) \+ var\(--brand-w\) \+ [^;]+\);/);
  });
});

describe('頁の見出し', () => {
  it('見出しは 18px の太字で、下の線で本文と分ける', () => {
    expect(rule('.page-title')).toMatch(/font-size: 18px;[^}]*font-weight: 700;/);
    expect(rule('.page-head')).toContain('border-bottom: 1px solid var(--line-strong);');
  });
  // 親の行と見出しの行の高さを決めておくと、どの頁へ移っても見出しと線の高さが揃う。
  it('親の行と見出しの行は、中身に関わらず同じ高さを取る', () => {
    expect(rule('.page-parent')).toContain('height: 18px;');
    expect(rule('.page-title-row')).toContain('min-height: var(--row-h);');
  });
});
