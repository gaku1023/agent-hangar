import { listPageOf, type ListFilter, type ListPageDto, type LiveSessionDto, type RunDto, type SessionDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { listSessions } from '../db/queries.ts';

/** 起動時の取得で一覧の 1 頁目として送る件数（根の数）。画面の頁の既定の件数と同じ。 */
export const FIRST_PAGE_SIZE = 50;

/**
 * どこかの PC で終わっていない run がある会話の id。画面の aliveAnywhere と同じく、この PC の生きた run に、ほかの PC のロックのある会話を足す。
 * 一覧の「実行中」の絞り込みと並びに使う。
 */
export function aliveIdsOf(sessions: readonly SessionDto[], runs: readonly RunDto[]): Set<string> {
  const out = new Set(runs.filter((r) => r.endedAt === null).map((r) => r.sessionId));
  for (const s of sessions) if ((s.lock ?? null) !== null) out.add(s.id);
  return out;
}

/**
 * 一覧の 1 頁を組む（/api/search の語が空のとき）。並びと入れ子は画面と同じ shared の listPageOf に任せる。
 * プロジェクトで絞るときは、そのプロジェクトの会話だけを読む。入れ子の起動元を引く表も同じ範囲になるのは、画面のプロジェクトの一覧と同じである。
 * sessions は頁に並ぶ会話の行（rows の順）。
 */
export function sessionListPage(db: Db, o: { live: LiveSessionDto[]; runs: RunDto[]; deviceId: string; filter: ListFilter; offset: number; limit: number }): { page: ListPageDto; sessions: SessionDto[] } {
  const all = listSessions(db, o.live, { deviceId: o.deviceId, ...(o.filter.projectId ? { projectId: o.filter.projectId } : {}) });
  const page = listPageOf(all, o.filter, aliveIdsOf(all, o.runs), o.offset, o.limit);
  const byId = new Map(all.map((s) => [s.id, s]));
  return { page, sessions: page.rows.map((r) => byId.get(r.id)!) };
}
