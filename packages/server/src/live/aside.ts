import type { Db } from '../db/open.ts';
import type { LiveSession } from '../provider/claude-code/types.ts';
import { readEvents } from '../transcript/read.ts';
import { LiveDigester } from './digest.ts';

/**
 * ターンが終わってから、裏だけと見なすまでの間。
 * 裏の無いターンでも、本文にターンの終わりが書かれてから登録が休みへ移るまで少しかかる。その間に薄いオレンジが一瞬灯らないようにする。
 */
export const ASIDE_SETTLE_MS = 2000;
/** ターンの終わりを探すとき、主線の新しい側から見る件数。記録（meta）は数えない。 */
const LOOK_BACK = 40;
/** 本体が動いた印になる種類。system は中身を読んで決める（バックグラウンドのタスクの知らせは本体を起こす）。 */
const ACTIVE = new Set(['user', 'assistant', 'thinking', 'tool_call', 'tool_result']);

/**
 * 本体（指揮役）は入力を受け付けていて、裏でサブエージェントなどだけが動いているかを、登録と本文から推す。
 * Claude の登録は、裏のサブエージェントが動く間は本体が空いていても busy としか書かない（シェルだけなら shell と書く）。
 * そこで、busy のまま次のすべてを満たすものに、裏だけの印（shell は偽、agents は digest の running の数）を付ける。
 * - 主線の最後のターンが終わっている（turn_duration の後に、指示、知らせ、返答、手が無い）。
 * - その終わりが、動きが最後に変わった時刻（statusAt）より後である。新しい指示を送った直後は、指示がまだ索引に載っていないことがある。
 * - 終わってから ASIDE_SETTLE_MS 経っている。
 * 状態は busy のまま変えない。自動の停止、引き取りの断り、停止の確認は作業中として働き続ける。
 */
export class AsideReader {
  private readonly ends = new Map<string, { key: number | null; at: number | null }>();
  private readonly digester: LiveDigester;
  constructor(private readonly db: Db, digester?: LiveDigester) {
    this.digester = digester ?? new LiveDigester(db);
  }

  /**
   * 1 件の読み取りが失敗しても（本文のファイルが消えた直後など）、その件は印を付けずに返し、投げない。
   * 登録の読み直しの中で呼ばれるので、投げると全部の動きの知らせが止まる。
   */
  apply(live: LiveSession[], now: number): LiveSession[] {
    return live.map((l) => {
      try { return this.one(l, now); } catch { return l; }
    });
  }

  private one(l: LiveSession, now: number): LiveSession {
    if (l.status !== 'busy' || l.aside) return l;
    const sessionId = this.sessionIdOf(l.sessionId);
    if (!sessionId) return l;
    const end = this.turnEndedAt(sessionId);
    if (end === null || now - end < ASIDE_SETTLE_MS) return l;
    if (l.statusAt !== undefined && end < l.statusAt) return l;
    const agents = this.digester.digest(sessionId).agents.filter((a) => a.state === 'running').length;
    return { ...l, aside: { shell: false, agents } };
  }

  private sessionIdOf(providerSessionId: string): string | null {
    return (this.db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(providerSessionId) as { id: string } | undefined)?.id ?? null;
  }

  /**
   * 主線の最後のターンが終わった時刻。終わっていない（終わりの後に本体が動いた）か、決められなければ null。
   * 500 ミリ秒ごとに呼ばれるので、主線の最後の seq が変わらない間は読み直さない。
   * 主線は索引の式と同じ ifnull(parent_agent, '') = '' で絞る。parent_agent is null と書くと索引に乗らず、毎回セッションの全行を見に行く。
   */
  private turnEndedAt(sessionId: string): number | null {
    const key = (this.db.prepare("select max(seq) m from event_index where session_id = ? and ifnull(parent_agent, '') = ''").get(sessionId) as { m: number | null }).m;
    const hit = this.ends.get(sessionId);
    if (hit && hit.key === key) return hit.at;
    const at = this.readEnd(sessionId);
    this.ends.set(sessionId, { key, at });
    return at;
  }

  private readEnd(sessionId: string): number | null {
    const rows = this.db.prepare("select seq, kind from event_index where session_id = ? and ifnull(parent_agent, '') = '' and kind != 'meta' order by seq desc limit ?").all(sessionId, LOOK_BACK) as { seq: number; kind: string }[];
    for (const r of rows) {
      if (ACTIVE.has(r.kind)) return null;
      if (r.kind !== 'system') continue;
      const ev = readEvents(this.db, sessionId, { fromSeq: r.seq, limit: 1 }).events.find((e) => e.seq === r.seq);
      if (!ev || ev.kind !== 'system') continue;
      if (ev.text.trimStart().startsWith('<task-notification>')) return null;
      if (ev.subtype === 'turn_duration') return ev.ts ?? null;
    }
    return null;
  }
}
