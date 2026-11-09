import { randomUUID } from 'node:crypto';
import { EVENT_BINDINGS_MAX, EVENT_INBOX_KEEP_MS, SCHEDULE_RUNS_KEPT, WAKE_BINDING_TTL_MS, type EventAction, type EventBindingDto, type EventBindingState, type EventSource, type ScheduleRunDto, type ScheduleRunResult } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { MessageError, msg } from '../i18n/message.ts';
import { sessionTitleOf } from '../mobile/feed.ts';

/**
 * 外のできごとで動く結び付けと、その実行の履歴、PR の持ち主（#563）。手元だけの表で同期しない。
 * 秘密（受け箱の秘密鍵と GitHub の webhook の秘密の値）は表にだけ置く。DTO には出さず、引き取る側の行（BindingRow）でだけ読める。
 * 画面への配信（表の知らせ）は、画面の道を作る後続の作業でつなぐ。
 */

type BindingDbRow = {
  id: string; inbox_id: string; inbox_public_key: string; inbox_private_key: string; webhook_id: number | null; hook_secret: string | null;
  source: string; action: string; prompt: string; pass_body: number; allow_authors: string; state: EventBindingState;
  from_session_id: string | null; created_at: number; expires_at: number | null;
};
type RunRow = { id: string; binding_id: string; planned_at: number; started_at: number; ended_at: number | null; result: ScheduleRunResult; session_id: string | null; error: string | null };

/** 引き取る側が使う行。秘密を含むので、画面にも MCP にもログにも渡さない。 */
export type BindingRow = {
  id: string; inboxId: string; inboxPublicKey: string; inboxPrivateKey: string; webhookId: number | null; hookSecret: string | null;
  source: EventSource; action: EventAction; prompt: string; passBody: boolean; allowAuthors: string[]; state: EventBindingState;
  fromSessionId: string | null; createdAt: number; expiresAt: number | null;
};

export type BindingInput = {
  inboxId: string;
  /** 受け箱の X25519 公開鍵（raw の base64url）。 */
  inboxPublicKey: string;
  /** generateInboxKeyPair の privateKey をそのまま置く。 */
  inboxPrivateKey: string;
  /** GitHub の webhook の ID。外の webhook と、まだ付けていない GitHub では持たない。 */
  webhookId?: number;
  hookSecret?: string;
  source: EventSource;
  action: EventAction;
  prompt: string;
  passBody?: boolean;
  allowAuthors?: string[];
  state?: EventBindingState;
  fromSessionId?: string | null;
};

export type BindingPatch = {
  source?: EventSource; action?: EventAction; prompt?: string; passBody?: boolean; allowAuthors?: string[]; state?: EventBindingState;
  webhookId?: number | null; hookSecret?: string | null;
};

const rowOf = (r: BindingDbRow): BindingRow => ({
  id: r.id, inboxId: r.inbox_id, inboxPublicKey: r.inbox_public_key, inboxPrivateKey: r.inbox_private_key, webhookId: r.webhook_id, hookSecret: r.hook_secret,
  source: JSON.parse(r.source) as EventSource, action: JSON.parse(r.action) as EventAction, prompt: r.prompt, passBody: r.pass_body === 1,
  allowAuthors: JSON.parse(r.allow_authors) as string[], state: r.state, fromSessionId: r.from_session_id, createdAt: r.created_at, expiresAt: r.expires_at,
});

const runDto = (db: Db, r: RunRow): ScheduleRunDto => ({
  id: r.id, plannedAt: r.planned_at, startedAt: r.started_at, endedAt: r.ended_at, result: r.result, sessionId: r.session_id,
  sessionTitle: r.session_id ? sessionTitleOf(db, r.session_id) : null, error: r.error,
});

/** DTO は列を選んで組む。BindingRow を広げて返さない（秘密が混ざるため）。 */
function dto(db: Db, r: BindingDbRow): EventBindingDto {
  const b = rowOf(r);
  const runs = db.prepare('select * from event_runs where binding_id = ? order by started_at desc, rowid desc').all(r.id) as RunRow[];
  return {
    id: b.id, source: b.source, action: b.action, prompt: b.prompt, passBody: b.passBody, allowAuthors: b.allowAuthors, state: b.state,
    hookUrl: null, createdAt: b.createdAt, expiresAt: b.expiresAt, runs: runs.map((x) => runDto(db, x)),
  };
}

const bindingRow = (db: Db, id: string): BindingDbRow | undefined => db.prepare('select * from event_bindings where id = ?').get(id) as BindingDbRow | undefined;

