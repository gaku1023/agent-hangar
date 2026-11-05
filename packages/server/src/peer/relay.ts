import {
  E2eOpenError,
  sealPeerResult,
  type LiveSessionDto,
  type PeerKeyring,
  type PeerLaunchApi,
  type PeerLaunchResult,
  type PeerRoute,
  type PeerStopReason,
} from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { closeSpawn, relayTarget } from '../sessions/spawns.ts';
import { CloudError } from '../sync/client.ts';
import type { PeerLaunchStarted } from './launchInbox.ts';

/** 最後の返答の上限（文字数）。呼び出し元へ送り込む 1 通（7800 字）に、要約と見出しと一緒に収めるための長さである。 */
export const PEER_REPLY_MAX = 6000;
/** ターンの始まりが見えるまで待つ長さ。越えたら、ターンにならない入力（斜線コマンドなど）として印を外す。 */
export const PEER_TURN_START_GRACE_MS = 5 * 60_000;
/** 止まりが見えてから、返答が本文に載るまで待つ長さ。本文の索引は登録の状態より少し遅れる。 */
export const PEER_REPLY_SETTLE_MS = 5000;
/** 届いた結果の控えと、終わった会話の行を残す長さ。Worker の行の保持（7 日）に揃える。 */
export const PEER_RELAY_KEEP_MS = 7 * 24 * 60 * 60_000;

export type PeerRelayDeps = {
  db: Db;
  deviceId: string;
  now: () => number;
  /** いまの実行中の一覧（agent/liveHub.ts の LiveHub.current）。 */
  live: () => LiveSessionDto[];
  ring: () => Promise<PeerKeyring>;
  /** 結果の行を書く口。同期が動いていなければ null。 */
  api: () => Pick<PeerLaunchApi, 'postResult'> | null;
  /** いま結果を送ってよいか（同期が動き、Worker の版が足りている）。 */
  canProcess: () => boolean;
  /** 会話の最後の返答（どのエージェントでも本文の索引から読む）。ts は返答の時刻で、分からなければ null。 */
  lastReply: (sessionId: string) => { text: string; ts: number | null } | null;
  /** 会話の題と、要約と状態（set_session_summary の値）。会話が読めなければ null を返してよい。 */
  describe: (sessionId: string) => { title: string | null; summary: string | null; status: string | null } | null;
  /** 返答が本文に載るのを待つ間の読み直しを頼む。省けば呼び出し元の check が来るまで待つ。 */
  schedule?: (fn: () => void, ms: number) => void;
};

type RelayRow = { session_id: string; request_id: string; from_device: string; seq: number; armed_at: number | null; ended: number; title: string; created_at: number };

/** 印を付けたターンの、メモリ上の様子。印を付け直すたびに作り直す。 */
type Watch = { armedAt: number; seenBusy: boolean; emitted: 'permission' | 'question' | null; stop: { key: string; since: number } | null };

const kindOf = (e: unknown): string => `${e instanceof Error ? e.constructor.name : typeof e}${typeof (e as { status?: unknown } | null)?.status === 'number' ? ` ${(e as { status: number }).status}` : ''}`;

/**
 * 別の PC から起こされた会話の、ターンの止まりを見張って、結果を呼び出し元へ書く（D12、D13、D15）。
 *
 * 返すのは「呼び出し元が入れたターン」だけである。印は 2 つの時に付ける。
 * 起動の頼みを受けて会話を起こしたとき（prompt があれば、onStarted）と、send の頼みで入力を入れる直前（arm）である。
 * 印は peer_relay.armed_at に残し、idle で止まって結果を書いたら外す。利用者が直接打ったターンは、印が無いので返らない。
 * ターンの始まりは、登録が busy になったか、始まりの印より新しい statusAt を持つ（最後の返答も印より新しい）ことで確かめる。
 * 始まりが見えないまま PEER_TURN_START_GRACE_MS を過ぎたら、ターンにならなかった入力として印を外す。
 *
 * 止まるたびに結果を 1 件書く。idle は印を外す。質問と許可の waiting は印を残し、そのあとの idle でもう 1 件書く。
 * 結果の連番（seq）は頼みごとに 1 から数え、peer_relay.seq に持つ。結果の中身は peer_relay_out に控え、Worker に届くまで同じ seq で送り直す。
 * プロセスの終わり（onProcessEnded）は stopped を 1 件書いて印を外し、結び付きは残す。
 * 会話の終わり（onEnded）は、会話が Done になったとき（check が見つける）と、会話を消す前に呼ぶ。ended を 1 度だけ書き、結び付きを閉じる（closeSpawn）。
 * 同じ PC の中の入れ子、切り離された結び付き、閉じた結び付きでは何も書かない（relayTarget が null）。
 */
export class PeerRelay {
  private watches = new Map<string, Watch>();
  private tail: Promise<unknown> = Promise.resolve();
  private recheck = false;

  constructor(private readonly deps: PeerRelayDeps) {}

