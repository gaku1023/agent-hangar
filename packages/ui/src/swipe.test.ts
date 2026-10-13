import { describe, expect, it } from 'vitest';
import { createSwipeDetector, swipeModeOf, SWIPE_IDLE_MS, SWIPE_RELEASE_GAP_MS, SWIPE_STALE_HIDE_MS, SWIPE_THRESHOLD } from './swipe.ts';

const STEP = SWIPE_THRESHOLD / 6;

/** 1 回の手勢のつもりで、指を付けたまま同じ強さで払う。 */
function pull(feed: (s: { deltaX: number; deltaY: number; at: number }) => unknown, dx: number, from: number, times = 6) {
  const out: unknown[] = [];
  let at = from;
  for (let i = 0; i < times; i++) out.push(feed({ deltaX: dx, deltaY: 0, at: (at += 16) }));
  return { out, at };
}

describe('横スワイプの検出', () => {
  it('引いている間は動かず、引き切ったところで身構える', () => {
    const { feed, progress } = createSwipeDetector();
    const { out } = pull(feed, -STEP, 0);
    expect(out.every((r) => r === null)).toBe(true);
    expect(progress()).toEqual({ dir: -1, ratio: 1, armed: true });
  });

  it('身構えたまま指が止まれば、離したとみなして動く', () => {
    const { feed, release } = createSwipeDetector();
    pull(feed, -STEP, 0);
    expect(release()).toBe('back');
    // 一度動かしたら、同じ手勢ではもう動かない。
    expect(release()).toBeNull();
  });

  it('引く速さが落ちただけでは動かない', () => {
    // 指を付けたまま引く速さは途中で落ちる。そこで動かすと「離していないのに戻る」になる。
    const { feed, progress } = createSwipeDetector();
    const { at } = pull(feed, -STEP, 0);
    let t = at;
    for (const d of [8, 4, 2, 1, 3, 9]) expect(feed({ deltaX: -d, deltaY: 0, at: (t += 16) })).toBeNull();
    expect(progress().armed).toBe(true);
  });

  it('右へ引いて離せば進む', () => {
    const { feed, release } = createSwipeDetector();
    pull(feed, STEP, 0);
    expect(release()).toBe('forward');
  });

  it('引き切らずに離しても動かない', () => {
    const { feed, release, progress } = createSwipeDetector();
    pull(feed, -STEP, 0, 3);
    expect(progress()).toEqual({ dir: -1, ratio: 0.5, armed: false });
    expect(release()).toBeNull();
  });

  it('細かな揺れが混じっても引き切れる', () => {
    // 実機の打鍵は一方向に揃わない。逆向きが 1 つ来るたびに積みを捨てると、いつまでも身構えない。
    const { feed, release, progress } = createSwipeDetector();
    let at = 0;
    for (const d of [-6, -8, 2, -7, -9, 1, -8, -12, 3, -10, -14, -9, -11, -13, -8, -9, -12, -10]) {
      feed({ deltaX: d, deltaY: 0, at: (at += 12) });
    }
    expect(progress().armed).toBe(true);
    expect(release()).toBe('back');
  });

  it('引き戻して積みが戻れば取り消しになる', () => {
    const { feed, release, progress } = createSwipeDetector();
    const { at } = pull(feed, -STEP, 0);
    expect(progress().armed).toBe(true);
    // 引いた分の半分以上を戻したら、身構えを解く。
    let t = at;
    for (let i = 0; i < 4; i++) feed({ deltaX: STEP, deltaY: 0, at: (t += 16) });
    expect(progress().armed).toBe(false);
    expect(release()).toBeNull();
  });

  it('一度動いたら、同じ向きの惰性では二度動かない', () => {
    const { feed, release } = createSwipeDetector();
    const { at } = pull(feed, -STEP, 0);
    expect(release()).toBe('back');
    // 惰性が先細りながら流れ続ける。ここで二度目を出すと 2 画面戻ってしまう。
    let t = at;
    const after: unknown[] = [];
    for (const d of [16, 12, 9, 7, 5, 4, 3, 2, 2, 1, 1]) after.push(feed({ deltaX: -d, deltaY: 0, at: (t += 16) }));
    expect(after.every((r) => r === null)).toBe(true);
    expect(release()).toBeNull();
  });

  it('惰性が尽きてから同じ向きに引き直せば、また動く', () => {
    const { feed, release } = createSwipeDetector();
    const { at } = pull(feed, -STEP, 0);
    expect(release()).toBe('back');
    let t = at;
    for (const d of [8, 4, 2, 1]) feed({ deltaX: -d, deltaY: 0, at: (t += 16) });
    const again = pull(feed, -STEP, t);
    expect(again.out.every((r) => r === null)).toBe(true);
    expect(release()).toBe('back');
  });

  it('ゆっくり引いても積みは続く', () => {
    // ゆっくり動かすと打鍵の間隔が開く。そこで積みを捨てると、いくら引いても身構えない。
    const { feed, release } = createSwipeDetector();
    let at = 0;
    for (let i = 0; i < 12; i++) feed({ deltaX: -12, deltaY: 0, at: (at += 300) });
    expect(release()).toBe('back');
  });

  it('begin で手勢を仕切り直せる', () => {
    const { feed, begin, release, progress } = createSwipeDetector();
    pull(feed, -STEP, 0);
    expect(progress().armed).toBe(true);
    begin();
    expect(progress()).toEqual({ dir: 0, ratio: 0, armed: false });
    expect(release()).toBeNull();
  });

  it('手が離れてからの次の手勢はまた効く', () => {
    const { feed, release } = createSwipeDetector();
    pull(feed, -STEP, 0);
    expect(release()).toBe('back');
    pull(feed, -STEP, 10_000 + SWIPE_IDLE_MS);
    expect(release()).toBe('back');
  });

  it('空の打鍵では手勢を捨てない', () => {
    // 指を離すとき、macOS は中身の無いスクロールイベントも投げてくる。
    // これを「縦に流している」と読んで積みを捨てると、引いて止めた手勢が離す前に消える。
    const { feed, release, progress } = createSwipeDetector();
    const { at } = pull(feed, -STEP, 0);
    expect(feed({ deltaX: 0, deltaY: 0, at: at + 16 })).toBeNull();
    expect(progress().armed).toBe(true);
    expect(release()).toBe('back');
  });

  it('縦の揺れが混じっても引き切れる', () => {
    // 指を置いている間もトラックパッドは微動を拾う。縦の揺れ 1 発で積みを捨てると、身構えた直後に消える。
    const { feed, release, progress } = createSwipeDetector();
    let at = 0;
    for (const [dx, dy] of [[-10, 1], [-12, -2], [-9, 3], [-11, -1], [-13, 2], [-10, -3], [-12, 1], [-14, -2], [-11, 2], [-9, -1], [-12, 3], [-10, -2]] as const) {
      feed({ deltaX: dx, deltaY: dy, at: (at += 12) });
    }
    expect(progress().armed).toBe(true);
    // 身構えたまま指を置いていると、微動だけが届く。これで消えてはいけない。
    for (const [dx, dy] of [[0, 1], [-1, 2], [1, -1], [0, 2], [-1, -2], [1, 1]] as const) {
      feed({ deltaX: dx, deltaY: dy, at: (at += 40) });
    }
    expect(progress().armed).toBe(true);
    expect(release()).toBe('back');
  });

  it('縦に流している間は身構えない', () => {
    // 縦の一覧を流すと横にも少し漏れる。それを積み上げて手勢にしてはいけない。
    // 逆に、横へ引き切った後は軸が横に固まる（ブラウザと同じ）。縦に動いても取り消さない。
    const { feed, release, progress } = createSwipeDetector();
    let at = 0;
    for (let i = 0; i < 30; i++) feed({ deltaX: -5, deltaY: -30, at: (at += 12) });
    expect(progress().armed).toBe(false);
    expect(release()).toBeNull();
  });

  it('惰性の細い打鍵だけでは身構えない', () => {
    // 前の手勢の名残が積もっただけで身構えると、触っていないのに画面が動く。
    const { feed, release } = createSwipeDetector();
    let at = 0;
    for (let i = 0; i < 60; i++) feed({ deltaX: -3, deltaY: 0, at: (at += 16) });
    expect(release()).toBeNull();
  });
});

