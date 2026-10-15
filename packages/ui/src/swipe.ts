/**
 * トラックパッドの横スワイプで戻る / 進むを決める。
 *
 * WKWebView の手勢（`allowsBackForwardNavigationGestures`）は、前の画面のスナップショットを指に追従させる
 * 演出まで一式で引き受けてしまい、演出だけを切る手段が無い。
 * だからそちらは使わず、横方向のホイールを自分で積む。
 *
 * 作法はブラウザと同じで、**引いて、離したときに動く**。
 * 離したことは呼び出し側が知らせる（`release()` を呼ぶ）。合図は環境で違う。
 * macOS の殻は、OS の指の位相を殻が頁へ渡す（phase）。
 * Windows の殻（gap）は、指を離した瞬間に Chromium が送る 0 の打鍵を合図にし（`createLiftDetector`）、
 * それが来ない環境のために、打鍵の途切れ（`SWIPE_RELEASE_GAP_MS`）も合図として残す。
 * 打鍵の細りは合図に使わない。指を付けたまま引く速さは途中で普通に落ちるので、
 * 細りで動かすと「離していないのに戻る」ことになる。
 * 0 の打鍵の来ない環境で、引き切ってから勢いよく離した回は、惰性が流れ終わるまで動きが遅れるが、誤って動くよりはよい。
 */

/** これだけ横に引いたら身構える（離せば動く）。 */
export const SWIPE_THRESHOLD = 120;
/**
 * この間だけ打鍵が途切れたら、手勢そのものが終わったとみなす。
 * ゆっくり動かすと打鍵の間隔は開くので、短く取ると引いている最中に積みが消える。
 * 位相の来る環境では `begin()` が手勢を仕切るので、ここは古い積みを捨てるための保険でしかない。
 */
export const SWIPE_IDLE_MS = 1000;
/** 1 打鍵がこれより細ければ、惰性が尽きたとみなす。 */
export const SWIPE_REARM_DELTA = 4;
/** これ以上の打鍵を「本気で引いた」とみなす。惰性の名残だけで身構えないための下限。 */
export const SWIPE_PUSH_DELTA = 4;
/** 身構えた後、積みがしきい値のこの割合まで戻ったら取り消す。 */
export const SWIPE_CANCEL_RATIO = 0.5;
/** 縦にこれだけ流れて、しかも横より多ければ、縦の手勢とみなして取り消す。 */
export const SWIPE_VERTICAL_CANCEL = 40;

/**
 * 身構えないまま宙に浮いた手勢の矢印を消すまでの待ち。
 * 画面は動かさない。消すだけなので、誤って動く経路にはならない。
 */
export const SWIPE_STALE_HIDE_MS = 2000;

/**
 * Windows の殻で、打鍵がこれだけ途切れたら指が離れたとみなす。
 * Windows の殻は指の位相を送らない（WebView2 にも、頁へ位相を渡す口が無い）。
 * 離した瞬間の 0 の打鍵（`createLiftDetector`）が先に来ればそちらで動くので、これは 0 の打鍵が来ない環境のための保険である。
 * 弾いた回は惰性が途切れずに約 2 秒流れるので、途切れだけを頼ると、そのあいだ遷移が待たされる（2026-10-14 の Windows 11 の記録）。
 * 離した後は、惰性が尽きた（途切れた）ことを知る幅にも使う。
 * 指が動いている間の打鍵は 1 コマごと（60Hz で約 17ms）に来る。負荷でコマが数枚落ちても途切れと読まない幅として 150ms を取る。
 * 長く取るほど、離してから動くまでが遅れて鈍く感じる（0.2 秒を超えると目立つ）。
 * 引き切ったまま指を止めた回もここで動く。それは位相の無い環境の引き換えである。
 */
export const SWIPE_RELEASE_GAP_MS = 150;

/**
 * 手勢の終わりの決め方。
 * phase は殻が送る指の位相（macOS）、gap は打鍵の途切れ（Windows の殻）、off は自前の手勢を持たない（ブラウザ）。
 */
export type SwipeMode = 'phase' | 'gap' | 'off';

/**
 * いまの環境での手勢の終わりの決め方。
 * 位相が届けばそれを使う。Windows の殻では途切れで決める。
 * ブラウザには元から戻る進むの手勢があるので、二重に持たない。
 * macOS の殻で位相の印がまだ立っていないときも、時間では決めない（指を置いたまま動く経路を作らない）。
 */
export function swipeModeOf(env: { phaseAware: boolean; desktop: boolean; platform: 'darwin' | 'win32' | 'linux' }): SwipeMode {
  if (env.phaseAware) return 'phase';
  return env.desktop && env.platform === 'win32' ? 'gap' : 'off';
}

export type SwipeSample = { deltaX: number; deltaY: number; at: number };
export type SwipeResult = 'back' | 'forward' | null;
export type SwipeProgress = { dir: -1 | 0 | 1; ratio: number; armed: boolean };

