import type { EventsPageDto } from '@agent-hangar/shared';
import { DEFAULT_AGENT } from '../agent/agents.ts';
import type { ReadOpts, TranscriptSource } from '../agent/types.ts';
import type { Db } from '../db/open.ts';
import { stmt } from '../indexer/statements.ts';
import { readClaudePage } from '../provider/claude-code/transcript/page.ts';

/**
 * sessions.provider の値から、その会話の本文を読む口を引く。
 * 読み方はエージェントごとに違う（Claude は索引のバイト位置から本文のファイルを読み直す）ので、driver の readPage と同じものを返す。
 * 読み手の無いエージェントには undefined を返す。
 */
export type PageReaders = (provider: string) => TranscriptSource['readPage'] | undefined;

/** 既定の読み手。Claude の driver の transcript.readPage と同じ関数である。 */
export const DEFAULT_PAGE_READERS: PageReaders = (provider) => (provider === 'claude-code' ? readClaudePage : undefined);

/**
 * セッションに属するサブエージェントの id を、始まった順に返す。
 * 呼び出し側は「Agent の N 番目の呼び出し」と「N 番目の id」を突き合わせるので、名前順ではなく時刻順でなければならない。
 */
export function subagentIds(db: Db, sessionId: string): string[] {
  const rows = db.prepare('select parent_agent a from event_index where session_id = ? and parent_agent is not null group by parent_agent order by min(ts), min(seq)').all(sessionId) as { a: string }[];
  return rows.map((r) => r.a);
}

/**
 * 会話の本文の 1 ページを、正規化イベントで返す。
 * 会話の provider で読み手をふり分けるだけで、読み方は読み手（エージェントの driver の readPage）が決める。
 * 行の無い会話は既定のエージェント（Claude）の道で読み、読み手の無いエージェントの会話は空のページを返す。
 * agentId を省略すると主線を読む。
 */
export function readEvents(db: Db, sessionId: string, opts: ReadOpts, readers: PageReaders = DEFAULT_PAGE_READERS): EventsPageDto {
  const row = stmt(db, 'select provider from sessions where id = ?').get(sessionId) as { provider: string } | undefined;
  const read = readers(row?.provider ?? DEFAULT_AGENT);
  if (!read) return { sessionId, events: [], total: 0, nextSeq: null };
  return read(db, sessionId, opts);
}