  /** 頼みで起こした会話を覚える。prompt があれば最初のターンに印を付ける。 */
  onStarted(e: PeerLaunchStarted): void {
    const now = this.deps.now();
    this.deps.db
      .prepare('insert or replace into peer_relay (session_id, request_id, from_device, seq, armed_at, ended, title, created_at) values (?, ?, ?, 0, ?, 0, ?, ?)')
      .run(e.sessionId, e.requestId, e.from, e.hasPrompt ? now : null, e.title, now);
    this.watches.delete(e.sessionId);
  }

  /** send で入力を入れる直前に印を付ける。結果を返す相手の会話でなければ false。 */
  arm(sessionId: string): boolean {
    const r = this.deps.db.prepare('update peer_relay set armed_at = ? where session_id = ? and ended = 0').run(this.deps.now(), sessionId);
    this.watches.delete(sessionId);
    return r.changes > 0;
  }

  /** 入力を入れられなかったときに、付けた印を戻す。 */
  disarm(sessionId: string): void {
    this.deps.db.prepare('update peer_relay set armed_at = null where session_id = ?').run(sessionId);
    this.watches.delete(sessionId);
  }

  /** 登録が変わったときに呼ぶ。印のある会話の止まりを見て、結果を書く。 */
  check(): void {
    const { db } = this.deps;
    try {
      // Done にされた会話は、ended を返して切る。Active に戻しても、切った後なので返さない。
      const done = db.prepare("select r.session_id from peer_relay r join session_states st on st.session_id = r.session_id where r.ended = 0 and st.status = 'done'").all() as { session_id: string }[];
      for (const d of done) this.onEnded(d.session_id);
    } catch (e) {
      console.error('[peer] could not look for done sessions', kindOf(e));
    }
    const rows = db.prepare('select * from peer_relay where armed_at is not null and ended = 0').all() as RelayRow[];
    if (rows.length === 0) return;
    const now = this.deps.now();
    const live = this.deps.live();
    let wait = false;
    for (const row of rows) {
      try {
        if (this.checkOne(row, live, now)) wait = true;
      } catch (e) {
        console.error('[peer] could not check a relayed turn', kindOf(e));
      }
    }
    if (wait && this.deps.schedule && !this.recheck) {
      this.recheck = true;
      this.deps.schedule(() => { this.recheck = false; this.check(); }, 1000);
    }
  }

  /** 1 件を見る。返答が載るのを待っているなら true。 */
  private checkOne(row: RelayRow, live: LiveSessionDto[], now: number): boolean {
    const { db, deviceId } = this.deps;
    const armedAt = row.armed_at!;
    const link = relayTarget(db, deviceId, row.session_id);
    if (!link || link.parentDeviceId !== row.from_device) {
      this.disarm(row.session_id);
      return false;
    }
    let w = this.watches.get(row.session_id);
    if (!w || w.armedAt !== armedAt) this.watches.set(row.session_id, (w = { armedAt, seenBusy: false, emitted: null, stop: null }));
    const expire = (): false => {
      if (!w.seenBusy && now - armedAt > PEER_TURN_START_GRACE_MS) this.disarm(row.session_id);
      return false;
    };
    const l = this.liveOf(row.session_id, live);
    if (!l) return expire();
    if (l.status === 'busy') {
      w.seenBusy = true;
      w.emitted = null;
      w.stop = null;
      return false;
    }
    const reply = this.deps.lastReply(row.session_id);
    const fresh = reply !== null && (reply.ts === null || reply.ts >= armedAt);
    // 始まりが見えたか。登録の起動直後の idle を終わりと読まないために、statusAt だけの根拠では新しい返答も要る。
    const started = w.seenBusy || (l.status === 'waiting' && l.statusAt !== undefined && l.statusAt > armedAt) || (l.statusAt !== undefined && l.statusAt > armedAt && fresh);
    if (!started) return expire();
    const reason: PeerStopReason = l.status === 'waiting' ? (l.waitingFor === 'permission' ? 'permission' : 'question') : 'idle';
    if (reason !== 'idle' && w.emitted === reason) return false;
    if (!w.stop || w.stop.key !== reason) w.stop = { key: reason, since: now };
    if (!fresh && now - w.stop.since < PEER_REPLY_SETTLE_MS) return true;
    this.emit(row, reason, fresh ? reply : null);
    if (reason === 'idle') this.disarm(row.session_id);
    else { w.emitted = reason; w.stop = null; }
    return false;
  }

  private liveOf(sessionId: string, live: LiveSessionDto[]): LiveSessionDto | null {
    const r = this.deps.db.prepare('select provider, provider_session_id from sessions where id = ?').get(sessionId) as { provider: string; provider_session_id: string } | undefined;
    return (r && live.find((x) => x.sessionId === r.provider_session_id && (x.agent ?? 'claude-code') === r.provider)) || null;
  }