/** 作った新しい順。 */
export function listBindings(db: Db): EventBindingDto[] {
  return (db.prepare('select * from event_bindings order by created_at desc, rowid desc').all() as BindingDbRow[]).map((r) => dto(db, r));
}

export function getBinding(db: Db, id: string): EventBindingDto | null {
  const r = bindingRow(db, id);
  return r ? dto(db, r) : null;
}

/** その repo を見る結び付け（秘密を含む行）。repo の大文字小文字は区別しない。作った古い順。 */
export function bindingsForRepo(db: Db, repo: string): BindingRow[] {
  const want = repo.toLowerCase();
  return (db.prepare('select * from event_bindings order by created_at, rowid').all() as BindingDbRow[]).map(rowOf)
    .filter((b) => b.source.kind === 'github' && b.source.repo.toLowerCase() === want);
}

/** 結び付けの受け箱を置き換える。外の webhook の結び付けは、受け箱を後から作るので、空の ID で作ってからここで入れる。 */
export function setBindingInbox(db: Db, id: string, o: { inboxId: string; inboxPublicKey: string; inboxPrivateKey: string }): void {
  const n = db.prepare('update event_bindings set inbox_id = ?, inbox_public_key = ?, inbox_private_key = ? where id = ?').run(o.inboxId, o.inboxPublicKey, o.inboxPrivateKey, id).changes;
  if (n === 0) throw new MessageError(msg('schedules.event.error.notFound'));
}

/** 後片付けを預かっている受け箱。repo を渡すと、その repo の分だけ。 */
export type HookOrphan = { inboxId: string; repo: string | null; webhookId: number | null };

export function listHookOrphans(db: Db, repo?: string): HookOrphan[] {
  const rows = db.prepare('select inbox_id, repo, webhook_id from event_hook_orphans order by created_at, rowid').all() as { inbox_id: string; repo: string | null; webhook_id: number | null }[];
  const want = repo?.toLowerCase();
  return rows.filter((r) => want === undefined || r.repo?.toLowerCase() === want).map((r) => ({ inboxId: r.inbox_id, repo: r.repo, webhookId: r.webhook_id }));
}

export function addHookOrphan(db: Db, o: HookOrphan, now: number): void {
  db.prepare('insert or ignore into event_hook_orphans (inbox_id, repo, webhook_id, created_at) values (?, ?, ?, ?)').run(o.inboxId, o.repo, o.webhookId, now);
}

export function dropHookOrphan(db: Db, inboxId: string): void {
  db.prepare('delete from event_hook_orphans where inbox_id = ?').run(inboxId);
}

/** 受け箱から引き取った荷物に当てる結び付け。秘密を含む行を返す。 */
export function bindingsForInbox(db: Db, inboxId: string): BindingRow[] {
  return (db.prepare('select * from event_bindings where inbox_id = ? order by created_at, rowid').all(inboxId) as BindingDbRow[]).map(rowOf);
}

/** 秘密を含む 1 行。DTO の道には渡さない。 */
export function getBindingRow(db: Db, id: string): BindingRow | null {
  const r = bindingRow(db, id);
  return r ? rowOf(r) : null;
}

/** 下書きでない結び付けの数。上限 EVENT_BINDINGS_MAX が数えるのはこれだけ。 */
export function countBindings(db: Db): number {
  return (db.prepare("select count(*) c from event_bindings where state != 'draft'").get() as { c: number }).c;
}

/** 下書きの数。 */
export function countDrafts(db: Db): number {
  return (db.prepare("select count(*) c from event_bindings where state = 'draft'").get() as { c: number }).c;
}

