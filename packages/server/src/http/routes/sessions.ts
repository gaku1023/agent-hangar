import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { liveFilterOf, type PromoteResultDto, type SearchParamsDto, type SessionStateDto, type SessionStatus } from '@agent-hangar/shared';
import { touchRow } from '../../db/notify.ts';
import { getProject, listSessions } from '../../db/queries.ts';
import { upsertShared } from '../../db/shared.ts';
import { EDIT_TOOLS } from '../../indexer/indexFile.ts';
import { LiveDigester } from '../../live/digest.ts';
import { PromoteError } from '../../projects/promote.ts';
import { searchSessions } from '../../search/search.ts';
import { parkedSessionIds } from '../../sessions/park.ts';
import { confirmSessionState, rejectSessionState, setSessionState, StateInputError } from '../../sessions/states.ts';
import { readEvents, subagentIds } from '../../transcript/read.ts';
import { errorText, render, translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, externalOf, isEnoent, numberOr, readJson, sessionOf, tooLargeResult } from './common.ts';

/** セッションの経路が使う依存。 */
export type SessionRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live' | 'runs' | 'summary' | 'promote' | 'external' | 'token'> & LanguageDeps;

/** セッションの状態として受け付ける値。Active は null で表す。 */
const SESSION_STATUSES = new Set(['paused', 'done', 'archived']);

/**
 * セッションの経路。
 * 一覧と 1 件、本文、サブエージェント、実行中の要約、検索、エディタで開く、1 行メモ、状態、昇格、事後要約を持つ。
 * 起動（resume、fork など）は run を作るので runs.ts にある。
 */
