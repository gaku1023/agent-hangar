import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { parentThreadOf } from '../provider/codex/transcript/subagent.ts';
import { forgetTranscriptFile } from './indexFile.ts';
import { stmt } from './statements.ts';

/**
 * 前の版は、Codex の子（サブエージェント）の rollout を独立した会話として索引した。
 * いまは親の会話のサブエージェント（sessionId が親、agentId が自分）として索引するので、前の版が作った行を付け替える。
 *
 * 本文の先頭に parent_thread_id を持つ rollout が、独立した会話として入っていれば、
 * - その rollout の索引（事象、検索、日別の使用量、読み進めた位置）を消し、次の全走査が親の下で先頭から読み直す。
 * - 独立した会話の行（sessions）は論理削除する。同期で届いた行と同じく、ほかの PC でも一覧から外れる。
 * - この PC が上げた台帳の鍵（codex/<端末>/<子>.jsonl.gz）は、親の下の鍵（codex/<端末>/<親>/subagents/<子>.jsonl.gz）へ移す。R2 の鍵名は子の UUID で変わらないので、上げ直さない。
 * 親が手元の索引に無い子は、独立した会話のまま残す（親が入らなければ、子だけが見えなくなるのを避ける）。
 *
 * 済みの印（settings_local）は、前の版の索引の行が全部親の下に移ったあとは、再び調べる必要が無いので置く。
 * Codex を切にしている間は調べず、印も置かない（本文を読めないため）。
 */
const DONE_KEY = 'codexChildrenReparented';

export function reparentCodexChildren(db: Db, deviceId: string): number {
  if (stmt(db, 'select 1 from settings_local where key = ?').get(DONE_KEY) !== undefined) return 0;
  const candidates = stmt(db, `select t.path path, t.session_id sid, s.provider_session_id own from transcript_files t join sessions s on s.id = t.session_id
    where t.agent = 'codex' and t.agent_id is null and s.provider = 'codex' and s.deleted_at is null`).all() as { path: string; sid: string; own: string }[];
  let moved = 0;
  let undecided = false;
  for (const c of candidates) {
    const { known, parent } = parentThreadOf(c.path);
    if (!known) { undecided = true; continue; }
    if (parent === null) continue;
    const parentRow = stmt(db, "select id from sessions where provider = 'codex' and provider_session_id = ? and deleted_at is null").get(parent) as { id: string } | undefined;
    if (!parentRow) continue;
    db.transaction(() => {
      forgetTranscriptFile(db, c.path);
      const row = stmt(db, 'select * from sessions where id = ?').get(c.sid) as Record<string, unknown>;
      upsertShared(db, 'sessions', { ...row, deleted_at: Date.now() }, deviceId);
      const oldKey = `codex/${deviceId}/${c.own}.jsonl.gz`;
      const newKey = `codex/${deviceId}/${parent}/subagents/${c.own}.jsonl.gz`;
      stmt(db, "update or ignore file_sync set key = ? where key = ? and kind = 'transcript'").run(newKey, oldKey);
      stmt(db, 'update or ignore blob_uploads set ledger_key = ? where ledger_key = ?').run(newKey, oldKey);
      stmt(db, "update or ignore sync_state set key = 'skipped:' || ? where key = 'skipped:' || ?").run(newKey, oldKey);
    })();
    moved++;
  }
  if (!undecided) stmt(db, 'insert or ignore into settings_local (key, value) values (?, ?)').run(DONE_KEY, '1');
  return moved;
}