/** 作る。下書きでない結び付けが上限を越えるときは断る。起こす結び付けには 30 日の期限を付ける。 */
export function createBinding(db: Db, input: BindingInput, now: number): EventBindingDto {
  // 上限は下書きでない結び付けを数える。下書きは MCP の道具が別の上限で止める。
  if ((input.state ?? 'draft') !== 'draft' && countBindings(db) >= EVENT_BINDINGS_MAX) throw new MessageError(msg('schedules.event.error.max', { max: EVENT_BINDINGS_MAX }));
  const id = randomUUID();
  const expiresAt = input.action.kind === 'wake' ? now + WAKE_BINDING_TTL_MS : null;
  db.prepare(`insert into event_bindings (id, inbox_id, inbox_public_key, inbox_private_key, webhook_id, hook_secret, source, action, prompt, pass_body, allow_authors, state, from_session_id, created_at, expires_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.inboxId, input.inboxPublicKey, input.inboxPrivateKey, input.webhookId ?? null, input.hookSecret ?? null, JSON.stringify(input.source), JSON.stringify(input.action),
      input.prompt, input.passBody ? 1 : 0, JSON.stringify(input.allowAuthors ?? []), input.state ?? 'draft', input.fromSessionId ?? null, now, expiresAt);
  return dto(db, bindingRow(db, id)!);
}

const STATES: readonly EventBindingState[] = ['draft', 'active', 'held', 'error'];

/**
 * 変える。動きを変えたときは、期限も決め直す。起こす結び付けだけが 30 日の期限を持つ。
 * 送る・作るから起こすへ変えたら、いまから 30 日。起こすから別の動きへ変えたら期限を外す。起こすから起こすへは元の期限のまま。
 */
export function updateBinding(db: Db, id: string, p: BindingPatch, now: number = Date.now()): EventBindingDto {
  const r = bindingRow(db, id);
  if (!r) throw new MessageError(msg('schedules.event.error.notFound'));
  if (p.state !== undefined && !STATES.includes(p.state)) throw new MessageError(msg('schedules.event.error.badState'));
  let expiresAt = r.expires_at;
  if (p.action) {
    const wasWake = (JSON.parse(r.action) as EventAction).kind === 'wake';
    expiresAt = p.action.kind !== 'wake' ? null : wasWake && r.expires_at !== null ? r.expires_at : now + WAKE_BINDING_TTL_MS;
  }
  db.prepare('update event_bindings set source = ?, action = ?, prompt = ?, pass_body = ?, allow_authors = ?, state = ?, webhook_id = ?, hook_secret = ?, expires_at = ? where id = ?')
    .run(p.source ? JSON.stringify(p.source) : r.source, p.action ? JSON.stringify(p.action) : r.action, p.prompt ?? r.prompt,
      p.passBody === undefined ? r.pass_body : p.passBody ? 1 : 0, p.allowAuthors ? JSON.stringify(p.allowAuthors) : r.allow_authors, p.state ?? r.state,
      p.webhookId === undefined ? r.webhook_id : p.webhookId, p.hookSecret === undefined ? r.hook_secret : p.hookSecret, expiresAt, id);
  return dto(db, bindingRow(db, id)!);
}

function remove(db: Db, id: string, now: number): boolean {
  const row = bindingRow(db, id);
  db.prepare('delete from event_runs where binding_id = ?').run(id);
  db.prepare('delete from event_deliveries where binding_id = ?').run(id);
  const gone = db.prepare('delete from event_bindings where id = ?').run(id).changes > 0;
  if (gone && row) leaveOrphan(db, row, now);
  return gone;
}

/**
 * 受け箱を使う最後の結び付けが消えたとき、その受け箱と webhook の後片付けを預かる。
 * 同じ受け箱を使う結び付けがまだ残っていれば、何もしない。
 * まだ受け箱を持たない結び付け（inbox_id が空）にも預かるものは無い。
 */
function leaveOrphan(db: Db, r: BindingDbRow, now: number): void {
  if (!r.inbox_id) return;
  if (db.prepare('select 1 from event_bindings where inbox_id = ? limit 1').get(r.inbox_id)) return;
  const source = JSON.parse(r.source) as EventSource;
  db.prepare('insert or ignore into event_hook_orphans (inbox_id, repo, webhook_id, created_at) values (?, ?, ?, ?)')
    .run(r.inbox_id, source.kind === 'github' ? source.repo : null, r.webhook_id, now);
}

export function deleteBinding(db: Db, id: string, now: number = Date.now()): boolean {
  return db.transaction(() => remove(db, id, now))();
}

/** 期限が過ぎた結び付けを、履歴と覚えた荷物ごと消す。消した数を返す。 */
export function expireBindings(db: Db, now: number): number {
  return db.transaction(() => {
    const ids = db.prepare('select id from event_bindings where expires_at is not null and expires_at <= ?').all(now) as { id: string }[];
    for (const { id } of ids) remove(db, id, now);
    return ids.length;
  })();
}

/** 古い履歴を落とす。動いている回は残す。 */
function prune(db: Db, bindingId: string): void {
  db.prepare(`delete from event_runs where binding_id = ? and result != 'running' and id not in (
    select id from event_runs where binding_id = ? order by started_at desc, rowid desc limit ?)`).run(bindingId, bindingId, SCHEDULE_RUNS_KEPT);
}

export function addEventRun(db: Db, o: { bindingId: string; plannedAt?: number; now: number; result: ScheduleRunResult }): string {
  const id = randomUUID();
  db.prepare('insert into event_runs (id, binding_id, planned_at, started_at, ended_at, result) values (?, ?, ?, ?, ?, ?)')
    .run(id, o.bindingId, o.plannedAt ?? o.now, o.now, o.result === 'running' ? null : o.now, o.result);
  prune(db, o.bindingId);
  return id;
}

export function setEventRunSession(db: Db, runId: string, sessionId: string): void {
  db.prepare('update event_runs set session_id = ? where id = ?').run(sessionId, runId);
}

/** 回を閉じる。結び付けごと消されていれば何もしない。 */
export function finishEventRun(db: Db, runId: string, o: { now: number; result: ScheduleRunResult; error?: string }): void {
  const r = db.prepare('select binding_id from event_runs where id = ?').get(runId) as { binding_id: string } | undefined;
  if (!r) return;
  db.prepare('update event_runs set ended_at = ?, result = ?, error = ? where id = ?').run(o.now, o.result, o.error ?? null, runId);
  prune(db, r.binding_id);
}

/**
 * 届いた荷物の x-github-delivery を覚える。初めて見たなら true、再送なら false。
 * 受け箱は荷物を 7 日しか預からないので、それより古い覚えは落とす。
 */
export function markDelivery(db: Db, bindingId: string, deliveryId: string, now: number): boolean {
  return db.transaction(() => {
    db.prepare('delete from event_deliveries where seen_at < ?').run(now - EVENT_INBOX_KEEP_MS);
    return db.prepare('insert or ignore into event_deliveries (binding_id, delivery_id, seen_at) values (?, ?, ?)').run(bindingId, deliveryId, now).changes > 0;
  })();
}

/** 届いた荷物の x-github-delivery を、覚えずに見る。覚えているなら true。覚えるのは markDelivery（渡し終えてから）。 */
export function hasDelivery(db: Db, bindingId: string, deliveryId: string, now: number): boolean {
  return db.prepare('select 1 from event_deliveries where binding_id = ? and delivery_id = ? and seen_at >= ?').get(bindingId, deliveryId, now - EVENT_INBOX_KEEP_MS) !== undefined;
}

/** 会話が PR を持つ印を付ける。draft は利用者が承認するまでの下書きで、active を draft へ戻さない。 */
export function claimPr(db: Db, o: { sessionId: string; repo: string; pr: number; state: 'draft' | 'active'; now?: number }): void {
  const now = o.now ?? Date.now();
  db.prepare(`insert into session_prs (session_id, repo, pr, state, claimed_at) values (?, ?, ?, ?, ?)
    on conflict (session_id, repo, pr) do update set
      state = case when excluded.state = 'active' then 'active' else session_prs.state end,
      claimed_at = case when excluded.state = 'active' then excluded.claimed_at else session_prs.claimed_at end`)
    .run(o.sessionId, o.repo, o.pr, o.state, now);
}

export type PrClaim = { sessionId: string; repo: string; pr: number; claimedAt: number };

/** 利用者の承認を待つ PR の印。新しい順。 */
export function listDraftClaims(db: Db): PrClaim[] {
  return (db.prepare("select session_id, repo, pr, claimed_at from session_prs where state = 'draft' order by claimed_at desc, rowid desc").all() as { session_id: string; repo: string; pr: number; claimed_at: number }[])
    .map((r) => ({ sessionId: r.session_id, repo: r.repo, pr: r.pr, claimedAt: r.claimed_at }));
}

/** 会話の下書きの印の数。 */
export function countSessionDraftClaims(db: Db, sessionId: string): number {
  return (db.prepare("select count(*) c from session_prs where session_id = ? and state = 'draft'").get(sessionId) as { c: number }).c;
}

/** その印があるか。 */
export function hasClaim(db: Db, o: { sessionId: string; repo: string; pr: number }): boolean {
  return db.prepare('select 1 from session_prs where session_id = ? and repo = ? and pr = ?').get(o.sessionId, o.repo, o.pr) !== undefined;
}

/** 下書きの印を承認する。承認済みの印は、レビューやコメントの宛先になる。 */
export function approveClaim(db: Db, o: { sessionId: string; repo: string; pr: number }): void {
  claimPr(db, { ...o, state: 'active' });
}

/** 下書きの印を取り下げる。承認済みの印は消さない。消したら true。 */
export function rejectClaim(db: Db, o: { sessionId: string; repo: string; pr: number }): boolean {
  return db.prepare("delete from session_prs where session_id = ? and repo = ? and pr = ? and state = 'draft'").run(o.sessionId, o.repo, o.pr).changes > 0;
}

/** PR を持つ会話。承認済み（active）の印だけを見て、複数あれば新しい印を採る。 */
export function prOwner(db: Db, repo: string, pr: number): string | null {
  const r = db.prepare("select session_id from session_prs where repo = ? and pr = ? and state = 'active' order by claimed_at desc, rowid desc limit 1").get(repo, pr) as { session_id: string } | undefined;
  return r?.session_id ?? null;
}
