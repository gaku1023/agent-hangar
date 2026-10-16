import { newId } from '@agent-hangar/shared';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import type { Db } from '../db/open.ts';

/**
 * 引き継ぎの頼み（takeovers）と応答（takeover_answers）の行の読み書き。
 * 「この PC で再開」が、ほかの PC で動いている会話を止めて引き継ぐための、PC どうしの伝言である。
 * ほかの PC の runs の行は持ち主が 30 秒ごとに書き直して消えるので、頼みは別の共有表で運ぶ。
 *
 * 行の書き手は一つに決まっている。頼みは頼む側の PC だけが書き（取り下げ、force への切り替えも含む）、応答は頼まれた側の PC だけが書く。
 * 行が別なので、頼む側の取り下げと相手の応答は行き違っても消し合わない。
 * 互換の版 6 に届かない Worker へ書かないのは、呼び出し側（同期の流れ）の務めである。ここは手元の表への書き込みだけを持つ。
 */

/** ask は相手の返事を待つ頼み、force は待たずに引き継ぐと決めた印である。 */
export type TakeoverMode = 'ask' | 'force';
export type TakeoverAsk = {
  id: string;
  sessionId: string;
  /** 止めてほしい run（頼まれた側の PC の run）の id。 */
  runId: string;
  targetDevice: string;
  fromDevice: string;
  requestedAt: number;
  mode: TakeoverMode;
  cancelledAt: number | null;
};
/** stopped は頼まれて止めた、not_running は頼みが届いたときすでに動いていなかった。 */
export type TakeoverResult = 'stopped' | 'not_running';
export type TakeoverAnswer = {
  askId: string;
  runId: string;
  result: TakeoverResult;
  answeredAt: number;
  /** 止めたあとに上げた最後の本文の版。頼む側は台帳（files）と突き合わせて、降りきったことを確かめる。 */
  transcriptSha256: string | null;
  transcriptSize: number | null;
};

/** 頼みと応答の行を残す期間。自分が書いた行だけを、これより古くなったら論理削除する。 */
export const TAKEOVER_ROW_TTL_MS = 30 * 86_400_000;

type AskRow = {
  id: string; session_id: string; run_id: string; target_device: string; from_device: string;
  requested_at: number; mode: string; cancelled_at: number | null;
};
type AnswerRow = {
  ask_id: string; run_id: string; result: string; answered_at: number;
  transcript_sha256: string | null; transcript_size: number | null;
};

const toAsk = (r: AskRow): TakeoverAsk => ({
  id: r.id, sessionId: r.session_id, runId: r.run_id, targetDevice: r.target_device, fromDevice: r.from_device,
  requestedAt: r.requested_at, mode: r.mode === 'force' ? 'force' : 'ask', cancelledAt: r.cancelled_at,
});
const toAnswer = (r: AnswerRow): TakeoverAnswer => ({
  askId: r.ask_id, runId: r.run_id, result: r.result === 'stopped' ? 'stopped' : 'not_running', answeredAt: r.answered_at,
  transcriptSha256: r.transcript_sha256, transcriptSize: r.transcript_size,
});

const askColumns = (a: TakeoverAsk): Record<string, unknown> => ({
  id: a.id, session_id: a.sessionId, run_id: a.runId, target_device: a.targetDevice, from_device: a.fromDevice,
  requested_at: a.requestedAt, mode: a.mode, cancelled_at: a.cancelledAt, deleted_at: null,
});

/** 頼みを 1 行書く。書いた行を返す。 */
export function writeAsk(db: Db, self: string, o: { sessionId: string; runId: string; targetDevice: string; mode: TakeoverMode; now: number }): TakeoverAsk {
  const ask: TakeoverAsk = {
    id: newId(), sessionId: o.sessionId, runId: o.runId, targetDevice: o.targetDevice, fromDevice: self,
    requestedAt: o.now, mode: o.mode, cancelledAt: null,
  };
  upsertShared(db, 'takeovers', askColumns(ask), self, 'id', o.now);
  return ask;
}

/** 書き直す。upsertShared は全部の列を渡す必要があるので、今の行に変更を重ねて書く。行が無ければ何もしない。 */
function rewriteAsk(db: Db, self: string, askId: string, now: number, change: Partial<TakeoverAsk>): void {
  const cur = askOf(db, askId);
  if (!cur) return;
  upsertShared(db, 'takeovers', askColumns({ ...cur, ...change }), self, 'id', now);
}

/** 待たずに引き継ぐと決めたとき、同じ行の mode を force にする。 */
export function setAskForce(db: Db, self: string, askId: string, now: number): void {
  rewriteAsk(db, self, askId, now, { mode: 'force' });
}

/** 頼みを取り下げる（取り下げの時刻を入れる）。行は残す。 */
export function cancelAsk(db: Db, self: string, askId: string, now: number): void {
  rewriteAsk(db, self, askId, now, { cancelledAt: now });
}

/** 応答を書く。応答の主キーは頼みの id なので、頼み 1 件に応答は 1 行である。 */
export function writeAnswer(db: Db, self: string, a: TakeoverAnswer): void {
  upsertShared(db, 'takeover_answers', {
    ask_id: a.askId, run_id: a.runId, result: a.result, answered_at: a.answeredAt,
    transcript_sha256: a.transcriptSha256, transcript_size: a.transcriptSize, deleted_at: null,
  }, self, 'ask_id', a.answeredAt);
}

/** 自分あての頼みのうち、取り下げも削除もされておらず、まだ答えていないもの。古い順。 */
export function asksForMe(db: Db, self: string): TakeoverAsk[] {
  const rows = db.prepare(`
    select t.* from takeovers t
    where t.target_device = ? and t.cancelled_at is null and t.deleted_at is null
      and not exists (select 1 from takeover_answers a where a.ask_id = t.id and a.deleted_at is null)
    order by t.requested_at, t.id
  `).all(self) as AskRow[];
  return rows.map(toAsk);
}

/** 頼みの応答。無い、または削除済みなら null。 */
export function answerOf(db: Db, askId: string): TakeoverAnswer | null {
  const r = db.prepare('select * from takeover_answers where ask_id = ? and deleted_at is null').get(askId) as AnswerRow | undefined;
  return r ? toAnswer(r) : null;
}

/** 頼みの行。無い、または削除済みなら null。 */
export function askOf(db: Db, askId: string): TakeoverAsk | null {
  const r = db.prepare('select * from takeovers where id = ? and deleted_at is null').get(askId) as AskRow | undefined;
  return r ? toAsk(r) : null;
}

/**
 * 自分が書いた行のうち、updated_at が TTL より古いものを論理削除して、消した数を返す。
 * ほかの PC が書いた行は、その PC が消す（行の書き手は一つ）。
 */
export function pruneTakeoverRows(db: Db, self: string, now: number): number {
  const cutoff = now - TAKEOVER_ROW_TTL_MS;
  let n = 0;
  for (const [table, pk] of [['takeovers', 'id'], ['takeover_answers', 'ask_id']] as const) {
    const ids = db.prepare(`select ${pk} as k from ${table} where origin_device = ? and deleted_at is null and updated_at < ?`).all(self, cutoff) as { k: string }[];
    for (const { k } of ids) {
      softDeleteShared(db, table, k, self, pk);
      n++;
    }
  }
  return n;
}