export function createSwipeDetector(opts: { threshold?: number; idleMs?: number } = {}) {
  const threshold = opts.threshold ?? SWIPE_THRESHOLD;
  const idleMs = opts.idleMs ?? SWIPE_IDLE_MS;

  /** いま積んでいる量。向きは符号で持つ。 */
  let sum = 0;
  /** 縦に積んだ量。1 打鍵ごとに縦横を比べると、指を置いている間の微動で手勢が消える。 */
  let sumY = 0;
  /** 本気の打鍵があったか。惰性の名残だけで身構えないための印。 */
  let pushed = false;
  /** 引き切って身構えている向き。0 なら身構えていない。 */
  let armedDir = 0;
  /** 動かした向き。惰性で二度動かさないための掛け金で、0 なら下りている。 */
  let firedDir = 0;
  let last = -Infinity;

  function reset(): void {
    sum = 0;
    sumY = 0;
    pushed = false;
    armedDir = 0;
  }

  function fire(): SwipeResult {
    firedDir = armedDir;
    reset();
    return firedDir < 0 ? 'back' : 'forward';
  }

  function feed(s: SwipeSample): SwipeResult {
    const idle = s.at - last > idleMs;
    last = s.at;
    if (idle) { reset(); firedDir = 0; }
    // 中身の無い打鍵は、位相の切り替わり（指が触れた／離れた）に付いてくる。手勢の中身ではないので触らない。
    if (s.deltaX === 0 && s.deltaY === 0) return null;
    const dir = Math.sign(s.deltaX);
    if (firedDir !== 0) {
      // 動かした後の惰性は同じ向きに先細る。細り切るか、逆へ引かれるまでは何も受けない。
      if (dir !== firedDir || Math.abs(s.deltaX) < SWIPE_REARM_DELTA) { firedDir = 0; reset(); }
      else return null;
    }
    // 積みは符号のまま足す。
    // 逆向きが 1 つ来ただけで捨ててはいけない。実機の打鍵は一方向に揃わず、細かな揺れが必ず混じる。
    sum += s.deltaX;
    sumY += s.deltaY;
    // 縦に流しているなら手勢ではない。1 打鍵ごとに縦横を比べると、
    // 指を置いている間の微動（縦の方が大きい回がいくらでもある）で手勢が消えるので、積んだ量で見る。
    if (Math.abs(sumY) >= SWIPE_VERTICAL_CANCEL && Math.abs(sumY) > Math.abs(sum)) { reset(); return null; }
    if (Math.abs(s.deltaX) >= SWIPE_PUSH_DELTA) pushed = true;
    if (armedDir === 0 && pushed && Math.abs(sum) >= threshold) armedDir = Math.sign(sum);
    // 引き戻して積みが半分まで戻ったら取り消す。向きが変わったときも同じ。
    if (armedDir !== 0 && (Math.sign(sum) !== armedDir || Math.abs(sum) < threshold * SWIPE_CANCEL_RATIO)) armedDir = 0;
    // 打鍵が来ている間は指が動いている。動かすのは途切れたとき（release）だけである。
    return null;
  }

  /** 新しい手勢が始まった。前の手勢の名残をすべて捨てる。 */
  function begin(): void {
    reset();
    firedDir = 0;
    last = -Infinity;
  }

  /** 打鍵が途切れた。身構えていれば、そこで離したとみなす。 */
  function release(): SwipeResult {
    return armedDir === 0 ? null : fire();
  }

  /**
   * いまどれだけ引いているか。画面端の矢印はこれで出方を決める。
   * 動かした後の惰性の最中は 0 を返す。動かない手勢に矢印を出しても嘘になる。
   */
  function progress(): SwipeProgress {
    if (firedDir !== 0) return { dir: 0, ratio: 0, armed: false };
    return { dir: Math.sign(sum) as -1 | 0 | 1, ratio: Math.min(1, Math.abs(sum) / threshold), armed: armedDir !== 0 };
  }

  return { feed, begin, release, progress };
}
/**
 * Windows の殻（gap）で、打鍵 1 つが手勢の何に当たるか。
 * feed は手勢の中身、lift は指が離れた合図、drop は捨てる打鍵（離した後の惰性と、手勢の外の 0 の打鍵）。
 */
export type LiftStep = 'feed' | 'lift' | 'drop';

/**
 * Windows の殻で、指が離れたことを打鍵から読む。
 * Windows の Chromium（Edge と WebView2）は、高精度タッチパッドから指を離した瞬間に、deltaX と deltaY がどちらも 0 の打鍵を 1 つ送る。
 * 手勢の最中にそれが来たら、そこで離したとみなす（lift）。
 * 続く惰性は、打鍵が途切れる（呼び出し側が `gap()` を呼ぶ）か、逆向きに本気で引かれるまで捨てる。
 * 惰性の頭の細い打鍵で掛け金（createSwipeDetector の firedDir）が外れ、惰性でもう一度身構えるのを防ぐためである。
 * 0 の打鍵が来ない環境（高精度でないタッチパッドなど）では、これまでどおり途切れ（SWIPE_RELEASE_GAP_MS）が合図になる。
 * 純粋な状態だけを持ち、時計は呼び出し側が持つ。
 */
export function createLiftDetector() {
  /** 指が離れた後の惰性を捨てている間か。 */
  let afterLift = false;
  /** 離した手勢の向き。逆向きに引かれたら新しい手勢とみなす。 */
  let liftDir = 0;
  /** いまの手勢の、最後の横の打鍵の向き。 */
  let lastDir = 0;

  /** 打鍵 1 つを読む。inGesture は手勢の最中か（呼び出し側の、終わっていない手勢があるか）。 */
  function wheel(s: { deltaX: number; deltaY: number }, inGesture: boolean): LiftStep {
    if (afterLift) {
      const reversed = liftDir !== 0 && Math.sign(s.deltaX) === -liftDir && Math.abs(s.deltaX) >= SWIPE_PUSH_DELTA;
      if (!reversed) return 'drop';
      afterLift = false;
      inGesture = false;
    }
    if (s.deltaX === 0 && s.deltaY === 0) {
      if (!inGesture) return 'drop';
      afterLift = true;
      liftDir = lastDir;
      return 'lift';
    }
    if (!inGesture) lastDir = 0;
    if (s.deltaX !== 0) lastDir = Math.sign(s.deltaX);
    return 'feed';
  }

  /** 打鍵が途切れた。惰性は尽きたので、次の打鍵からは新しい手勢である。 */
  function gap(): void {
    afterLift = false;
  }

  return { wheel, gap };
}
