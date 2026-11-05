import {
  PEER_LAUNCH_TTL_MS,
  PEER_OUTBOX_LIMIT,
  PEER_RESULTS_MAX,
  PEER_RESULTS_PAGE,
  type PeerLaunchApi,
  type PeerLaunchIncoming,
  type PeerLaunchPut,
  type PeerLaunchState,
  type PeerLaunchStatus,
  type PeerOutboxResponse,
  type PeerResultAck,
  type PeerResultPut,
  type PeerResultsResponse,
} from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { CloudError } from '../../sync/client.ts';
import { PeerSshUnsupportedError } from './client.ts';
import type { PeerInbox } from '../endpoint.ts';

/** 受けた頼みと結果の行を残す長さ。Worker の行の保持（7 日）に揃える。 */
export const PEER_SSH_KEEP_MS = 7 * 24 * 60 * 60_000;

type Row = { id: string; from_device: string; sealed: string; status: string; sealed_answer: string | null; created_at: number; updated_at: number };

/**
 * SSH のトンネル越しに受けた頼みの置き場（`/peer` の受け口）。
 * Worker の peer_launches と peer_results の代わりを、手元の表（peer_ssh_requests と peer_ssh_results）で持つ。
 * 意味は Worker と同じである。
 * - 同じ ID の再送は冪等で、今の状態を返す。ほかの送り手の ID と重なれば conflict。
 * - 受け取られないまま PEER_LAUNCH_TTL_MS を過ぎたら expired。
 * - 結果の行は送り手の頼みのものだけを返し、頼みでなければ null。
 *
 * 頼みを受けたらすぐ onReceive の聞き手へ渡す（呼び鈴が SSH には無いので、受けたらその場で処理する）。
 * 聞き手は PeerLaunchInbox.receive で、claim・answer・postResult は api（手元の PeerLaunchApi）を通る。トンネルの向こうへは送らない。
 */
export class SshPeerInbox implements PeerInbox {
  private receiver: ((l: PeerLaunchIncoming) => void) | null = null;

  constructor(private readonly db: Db, private readonly selfId: string, private readonly now: () => number) {}

  /** 頼みを受けたときの聞き手。 */
  onReceive(cb: ((l: PeerLaunchIncoming) => void) | null): void {
    this.receiver = cb;
  }

  /** SSH で受けた頼みか（結果をどの口へ書くかの判定）。 */
  has(id: string): boolean {
    return !!this.db.prepare('select 1 from peer_ssh_requests where id = ?').get(id);
  }

  /** 手元の PeerLaunchApi。PeerLaunchInbox と PeerRelay が使う。put、outbox、results は呼ぶ側の口で、ここでは使わない。 */
  readonly api: PeerLaunchApi = {
    put: () => Promise.reject(new PeerSshUnsupportedError('put')),
    outbox: () => Promise.reject(new PeerSshUnsupportedError('outbox')),
    results: () => Promise.reject(new PeerSshUnsupportedError('results')),
    claim: async (id) => {
      const r = this.row(id);
      if (!r || this.stateOf(r) !== 'pending') return false;
      this.db.prepare("update peer_ssh_requests set status = 'claimed', updated_at = ? where id = ? and status = 'pending'").run(this.now(), id);
      return true;
    },
    answer: async (id, ok, sealedAnswer) => {
      const r = this.row(id);
      if (!r) throw new CloudError(404, 'not found');
      if (r.status !== 'claimed') throw new CloudError(409, 'not claimed');
      this.db.prepare('update peer_ssh_requests set status = ?, sealed_answer = ?, updated_at = ? where id = ?').run(ok ? 'started' : 'failed', sealedAnswer, this.now(), id);
    },
    postResult: async (id, body: PeerResultPut): Promise<PeerResultAck> => {
      const r = this.row(id);
      if (!r) throw new CloudError(404, 'not found');
      const dup = this.db.prepare('select 1 from peer_ssh_results where request_id = ? and seq = ?').get(id, body.seq);
      if (dup) return { ok: true, duplicate: true };
      const n = (this.db.prepare('select count(*) as n from peer_ssh_results where request_id = ?').get(id) as { n: number }).n;
      if (n >= PEER_RESULTS_MAX) throw new CloudError(429, 'too many results');
      const t = this.now();
      this.db.prepare('insert into peer_ssh_results (request_id, seq, sealed, created_at) values (?, ?, ?, ?)').run(id, body.seq, body.sealed, t);
      this.db.prepare('update peer_ssh_requests set updated_at = ? where id = ?').run(t, id);
      return { ok: true, duplicate: false };
    },
  };

  async put(from: string, body: PeerLaunchPut & { from: string }): Promise<PeerLaunchStatus | 'conflict'> {
    this.prune();
    const old = this.row(body.id);
    if (old) return old.from_device === from ? this.statusOf(old) : 'conflict';
    const t = this.now();
    this.db.prepare('insert into peer_ssh_requests (id, from_device, sealed, created_at, updated_at) values (?, ?, ?, ?, ?)').run(body.id, from, body.sealed, t, t);
    const cb = this.receiver;
    if (cb) {
      try { cb({ id: body.id, from, createdAt: t, sealed: body.sealed }); } catch (e) { console.error('[peer] could not hand over an SSH launch request', e instanceof Error ? e.constructor.name : typeof e); }
    }
    return this.statusOf(this.row(body.id)!);
  }

  async outbox(from: string, since: number): Promise<PeerOutboxResponse> {
    const rows = this.db
      .prepare('select * from peer_ssh_requests where from_device = ? and updated_at >= ? order by updated_at, id limit ?')
      .all(from, since, PEER_OUTBOX_LIMIT) as Row[];
    return { now: this.now(), launches: rows.map((r) => this.statusOf(r)) };
  }

  async results(from: string, id: string, after: number): Promise<PeerResultsResponse | null> {
    const r = this.row(id);
    if (!r || r.from_device !== from) return null;
    const rows = this.db
      .prepare('select seq, sealed, created_at from peer_ssh_results where request_id = ? and seq > ? order by seq limit ?')
      .all(id, after, PEER_RESULTS_PAGE + 1) as { seq: number; sealed: string; created_at: number }[];
    return { results: rows.slice(0, PEER_RESULTS_PAGE).map((x) => ({ seq: x.seq, sealed: x.sealed, createdAt: x.created_at })), more: rows.length > PEER_RESULTS_PAGE };
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('select * from peer_ssh_requests where id = ?').get(id) as Row | undefined;
  }

  private stateOf(r: Row): PeerLaunchState {
    if (r.status === 'pending' && this.now() - r.created_at > PEER_LAUNCH_TTL_MS) return 'expired';
    return r.status as PeerLaunchState;
  }

  private statusOf(r: Row): PeerLaunchStatus {
    const seq = (this.db.prepare('select max(seq) as m from peer_ssh_results where request_id = ?').get(r.id) as { m: number | null }).m ?? 0;
    return { id: r.id, to: this.selfId, status: this.stateOf(r), sealedAnswer: r.sealed_answer, resultSeq: seq, updatedAt: r.updated_at };
  }

  private prune(): void {
    const cut = this.now() - PEER_SSH_KEEP_MS;
    try {
      this.db.prepare('delete from peer_ssh_results where request_id in (select id from peer_ssh_requests where updated_at < ?)').run(cut);
      this.db.prepare('delete from peer_ssh_requests where updated_at < ?').run(cut);
    } catch (e) {
      console.error('[peer] could not prune SSH launch records', e instanceof Error ? e.constructor.name : typeof e);
    }
  }
}
