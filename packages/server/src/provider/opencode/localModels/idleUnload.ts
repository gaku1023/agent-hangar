import { LmStudio } from './lmstudio.ts';
import { readLedger, writeLedger, type LedgerEntry } from './prepare.ts';

/**
 * 使っていない LM Studio のモデルを自動で外す見張り（docs/design.md「起動前の準備」）。
 * 見るのは hangar が載せた instance（記録 opencode/local-models.json）だけで、手で載せたものは触らない。
 * その instance を使う会話がすべて止まってから設定の分が過ぎたら外し、記録から消して知らせる。
 * 止まっているかは数えない。いつから止まっているかは、見張りが初めて気付いた時刻から数える（起こし直しでも数え直しになる）。
 */

export const IDLE_UNLOAD_POLL_MS = 30_000;

export type IdleUnloadDeps = {
  /** hangar のホーム。記録の置き場。 */
  home: string;
  /** 設定の分（opencodeIdleUnload）。0 は外さない。呼ばれた時点の値を読む。 */
  minutes: () => number;
  /** その hangar の会話がいま動いている（プロセスがある）か。入力待ちで開いているものも動いているとみなす。 */
  isRunning: (hangarSessionId: string) => boolean;
  /** 外したときの知らせ。 */
  announce: (model: string, minutes: number) => void;
  now?: () => number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

const keyOf = (e: Pick<LedgerEntry, 'origin' | 'instanceId'>): string => `${e.origin}\n${e.instanceId}`;

export class IdleUnloadWatch {
  /** instance ごとに、どの会話も動いていないと見始めた時刻。 */
  private readonly idleSince = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly deps: IdleUnloadDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e: unknown) => { (this.deps.log ?? console.warn)(`[idle-unload] ${e instanceof Error ? e.message : String(e)}`); });
    }, IDLE_UNLOAD_POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.scan();
    } finally {
      this.busy = false;
    }
  }

  private async scan(): Promise<void> {
    const minutes = this.deps.minutes();
    const entries = readLedger(this.deps.home);
    const live = new Set(entries.map(keyOf));
    for (const k of this.idleSince.keys()) if (!live.has(k)) this.idleSince.delete(k);
    if (minutes <= 0) { this.idleSince.clear(); return; }
    const now = (this.deps.now ?? Date.now)();
    for (const e of entries) {
      const k = keyOf(e);
      if (e.sessions.some((s) => this.deps.isRunning(s))) { this.idleSince.delete(k); continue; }
      const since = this.idleSince.get(k);
      if (since === undefined) { this.idleSince.set(k, now); continue; }
      if (now - since < minutes * 60_000) continue;
      await this.release(e, minutes);
    }
  }

  private async release(e: LedgerEntry, minutes: number): Promise<void> {
    const lm = new LmStudio(e.origin, { fetch: this.deps.fetch });
    const models = await lm.list();
    // つながらない間は記録も残して次の見回りに回す。
    if (!models) return;
    // 一覧を待つ間に、使う会話が動き出していないかをもう一度見る。
    if (readLedger(this.deps.home).find((x) => keyOf(x) === keyOf(e))?.sessions.some((s) => this.deps.isRunning(s))) { this.idleSince.delete(keyOf(e)); return; }
    const gone = !models.some((m) => m.instances.some((x) => x.id === e.instanceId));
    if (!gone) {
      try {
        await lm.unload(e.instanceId);
      } catch (err) {
        (this.deps.log ?? console.warn)(`[idle-unload] ${e.model}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    // 外す間に書かれた記録を落とさないよう、読み直して 1 件だけ消す。
    writeLedger(this.deps.home, readLedger(this.deps.home).filter((x) => keyOf(x) !== keyOf(e)));
    this.idleSince.delete(keyOf(e));
    if (!gone) this.deps.announce(e.model, minutes);
  }
}