describe('手勢の終わりの決め方', () => {
  it('位相の届く殻では、位相で決める', () => {
    expect(swipeModeOf({ phaseAware: true, desktop: true, platform: 'darwin' })).toBe('phase');
  });

  it('Windows の殻では、位相が無いので打鍵の途切れで決める', () => {
    expect(swipeModeOf({ phaseAware: false, desktop: true, platform: 'win32' })).toBe('gap');
  });

  it('ブラウザでは自前の手勢を持たない', () => {
    // ブラウザには元から戻る進むの手勢がある。二重に持たない。
    expect(swipeModeOf({ phaseAware: false, desktop: false, platform: 'win32' })).toBe('off');
    expect(swipeModeOf({ phaseAware: false, desktop: false, platform: 'darwin' })).toBe('off');
    expect(swipeModeOf({ phaseAware: false, desktop: false, platform: 'linux' })).toBe('off');
  });

  it('macOS の殻で位相がまだ届いていなければ、時間では決めない', () => {
    // macOS は位相の合図で決める作りである。印が立つ前に時間で決めると、指を置いたまま動く。
    expect(swipeModeOf({ phaseAware: false, desktop: true, platform: 'darwin' })).toBe('off');
  });

  it('途切れの幅は、打鍵の間隔よりずっと長く、手応えが遅れるほどは長くない', () => {
    // 指が動いている間の打鍵は 1 コマごと（60Hz で約 17ms）に来る。負荷でコマが数枚落ちても途切れと読まない幅が要る。
    expect(SWIPE_RELEASE_GAP_MS).toBeGreaterThanOrEqual(6 * 17);
    // 離してから動くまでの遅れは、0.2 秒を超えると手応えが鈍く感じる。
    expect(SWIPE_RELEASE_GAP_MS).toBeLessThanOrEqual(200);
    expect(SWIPE_RELEASE_GAP_MS).toBeLessThan(SWIPE_STALE_HIDE_MS);
    expect(SWIPE_RELEASE_GAP_MS).toBeLessThan(SWIPE_IDLE_MS);
  });
});
