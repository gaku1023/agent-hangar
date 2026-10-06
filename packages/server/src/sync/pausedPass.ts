/**
 * 一時停止のまま、利用者が「今すぐ同期」で頼んだ 1 巡。
 *
 * 「一時停止」は外と話すのをやめることだが、利用者が自分で押した 1 回だけは通す。
 * 通すのは全部である。メタデータの送受信（metadata）と、その後の本文と設定の出し入れ（rest）。
 * 巡っている間だけ `active()` が立ち、サーバはそれを見て一時停止の判定を外す。
 * 終われば何も書き換えずに降りるので、止めた状態も止めた理由も元のまま残る。
 */
export class PausedPass {
  private first: Promise<void> | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: {
    /** メタデータの送受信。押した側はここまで待つ。 */
    metadata: () => Promise<void>;
    /** 本文と設定の出し入れ。量があると分単位でかかるので、押した側は待たない。 */
    rest: () => Promise<void>;
    /** 1 巡が終わり、判定が一時停止に戻った後に呼ぶ。 */
    done: () => void;
  }) {}

  /** 1 巡の最中か。 */
  active(): boolean { return this.running !== null; }

  /**
   * 1 巡を始める。戻るのはメタデータの送受信が済んだ時点で、残りは裏で続く。
   * 巡っている最中に押されたら、新しく始めずにその回へ相乗りする。
   * 決して reject しない。失敗は各段が自分の持ち場（同期の状態、ログ）に残す。
   */
  run(): Promise<void> {
    if (this.first) return this.first;
    const first = this.deps.metadata().catch(() => {});
    this.first = first;
    this.running = first
      .then(() => this.deps.rest())
      .catch(() => {})
      .then(() => {
        this.first = this.running = null;
        try { this.deps.done(); } catch { /* 知らせの失敗で落とさない。 */ }
      });
    return first;
  }

  /** 走っている 1 巡が終わるまで待つ。走っていなければすぐ戻る。 */
  idle(): Promise<void> { return this.running ?? Promise.resolve(); }
}