  /**
   * プロセスが終わった（利用者が閉じた、落ちた、lost、stop_session）。
   * 返し続けている結び付きなら、stopped を 1 件書き、印を外す。結び付きは残すので、再開して send が入ればまた返る。投げない。
   */
  onProcessEnded(sessionId: string): void {
    try {
      const { db, deviceId } = this.deps;
      const row = db.prepare('select * from peer_relay where session_id = ?').get(sessionId) as RelayRow | undefined;
      if (!row || row.ended === 1) return;
      const link = relayTarget(db, deviceId, sessionId);
      if (!link || link.parentDeviceId !== row.from_device) return;
      this.emit(row, 'stopped', this.deps.lastReply(sessionId));
      this.disarm(sessionId);
    } catch (e) {
      console.error('[peer] could not write the stopped result', kindOf(e));
    }
  }

  /**
   * 会話が Done になった（check が見つける）か、消える（削除の前）。
   * 返し続けている結び付きなら、ended を 1 度だけ書いて閉じる。ほかは何もしない。投げない。
   */
  onEnded(sessionId: string): void {
    try {
      const { db, deviceId } = this.deps;
      const row = db.prepare('select * from peer_relay where session_id = ?').get(sessionId) as RelayRow | undefined;
      if (!row || row.ended === 1) return;
      const link = relayTarget(db, deviceId, sessionId);
      if (!link || link.parentDeviceId !== row.from_device) return;
      const reply = this.deps.lastReply(sessionId);
      db.transaction(() => {
        this.emit(row, 'ended', reply);
        db.prepare('update peer_relay set ended = 1, armed_at = null where session_id = ?').run(sessionId);
        closeSpawn(db, deviceId, sessionId, this.deps.now());
      })();
      this.watches.delete(sessionId);
      void this.flush();
    } catch (e) {
      console.error('[peer] could not write the ended result', kindOf(e));
    }
  }

  /** 結果を 1 件、連番を採って控える。送るのは flush。 */
  private emit(row: RelayRow, reason: PeerStopReason, reply: { text: string; ts: number | null } | null): void {
    const { db } = this.deps;
    const chars = [...(reply?.text ?? '').trim()];
    const truncated = chars.length > PEER_REPLY_MAX;
    const d = this.deps.describe(row.session_id);
    const result: PeerLaunchResult = {
      v: 1, at: this.deps.now(), sessionId: row.session_id, title: d?.title || row.title,
      reason, summary: d?.summary ?? null, status: d?.status ?? null,
      lastReply: (truncated ? chars.slice(0, PEER_REPLY_MAX) : chars).join(''), truncated,
    };
    db.transaction(() => {
      const cur = db.prepare('select seq from peer_relay where session_id = ?').get(row.session_id) as { seq: number };
      const seq = cur.seq + 1;
      db.prepare('update peer_relay set seq = ? where session_id = ?').run(seq, row.session_id);
      db.prepare('insert into peer_relay_out (request_id, seq, payload, sent, created_at) values (?, ?, ?, 0, ?)').run(row.request_id, seq, JSON.stringify(result), this.deps.now());
    })();
    void this.flush();
  }

  /** 控えた結果のうち、まだ届いていないものを順に送る。投げない。 */
  flush(): Promise<void> {
    const p = this.tail.then(() => this.flushOnce());
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async flushOnce(): Promise<void> {
    const { db } = this.deps;
    try {
      const cutoff = this.deps.now() - PEER_RELAY_KEEP_MS;
      db.prepare('delete from peer_relay_out where sent = 1 and created_at < ?').run(cutoff);
      db.prepare('delete from peer_relay where ended = 1 and created_at < ?').run(cutoff);
    } catch (e) {
      console.error('[peer] could not prune relay records', kindOf(e));
    }
    const rows = db
      .prepare('select o.request_id, o.seq, o.payload, r.from_device from peer_relay_out o join peer_relay r on r.request_id = o.request_id where o.sent = 0 order by o.request_id, o.seq')
      .all() as { request_id: string; seq: number; payload: string; from_device: string }[];
    if (rows.length === 0 || !this.deps.canProcess()) return;
    const api = this.deps.api();
    if (!api) return;
    const ring = await this.deps.ring();
    const stuck = new Set<string>();
    for (const r of rows) {
      // 順を守る。同じ頼みの前の結果が届いていなければ、後のは送らない。
      if (stuck.has(r.request_id)) continue;
      const route: PeerRoute = { requestId: r.request_id, from: r.from_device, to: this.deps.deviceId };
      try {
        const sealed = await sealPeerResult(ring, route, r.seq, JSON.parse(r.payload) as PeerLaunchResult);
        await api.postResult(r.request_id, { seq: r.seq, sealed });
      } catch (e) {
        // 頼みが無い、封が大きすぎる、形が違うといった恒久的な断りは、送り直しても変わらないので諦める。
        if (e instanceof CloudError && [400, 403, 404, 410].includes(e.status)) {
          console.warn('[peer] the cloud refused a result; dropped it', kindOf(e));
        } else if (e instanceof E2eOpenError || e instanceof TypeError) {
          console.error('[peer] could not seal a result; dropped it', kindOf(e));
        } else {
          console.error('[peer] could not send a result; will resend', kindOf(e));
          stuck.add(r.request_id);
          continue;
        }
      }
      db.prepare('update peer_relay_out set sent = 1 where request_id = ? and seq = ?').run(r.request_id, r.seq);
    }
  }
}
