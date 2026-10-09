import type { Db } from '../db/open.ts';
import type { LiveSession } from '../provider/claude-code/types.ts';
import { parseProcStart } from '../runs/procs.ts';

/**
 * 利用者が打った発言を出した claude のプロセスが、いつ起動したか（epoch のミリ秒）。
 * 状態を外すのは resume した後の発言だけなので、その見分けに使う（sessions/states.ts の clearOnNewPrompt）。
 * 次の順に取り、どちらも取れなければ null を返す。
 * 1. Claude Code の登録（~/.claude/sessions/<pid>.json）にそのセッションの生きた項目があれば、その procStart。
 * 2. 無ければ、hangar の runs 表のこの端末のそのセッションの最新の started_at。
 * どちらも発言の時刻より後に起動したものは除く。発言を出したプロセスは、発言より前に起動しているはずだからである。
 */
export function processStartOfPrompt(db: Db, deviceId: string, live: readonly LiveSession[], q: { sessionId: string; providerSessionId: string; promptTs: number }): number | null {
  for (const l of live) {
    if (l.sessionId !== q.providerSessionId || !l.procStart) continue;
    const t = parseProcStart(l.procStart);
    if (t !== null && t <= q.promptTs) return t;
  }
  const r = db.prepare('select max(started_at) t from runs where session_id = ? and device_id = ? and deleted_at is null and started_at <= ?').get(q.sessionId, deviceId, q.promptTs) as { t: number | null };
  return r.t;
}
