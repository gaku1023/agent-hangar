import type { LiveSessionDto } from '@agent-hangar/shared';
import type { LiveSource } from './types.ts';

/** 実行中の一覧に印を足す 1 段。now は読み直し 1 回の時刻で、どの段にも同じ値を渡す。 */
export type LiveEnrich = (live: LiveSessionDto[], now: number) => LiveSessionDto[];

/**
 * 実行中の一覧を、エージェントごとの写し（agent/types.ts の LiveSource）から 1 つにまとめる。
 * 一覧を読む側（配る層、索引、要約、スマホ、run の管理）は、どのエージェントの写しかを知らずに、ここの current() と onChange だけを見る。
 *
 * 足し付けの鎖（裏だけの印、許可の中身）は、ここが持つ。
 * 写しは、読み直しのたびに enrich を通してから、変わったかを見る。
 * 本文の索引が進んだだけでも印は変わるので、写しの元（登録のファイルなど）が変わらなくても、次の読み直しで知らせられるようにするためである。
 * だから、ここで読み終えた一覧に足すのではなく、写しの側から呼んでもらう。
 */
export class LiveHub {
  private readonly sources: LiveSource[] = [];
  private readonly listeners = new Set<(live: LiveSessionDto[]) => void>();
  private readonly chain: readonly LiveEnrich[];
  private readonly now: () => number;

  constructor(o: { enrich?: readonly LiveEnrich[]; now?: () => number } = {}) {
    this.chain = o.enrich ?? [];
    this.now = o.now ?? Date.now;
  }

  /** 写しを 1 つ加える。その写しが変わるたびに、合わせた一覧で onChange を出す。 */
  add(source: LiveSource): void {
    this.sources.push(source);
    source.onChange(() => {
      const live = this.current();
      for (const cb of this.listeners) cb(live);
    });
  }

  /** 足し付けの鎖を順に通す。写しが読み直しのたびに呼ぶ。 */
  enrich(live: LiveSessionDto[]): LiveSessionDto[] {
    const now = this.now();
    return this.chain.reduce((l, f) => f(l, now), live);
  }

  start(): void { for (const s of this.sources) s.start(); }
  stop(): void { for (const s of this.sources) s.stop(); }
  /** 次の読み直しを ms 後へ繰り上げる。足し付けの結果が写しの外で変わったとき（hook から許可の中身が届いたとき）に呼ぶ。 */
  kick(ms: number): void { for (const s of this.sources) s.kick(ms); }

  /**
   * 合わせた一覧。並びはセッションの id の順である。
   * 写しが 1 つなら、その写しをそのまま返す。写しの中身は変わったときだけ差し替わるので、受け手が同じものかで変化を見られる。
   */
  current(): LiveSessionDto[] {
    if (this.sources.length === 1) return this.sources[0]!.current();
    return this.sources.flatMap((s) => s.current()).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  /** そのセッション（エージェントの側の id）が、どれかの写しに載っているか。 */
  isLive(providerSessionId: string): boolean {
    return this.current().some((l) => l.sessionId === providerSessionId);
  }

  onChange(cb: (live: LiveSessionDto[]) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
}
