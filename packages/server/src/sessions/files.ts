import type { SessionFilesDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { EDIT_TOOLS } from '../indexer/indexFile.ts';

type Row = { file_path: string; parent_agent: string | null };

/**
 * そのセッションが編集系のツールで変えたファイルを、`event_index` の呼び出しをパスでまとめて返す。
 * 並びは、そのパスへの最初の呼び出しを索引した順（行の id の順）である。
 * agentId は、メイン会話が一度も触れておらず、サブエージェントだけが触ったときの最初のサブエージェントの id。メイン会話が触っていれば null。
 * 足した行と消した行の数は索引に無いので返さない。UI は読み込んだ窓にある分だけ、本文から数える。
 */
export function changedFilesOf(db: Db, sessionId: string): SessionFilesDto {
  const marks = EDIT_TOOLS.map(() => '?').join(',');
  const rows = db.prepare(`select file_path, parent_agent from event_index where session_id = ? and tool_name in (${marks}) and file_path is not null and file_path <> '' order by id`).all(sessionId, ...EDIT_TOOLS) as Row[];
  const files = new Map<string, { path: string; edits: number; agentId: string | null; main: boolean }>();
  for (const r of rows) {
    let f = files.get(r.file_path);
    if (!f) { f = { path: r.file_path, edits: 0, agentId: r.parent_agent, main: false }; files.set(r.file_path, f); }
    f.edits++;
    if (r.parent_agent === null) f.main = true;
  }
  return { files: [...files.values()].map((f) => ({ path: f.path, edits: f.edits, agentId: f.main ? null : f.agentId })) };
}
