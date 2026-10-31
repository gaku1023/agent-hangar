/**
 * 周期の処理を、急ぐ理由がある間は短い間隔で、無い間は長い間隔で回す。
 * 待機中（どのセッションも休みで、画面も触られていない）に、変化の無いものを短い周期で見続けないための仕掛けである。
 * 急ぐ理由ができたら kick で次の回を繰り上げる。繰り下げはしない。
 * 間隔は 1 回ごとに fast() を読んで決め直す（setTimeout を重ねる）。
 */
export type PacerOptions = {
  /** Promise を返したら、終わるまで次の回を始めない。 */
  run: () => void | Promise<void>;
  fastMs: number;
  slowMs: number;
  /** いま急ぐか。回のたびと kick のたびに読む。 */
  fast: () => boolean;
  /** run が投げたもの。省けば console.error に出す。周期は止めない（タイマーの中で投げるとプロセスごと落ちる）。 */
  onError?: (e: unknown) => void;
};

export class Pacer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 次の回の予定の時刻。 */
  private due = Infinity;
  private running = false;
  /** 回が終わるのを待っている間か。 */
  private busy = false;
  /** 回の途中に来た kick の間隔。回が終わってから効かせる。 */
  private kicked: number | null = null;

  constructor(private readonly o: PacerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.delay());
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.due = Infinity;
  }

  /**
   * 次の回を ms 後へ繰り上げる。省けば、いまの間隔（fast() で決まる）の後である。
   * いまの予定のほうが早ければ何もしない。止まっている間も何もしない。
   */
  kick(ms?: number): void {
    if (!this.running) return;
    const wait = ms ?? this.delay();
    if (this.busy) {
      this.kicked = Math.min(this.kicked ?? Infinity, wait);
      return;
    }
    if (Date.now() + wait < this.due) this.schedule(wait);
  }

  private delay(): number {
    return this.o.fast() ? this.o.fastMs : this.o.slowMs;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.due = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.due = Infinity;
      const onError = this.o.onError ?? ((x: unknown) => console.error(x instanceof Error ? x.message : x));
      const done = (): void => {
        this.busy = false;
        const kicked = this.kicked;
        this.kicked = null;
        if (this.running && !this.timer) this.schedule(Math.min(kicked ?? Infinity, this.delay()));
      };
      this.busy = true;
      let r: void | Promise<void>;
      try {
        r = this.o.run();
      } catch (e) {
        onError(e);
        done();
        return;
      }
      if (r instanceof Promise) void r.catch(onError).then(done);
      else done();
    }, ms);
    this.timer.unref?.();
  }
}
