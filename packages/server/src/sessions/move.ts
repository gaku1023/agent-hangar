import { touchRow } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { MessageError, msg, type Message } from '../i18n/message.ts';
import { stmt } from '../indexer/statements.ts';
import { setSessionPlacement } from './states.ts';

/**
 * セッションを別のプロジェクトへ移す（docs/design.md の「プロジェクトの同定」の移動の決まり）。
 *
 * 動かすのは hangar 上の所属だけで、本文（jsonl）と sessions.cwd は元のままにする。
 * 移した先は利用者が決めたことなので、session_states.project_id に置く。利用者の操作でしか書かれないので、索引の書き直しや後勝ちで戻らない。
 * sessions.project_id は一覧や絞り込みが読む所属で、移した先があればそれに合わせ直す。
 * 合わせ直すのは、索引（indexer/indexFile.ts の applySessionFacts）、自動の振り分け（projects/registry.ts の assignSessions と assignSession）、
 * 同期の取り込み（sync/apply.ts）のあとである。
 * 移した先が一覧から削除されたプロジェクトなら、移した印は無いものとして読み、cwd からの自動の振り分けに戻る。
 */

/** 移動の誤り。status は HTTP の応答の番号で、message はトーストにそのまま出せる一文である。 */
export class MoveError extends MessageError {
  constructor(readonly status: 400 | 404, text: Message) {
    super(text);
    this.name = 'MoveError';
  }
}

/** 生きているプロジェクトか。 */
function liveProject(db: Db, projectId: string): boolean {
  return db.prepare('select 1 from projects where id = ? and deleted_at is null').get(projectId) !== undefined;
}

/**
 * 利用者が移した先。移していない、移した先が一覧から削除された、状態の行が論理削除されたときは null。
 * null のときの所属は、cwd からの自動の振り分けに任せる。
 * 索引と同期の取り込みが行ごとに引くので、文は使い回す（indexer/statements.ts）。
 */
export function pinnedProjectOf(db: Db, sessionId: string): string | null {
  const r = stmt(db, `select st.project_id from session_states st join projects p on p.id = st.project_id and p.deleted_at is null
    where st.session_id = ? and st.deleted_at is null and st.project_id is not null`).get(sessionId) as { project_id: string } | undefined;
  return r?.project_id ?? null;
}

/**
 * sessions.project_id を移した先に合わせ直す。この端末の表だけを直し、変更ログには積まない。合わせ直したら true。
 * 同期の取り込み（sync/apply.ts）が、届いた行のあとに呼ぶ。届いた行を押し返さないためである。
 * どの PC も移した印（session_states）を受け取れば自分で合わせ直すので、ここで直した値を上げ直す必要は無い。
 * 次にこの端末が sessions の行を書くとき（索引など）に、直した値が一緒に上がる。
 * 入った先と出た先のプロジェクトは、行は変わらないが中身（セッションの数）が変わるので、名指しして配り直してもらう。
 */
export function alignSessionProject(db: Db, sessionId: string): boolean {
  const pin = pinnedProjectOf(db, sessionId);
  if (pin === null) return false;
  const cur = db.prepare('select project_id from sessions where id = ?').get(sessionId) as { project_id: string | null } | undefined;
  if (!cur || cur.project_id === pin) return false;
  db.prepare('update sessions set project_id = ? where id = ?').run(pin, sessionId);
  touchRow(db, 'sessions', sessionId);
  touchRow(db, 'projects', pin);
  if (cur.project_id !== null) touchRow(db, 'projects', cur.project_id);
  return true;
}

/**
 * セッションを projectId へ移す。移した先を session_states に書き、sessions.project_id も同じ値にする。
 * 無いセッション、無いプロジェクト、一覧から削除したプロジェクトは MoveError（404）で断り、何も書かない。
 * いまの所属と同じ先でも、移した印は書く。以後、cwd からの自動の振り分けで動かなくなる。
 */
export function moveSession(db: Db, deviceId: string, sessionId: string, projectId: string): void {
  const s = db.prepare('select * from sessions where id = ? and deleted_at is null').get(sessionId) as Record<string, unknown> | undefined;
  if (!s) throw new MoveError(404, msg('session.error.notFound'));
  if (!liveProject(db, projectId)) throw new MoveError(404, msg('session.move.projectNotFound'));
  const from = s.project_id as string | null;
  db.transaction(() => {
    setSessionPlacement(db, deviceId, sessionId, projectId);
    if (from !== projectId) upsertShared(db, 'sessions', { ...s, project_id: projectId }, deviceId);
    // 入った先と出た先は、行は変わらないが中身（セッションの数、最終の活動）が変わる。
    touchRow(db, 'projects', projectId);
    if (from !== null && from !== projectId) touchRow(db, 'projects', from);
  })();
}

/**
 * fromId へ移したセッションの移した先を、intoId へ付け替える（null なら移した印を外す）。付け替えた件数を返す。
 * プロジェクトをまとめる（mergeProjects）ときは、まとめ先へ付け替える。一覧から削除する（unlink）ときは null に戻す。
 * 呼び手のトランザクションの中で呼ぶ。
 */
export function repointPins(db: Db, deviceId: string, fromId: string, intoId: string | null): number {
  const ids = (db.prepare('select session_id from session_states where project_id = ? and deleted_at is null').all(fromId) as { session_id: string }[]).map((r) => r.session_id);
  for (const id of ids) setSessionPlacement(db, deviceId, id, intoId);
  return ids.length;
}

/**
 * 移した印があれば、それを projectId へ書き換える。印が無ければ何もしない。
 * セッションを新しいプロジェクトへ昇格する（projects/promote.ts）ときに呼ぶ。
 * 印を残したままだと、合わせ直しが昇格の前の所属へ戻してしまう。
 */
export function repinIfPinned(db: Db, deviceId: string, sessionId: string, projectId: string): void {
  const r = db.prepare('select project_id from session_states where session_id = ? and deleted_at is null').get(sessionId) as { project_id: string | null } | undefined;
  if (r?.project_id != null && r.project_id !== projectId) setSessionPlacement(db, deviceId, sessionId, projectId);
}
