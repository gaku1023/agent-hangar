import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import type { QuestionHook } from '../provider/claude-code/hooks/question.ts';

/**
 * hook から届いた AskUserQuestion の出入りを、索引と同じ表（session_activity）へ書く。
 * 索引（indexer/indexFile.ts）は、この行を前の値として本文の追記を畳む。
 * 同じ呼び出しが本文に載ってもそのまま残り、その呼び出しへの答え（tool_result）が載れば消える。
 * 本文が答えの時まで呼び出しを書かなくても、問いはここで先に入る。
 *
 * sessionId は受け口の URL のセッション（hangar の id）で、run の秘密はそのセッションの入口だけを開ける。
 * hook の会話（session_id）がそのセッションのものでなければ書かない（/clear で会話が替わった後など）。
 * 書いたら（行が変わったら）true を返し、画面へ配り直す。
 */
export function applyQuestionHook(db: Db, sessionId: string, hook: QuestionHook, now: number): boolean {
  const s = db.prepare('select provider_session_id from sessions where id = ? and deleted_at is null').get(sessionId) as { provider_session_id: string } | undefined;
  if (!s || s.provider_session_id !== hook.providerSessionId) return false;
  let changed: boolean;
  if (hook.kind === 'asked') {
    db.prepare(`insert into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,?)
      on conflict(session_id) do update set tool = excluded.tool, summary = excluded.summary, tool_id = excluded.tool_id, question = excluded.question, updated_at = excluded.updated_at`)
      .run(sessionId, 'AskUserQuestion', hook.summary, hook.toolId, hook.question, now);
    changed = true;
  } else {
    changed = db.prepare('update session_activity set question = null, updated_at = ? where session_id = ? and tool_id = ? and question is not null').run(now, sessionId, hook.toolId).changes > 0;
  }
  // 行は手元だけの表なので、SessionDto を配り直してもらう（events/publisher.ts）。
  if (changed) touchRow(db, 'sessions', sessionId);
  return changed;
}
