import type { Db } from '../db/open.ts';

/**
 * 放っておかれた提案の片付けの見張り（2026-10-13 の決定、知らせの 9d）。
 * 片付けそのもの（7 日たった Done の提案を確定し、Paused の提案を消す）は states.ts の expireCandidates が行う。
 * ここは、いつ回すかと、入れた直後に 1 度だけ知らせるかを決める。
 *
 * この版を入れた直後の 1 回目は、溜まっていた提案がまとめて確定することがある。黙って起きないよう、確定した件数をトーストで 1 度だけ知らせる。
 * トーストは今つながっている画面にしか届かないので、1 回目は画面がつながるまで片付けを待つ。
 * 2 回目からは、確定する前に行に「あと N 日で確定」が出ているので、知らせずに片付ける。
 * 1 回目を済ませた印は、端末だけの表（settings_local）に置く。開き直しても 2 度は知らせない。
 */
export type CandidateExpiryDeps = {
  /** 片付ける（states.ts の expireCandidates）。 */
  expire: (now: number) => { confirmed: string[]; dropped: string[] };
  /** 1 回目を済ませたか。 */
  announced: () => boolean;
  /** 1 回目を済ませた印を付ける。 */
  markAnnounced: () => void;
  /** いまつながっている画面の数。 */
  clients: () => number;
  /** 確定した件数を知らせる。 */
  announce: (n: number) => void;
  now?: () => number;
  log?: (message: string) => void;
};

export class CandidateExpiryWatch {
  constructor(private readonly deps: CandidateExpiryDeps) {}

  /** 1 回見回る。失敗は投げずに記録へ残す（次の見回りでまた試す）。 */
  tick(): void {
    const first = !this.deps.announced();
    if (first && this.deps.clients() === 0) return;
    try {
      const { confirmed } = this.deps.expire(this.deps.now?.() ?? Date.now());
      if (first) {
        if (confirmed.length > 0) this.deps.announce(confirmed.length);
        this.deps.markAnnounced();
      }
    } catch (e) {
      (this.deps.log ?? console.error)(`[candidate-expiry] 放っておかれた提案を片付けられませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** 1 回目を済ませた印の鍵（settings_local）。 */
export const EXPIRY_ANNOUNCED_KEY = 'candidateExpiry.announced';

export function expiryAnnounced(db: Db): boolean {
  return db.prepare('select 1 from settings_local where key = ?').get(EXPIRY_ANNOUNCED_KEY) !== undefined;
}

export function markExpiryAnnounced(db: Db): void {
  db.prepare("insert into settings_local (key, value) values (?, '1') on conflict(key) do update set value = excluded.value").run(EXPIRY_ANNOUNCED_KEY);
}
