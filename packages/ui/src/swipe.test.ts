import { describe, expect, it } from 'vitest';
import WHEEL_LOG from './test/fixtures/windows-touchpad-wheel.json';
import { createLiftDetector, createSwipeDetector, swipeModeOf, SWIPE_IDLE_MS, SWIPE_RELEASE_GAP_MS, SWIPE_STALE_HIDE_MS, SWIPE_THRESHOLD } from './swipe.ts';

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

describe('Windows の殻で、0 の打鍵を指が離れた合図にする', () => {
  it('手勢の最中の 0 の打鍵は lift、続く惰性は途切れるまで捨てる', () => {
    const d = createLiftDetector();
    expect(d.wheel({ deltaX: -40, deltaY: 0 }, false)).toBe('feed');
    expect(d.wheel({ deltaX: -90, deltaY: 0 }, true)).toBe('feed');
    expect(d.wheel({ deltaX: 0, deltaY: 0 }, true)).toBe('lift');
    // 惰性の頭の細い打鍵も、同じ向きの太い惰性も捨てる。
    expect(d.wheel({ deltaX: -2, deltaY: 0 }, false)).toBe('drop');
    expect(d.wheel({ deltaX: -190, deltaY: 0 }, false)).toBe('drop');
    expect(d.wheel({ deltaX: 0, deltaY: 0 }, false)).toBe('drop');
    d.gap();
    expect(d.wheel({ deltaX: -30, deltaY: 0 }, false)).toBe('feed');
  });

  it('離した後でも、逆向きに本気で引かれたら新しい手勢として受ける', () => {
    const d = createLiftDetector();
    d.wheel({ deltaX: 80, deltaY: 0 }, false);
    expect(d.wheel({ deltaX: 0, deltaY: 0 }, true)).toBe('lift');
    expect(d.wheel({ deltaX: 20, deltaY: 0 }, false)).toBe('drop');
    expect(d.wheel({ deltaX: -2, deltaY: 0 }, false)).toBe('drop');
    expect(d.wheel({ deltaX: -60, deltaY: 0 }, false)).toBe('feed');
  });

  it('手勢の外の 0 の打鍵（止めた指を後で離したとき）は捨てる', () => {
    const d = createLiftDetector();
    expect(d.wheel({ deltaX: 0, deltaY: 0 }, false)).toBe('drop');
    expect(d.wheel({ deltaX: 30, deltaY: 0 }, false)).toBe('feed');
  });
});

/**
 * 記録の再生。Windows 11 の高精度タッチパッドを Edge で左右に 28 回引いたときの wheel の列（時刻、deltaX、deltaY だけ）。
 * 弾いた回は「指の動き → 0 の打鍵 1 つ → 約 2 秒の惰性」の形で届く。
 * Root の gap 分岐と同じ手順を、擬似の時計で流す。lift が false なら、途切れだけで離したとみなす前の作りである。
 */
type WheelRec = { n: number; result: 'back' | 'forward' | null; events: [number, number, number][] };
const RECS = WHEEL_LOG as unknown as WheelRec[];

function replayGap(events: [number, number, number][], lift: boolean) {
  const swipe = createSwipeDetector();
  const lifted = createLiftDetector();
  let ended = false;
  let timer: { at: number; run: (at: number) => void } | null = null;
  const navs: { at: number; r: 'back' | 'forward' }[] = [];
  const arms: number[] = [];
  let armedSeen = false;
  const release = (at: number) => {
    ended = true;
    armedSeen = false;
    const r = swipe.release();
    if (r) navs.push({ at, r });
  };
  for (const [t, dx, dy] of events) {
    if (timer && timer.at <= t) { const f = timer; timer = null; f.run(f.at); }
    if (lift) {
      const step = lifted.wheel({ deltaX: dx, deltaY: dy }, !ended);
      if (step !== 'feed') {
        timer = { at: t + SWIPE_RELEASE_GAP_MS, run: () => lifted.gap() };
        if (step === 'lift') release(t);
        continue;
      }
    }
    if (ended) { ended = false; swipe.begin(); }
    timer = { at: t + SWIPE_RELEASE_GAP_MS, run: release };
    swipe.feed({ deltaX: dx, deltaY: dy, at: t });
    if (swipe.progress().armed && !armedSeen) { armedSeen = true; arms.push(t); }
  }
  if (timer) timer.run(timer.at);
  return { navs, arms };
}

describe('Windows のタッチパッドの記録を再生する', () => {
  const all = RECS.flatMap((r) => r.events).sort((a, b) => a[0] - b[0]);
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
  /** 身構えてから、その後の最初の遷移までの待ち。 */
  const waits = (run: ReturnType<typeof replayGap>, arms: number[]) => arms.map((a) => run.navs.find((n) => n.at >= a)!.at - a);
  const before = replayGap(all, false);
  const after = replayGap(all, true);

  it('途切れだけで決める前の作りは、弾いた回で惰性が尽きるまで（約 2 秒）待たされていた', () => {
    expect(before.navs).toHaveLength(19);
    expect(median(waits(before, before.arms))).toBeGreaterThan(1000);
    expect(Math.max(...waits(before, before.arms))).toBeGreaterThan(4000);
  });

  it('0 の打鍵で離したとみなすと、身構えてから動くまでが 0.6 秒を超えない', () => {
    const w = waits(after, before.arms);
    expect(Math.max(...w)).toBeLessThan(600);
    // 弾いた回（前の作りで 1 秒を超えて待たされた回）は 0.2 秒以内に動く。
    const flicks = waits(before, before.arms).map((x, i) => [x, w[i]!] as const).filter(([x]) => x > 1000);
    expect(flicks).toHaveLength(11);
    expect(median(flicks.map(([, y]) => y))).toBeLessThan(200);
  });

  it('惰性で二度動かない。増えるのは、弾いた直後に逆へ引いた 1 回だけ', () => {
    expect(after.navs).toHaveLength(20);
    for (const rec of RECS) {
      const from = rec.events[0]![0];
      const to = rec.events[rec.events.length - 1]![0] + SWIPE_RELEASE_GAP_MS;
      const here = after.navs.filter((n) => n.at >= from && n.at <= to).map((n) => n.r);
      expect(new Set(here).size, `#${rec.n}`).toBe(here.length);
      // 遷移した回は、記録の時と同じ向きで終わる。
      if (rec.result) expect(here.at(-1), `#${rec.n}`).toBe(rec.result);
      else expect(here, `#${rec.n}`).toEqual([]);
    }
  });
});
