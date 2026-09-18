type Entry = { id: number; at: number; fn: () => void; interval: number | null };

/**
 * 同期エンジンのデバウンスと定期実行を、実時間を待たずに進める時計。
 * now は公開の項目なので、テストから直に足して日付をまたがせることもできる。
 */
export class FakeTimers {
  now = 1_000_000;
  private entries: Entry[] = [];
  private nextId = 1;

  setTimeout = ((fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.entries.push({ id, at: this.now + (Number.isFinite(ms) ? ms : 0), fn, interval: null });
    return this.handle(id);
  }) as unknown as typeof setTimeout;

  clearTimeout = ((h: unknown) => {
    const id = this.idOf(h);
    if (id !== null) this.entries = this.entries.filter((e) => e.id !== id);
  }) as typeof clearTimeout;

  setInterval = ((fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.entries.push({ id, at: this.now + (Number.isFinite(ms) ? ms : 0), fn, interval: Number.isFinite(ms) ? ms : 0 });
    return this.handle(id);
  }) as unknown as typeof setInterval;

  clearInterval = ((h: unknown) => {
    const id = this.idOf(h);
    if (id !== null) this.entries = this.entries.filter((e) => e.id !== id);
  }) as typeof clearInterval;

  private handle(id: number): NodeJS.Timeout {
    return { id, unref() { return this; }, ref() { return this; } } as unknown as NodeJS.Timeout;
  }

  private idOf(h: unknown): number | null {
    if (h === null || h === undefined) return null;
    const id = (h as { id?: unknown }).id;
    return typeof id === 'number' ? id : null;
  }

  /** まだ発火していないタイマーの数。stop の後始末を確かめるのに使う。 */
  pendingCount(): number { return this.entries.length; }

  /**
   * ms だけ時計を進める。
   * 期限の来たタイマーを早い順に発火し、発火ごとにマイクロタスクを流すので、
   * タイマーの中で await している処理も進む。
   */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.entries].filter((e) => e.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      if (due.interval === null) this.entries = this.entries.filter((e) => e !== due);
      else due.at += Math.max(1, due.interval);
      due.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

/** 非同期の連鎖を流し切る。setImmediate を数回回す。 */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