export function sessionRoutes(api: Hono, deps: SessionRouteDeps): void {
  const language = deps.language;
  const tr = translatorOf(deps.language);
  const { db, deviceId } = deps;
  const session = sessionOf(deps);
  const sessions = (opts: { projectId?: string } = {}) => listSessions(db, deps.live(), { ...opts, deviceId });
  const digester = new LiveDigester(db);
  const external = externalOf(deps);

  api.get('/sessions', (c) => c.json(sessions({ projectId: c.req.query('projectId') })));
  api.get('/sessions/:id', (c) => {
    const s = session(c.req.param('id'));
    return s ? c.json(s) : c.json({ error: tr('session.error.notFound') }, 404);
  });
  api.get('/sessions/:id/events', (c) => {
    const q = c.req.query();
    const id = c.req.param('id');
    // 画面を開くと最新の側を求めてくる。そこが「セッションを開いたとき（主線）」なので、事後要約の契機はここに付ける。
    // 遡るとき（before）と追記を取り込むとき（fromSeq）は契機にしない。受け付けの可否は応答に影響しない。
    if (q.latest === '1' && !q.agentId) {
      try { deps.summary.enqueue(id); } catch { /* 要約の失敗で本文の読み出しを止めない */ }
    }
    // before は 0 を渡せなければならないので、numberOr（空文字と 0 を undefined にする）は使わない。
    const before = q.before === undefined || q.before === '' || !Number.isFinite(Number(q.before)) ? undefined : Number(q.before);
    try {
      return c.json(readEvents(db, id, { fromSeq: numberOr(q.fromSeq), limit: numberOr(q.limit), agentId: q.agentId || null, latest: q.latest === '1', beforeSeq: before }));
    } catch (e) {
      // 索引はあるのに本文ファイルが消えている場合だけ 404 にし、他は 500 に任せる。
      if (isEnoent(e)) return c.json({ error: tr('session.transcript.notOnThisComputer') }, 404);
      throw e;
    }
  });
  api.get('/sessions/:id/subagents', (c) => c.json(subagentIds(db, c.req.param('id'))));
  // 実行中のセッションの右ペイン。UI は追記のたびに取り直すが、索引が変わっていなければ覚えた要約を返す。
  api.get('/sessions/:id/live', (c) => {
    const id = c.req.param('id');
    if (!session(id)) return c.json({ error: tr('session.error.notFound') }, 404);
    try {
      return c.json(digester.digest(id));
    } catch (e) {
      if (isEnoent(e)) return c.json({ error: tr('session.transcript.notOnThisComputer') }, 404);
      throw e;
    }
  });

  /** /api/search の status として受ける値。知らない値は絞り込みなしとして扱う。 */
  const STATUS_FILTERS: ReadonlySet<string> = new Set(['paused', 'done', 'archived', 'active', 'proposed']);
  api.get('/search', (c) => {
    const q = c.req.query();
    const live = q.live === 'running' || q.live === 'waiting' || q.live === 'ended' ? q.live : undefined;
    const status = q.status && STATUS_FILTERS.has(q.status) ? (q.status as NonNullable<SearchParamsDto['status']>) : undefined;
    const hideArchived = q.hideArchived === 'true' || q.hideArchived === '1';
    // 数え方は UI と同じ liveFilterOf に任せる。
    // Claude の一覧に載る前の run も実行中に入れる。
    const liveStatus = new Map(deps.live().map((l) => [l.sessionId, l.status]));
    const alive = new Set(deps.runs.listAlive().runs.filter((r) => r.endedAt === null).map((r) => r.sessionId));
    // 区切りを付けて休みのまま残っているものは、画面と同じく終了に数える。
    const parked = new Set(parkedSessionIds(db, deps.live(), deviceId));
    const liveOf = (sid: string, psid: string) => liveFilterOf(liveStatus.get(psid) ?? null, alive.has(sid), parked.has(sid));
    return c.json(searchSessions(db, { q: q.q ?? '', projectId: q.projectId || undefined, since: numberOr(q.since), until: numberOr(q.until), live, file: q.file || undefined, limit: numberOr(q.limit), offset: numberOr(q.offset), status, hideArchived }, liveOf));
  });

  // 本文を送らなければ作業ディレクトリを開く。
  // file を送ると、そのセッションが編集系のツールで変えたファイル（event_index に残る綴りそのまま）だけを開く。
  // 画面の右欄の「変更したファイル」から来る道で、任意のパスを code に渡させないために、索引に無いパスは断る。
  api.post('/sessions/:id/open-editor', async (c) => {
    const s = session(c.req.param('id'));
    if (!s) return c.json({ error: tr('session.error.notFound') }, 404);
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const file = (b.value as { file?: unknown } | undefined)?.file;
    if (file === undefined) return external(c, () => deps.external.openEditor({ target: s.cwd }), true);
    if (typeof file !== 'string' || !path.isAbsolute(file)) return c.json({ error: tr('session.file.mustBeAbsolute') }, 400);
    const marks = EDIT_TOOLS.map(() => '?').join(',');
    const known = db.prepare(`select 1 from event_index where session_id = ? and tool_name in (${marks}) and file_path = ? limit 1`).get(s.id, ...EDIT_TOOLS, file);
    if (!known) return c.json({ error: tr('session.file.notChanged') }, 404);
    // 変えた後に消えたり、ディレクトリに替わったりしていたら開かない。
    // ディレクトリを渡すと、code はファイルではなくその中身を開いてしまう。
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return c.json({ error: tr('common.file.sourceMissing') }, 404);
    return external(c, () => deps.external.openEditor({ target: file }), true);
  });

  // セッションの 1 行メモ、昇格、事後要約。
  api.patch('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const row = db.prepare('select * from sessions where id = ? and deleted_at is null').get(id) as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: tr('session.error.notFound') }, 404);
    const b = await readJson(c, BODY_LIMITS.todo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.todo, tr);
    const body = (b.value ?? {}) as { memo?: unknown };
    if (typeof body.memo !== 'string') return c.json({ error: tr('common.field.mustBeString', { field: 'memo' }) }, 400);
    upsertShared(db, 'sessions', { ...row, memo: body.memo.trim() || null }, deviceId);
    return c.json(session(id)!);
  });
  // セッションの状態（Paused・Done・Archived）と Claude の提案の確定・却下。どれも利用者の操作で、MCP からは呼べない。
  // run に配る MCP の秘密は /api を開けない（authMiddleware は本体のトークンしか見ない）。
  // 成功したら、書いた行（session_states）から配る層が session.upsert を配る。画面の正はその配信である。
  const noStateCandidate = () => tr('session.status.noSuggestion');
  const liveSessionRow = (id: string) => db.prepare('select 1 from sessions where id = ? and deleted_at is null').get(id) !== undefined;
  const stateResult = (c: Context, fn: () => { state: SessionStateDto; result?: string }) => {
    try {
      const r = fn();
      if (r.result === 'not_candidate') return c.json({ error: noStateCandidate() }, 409);
      return c.json({ state: r.state });
    } catch (e) {
      if (e instanceof StateInputError) return c.json({ error: errorText(language(), e) }, 400);
      throw e;
    }
  };
  const putSessionState = async (c: Context, id: string) => {
    if (!liveSessionRow(id)) return c.json({ error: tr('session.error.notFound') }, 404);
    const b = await readJson(c, BODY_LIMITS.todo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.todo, tr);
    const body = (b.value ?? {}) as { status?: unknown; note?: unknown; returnOn?: unknown; returnTime?: unknown };
    if (body.status !== null && !(typeof body.status === 'string' && SESSION_STATUSES.has(body.status))) return c.json({ error: tr('session.status.invalid') }, 400);
    if (body.note !== undefined && typeof body.note !== 'string') return c.json({ error: tr('session.status.reasonMustBeString') }, 400);
    if (body.returnOn !== undefined && typeof body.returnOn !== 'string') return c.json({ error: tr('session.status.returnOnMustBeString') }, 400);
    if (body.returnTime !== undefined && typeof body.returnTime !== 'string') return c.json({ error: tr('session.status.returnTimeMustBeString') }, 400);
    const status = body.status as SessionStatus | null;
    return stateResult(c, () => ({ state: setSessionState(db, deviceId, id, { status, note: body.note as string | undefined, returnOn: body.returnOn as string | undefined, returnTime: body.returnTime as string | undefined, setBy: 'user' }) }));
  };
  api.put('/sessions/:id/state', (c) => putSessionState(c, c.req.param('id')));
  api.post('/sessions/:id/state/confirm', async (c) => {
    const id = c.req.param('id');
    if (!liveSessionRow(id)) return c.json({ error: tr('session.error.notFound') }, 404);
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { returnOn?: unknown; returnTime?: unknown };
    if (body.returnOn !== undefined && typeof body.returnOn !== 'string') return c.json({ error: tr('session.status.returnOnMustBeString') }, 400);
    if (body.returnTime !== undefined && typeof body.returnTime !== 'string') return c.json({ error: tr('session.status.returnTimeMustBeString') }, 400);
    return stateResult(c, () => confirmSessionState(db, deviceId, id, body.returnOn === undefined ? {} : { returnOn: body.returnOn as string, ...(body.returnTime !== undefined ? { returnTime: body.returnTime as string } : {}) }));
  });
  api.post('/sessions/:id/state/reject', (c) => {
    const id = c.req.param('id');
    if (!liveSessionRow(id)) return c.json({ error: tr('session.error.notFound') }, 404);
    return stateResult(c, () => rejectSessionState(db, deviceId, id));
  });
  api.post('/sessions/:id/promote', async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { name?: unknown; gitInit?: unknown; moveFiles?: unknown };
    if (typeof body.name !== 'string') return c.json({ error: tr('common.field.required', { field: 'name' }) }, 400);
    const before = session(id);
    if (!before) return c.json({ error: tr('session.error.notFound') }, 404);
    try {
      const r = deps.promote({ sessionId: id, name: body.name, gitInit: body.gitInit === true, moveFiles: body.moveFiles === true });
      const project = getProject(db, deviceId, deps.live(), r.projectId)!;
      const updated = session(id)!;
      // 新しいプロジェクトとセッションは、書いた行から配る層が配る。
      // 昇格元のスクラッチは、行は変わらないがセッションが 1 件減るので、名指しして配り直してもらう。
      if (before.projectId && before.projectId !== r.projectId) touchRow(db, 'projects', before.projectId);
      const out: PromoteResultDto = { project, session: updated, moved: r.moved, reason: r.reasonMessage ? render(language(), r.reasonMessage) : r.reason };
      return c.json(out, 201);
    } catch (e) {
      if (e instanceof PromoteError) return c.json({ error: errorText(language(), e) }, e.status);
      throw e;
    }
  });
  api.post('/sessions/:id/summarize', (c) => {
    const id = c.req.param('id');
    if (!session(id)) return c.json({ error: tr('session.error.notFound') }, 404);
    // 受け付けられなくても 202 を返す。UI は accepted を見て「作成中」を出すかどうかだけを決める。
    // 要約は補助の機能なので、受け付けが投げても 500 にせず accepted: false で返す（GET /events と同じ扱い）。
    let accepted = false;
    try { accepted = deps.summary.enqueue(id, { force: true }); } catch { accepted = false; }
    return c.json({ accepted }, 202);
  });
}
