import fs from 'node:fs';
import type { Db } from '../db/open.ts';
import type { TranscriptFile, TranscriptFiles } from '../agent/types.ts';
import { stmt } from './statements.ts';
import { sessionRow, skipWrite, writeBatch, type ProcessStartOf, type SessionRow } from './write.ts';

// 本文をファイルに持つエージェント（Claude）の索引。どこまで読んだか（transcript_files）を持ち、続きを driver に読ませて indexer/write.ts で書く。
// ファイルを読んで束にするのは driver の側（TranscriptFiles.read、Claude は provider/claude-code/transcript/batch.ts）である。

export const INDEXER_VERSION = 1;

/**
 * remote が true なら他端末から降ろした写しである。sessions と session_summaries には書かない。
 * reader は本文を束にする口で、索引（indexer/service.ts）はエージェントのトランスクリプトの面をそのまま渡す。
 * stat は呼び手が直前に取ったファイルの大きさと更新時刻である。渡せば、ここでもう一度 statSync しない。
 */
export type IndexFileOptions = {
  deviceId: string; reader: Pick<TranscriptFiles, 'agent' | 'read'>;
  indexerVersion?: number; cwdFallback?: string; remote?: boolean; processStartOf?: ProcessStartOf; stat?: FileStat;
};
/** ファイルの大きさと更新時刻。fs.Stats をそのまま渡してよい。 */
export type FileStat = { size: number; mtimeMs: number };
export type IndexFileResult = { sessionId: string; providerSessionId: string; appended: number; changed: boolean; badLines: number; artifactIds: string[]; skipped: boolean };

type TfRow = { path: string; session_id: string; agent_id: string | null; size: number; mtime: number; indexed_bytes: number; indexer_version: number };

/**
 * 先頭からの索引が抜けたファイルを、先頭から読み直させる（版を 0 にする）。直した件数を返す。
 * 前の版の forgetTranscriptFile は、移った先のパスの索引まで消して読み進めた位置だけを残した。そのファイルは続きしか積まれていない。
 * 索引がある（読めた行がある）のに先頭の行の索引が無いものを壊れたと見る。起動のたびに呼んでも、揃ったものには触らない。
 */
export function markTruncatedForReindex(db: Db): number {
  return stmt(db, `update transcript_files set indexer_version = 0
    where indexer_version <> 0
      and exists (select 1 from event_index e where e.session_id = transcript_files.session_id and ifnull(e.parent_agent, '') = ifnull(transcript_files.agent_id, '') and e.file_path_ref = transcript_files.path)
      and not exists (select 1 from event_index e where e.session_id = transcript_files.session_id and ifnull(e.parent_agent, '') = ifnull(transcript_files.agent_id, '') and e.file_path_ref = transcript_files.path and e.byte_offset = 0)`).run().changes;
}

/**
 * 索引化をやめたファイルの索引と行を消す。同じ位置のファイルは常に 1 つだけ索引化する前提に立つ。
 * keepUsage を立てると、日別の使用量（usage_daily）は残す。セッションの削除（sessions/trash.ts）が使う。
 * 実際に使った量なので、会話を消しても集計からは消さない。ゴミ箱から戻して索引し直すときは、先頭からの作り直しで同じファイル由来のぶんを消してから積むので、二重に数えない。
 */
export function forgetTranscriptFile(db: Db, filePath: string, o: { keepUsage?: boolean } = {}): void {
  const row = stmt(db, 'select session_id, agent_id from transcript_files where path = ?').get(filePath) as { session_id: string; agent_id: string | null } | undefined;
  if (!row) return;
  const agentKey = row.agent_id ?? '';
  const run = db.transaction(() => {
    stmt(db, "delete from event_index where session_id = ? and ifnull(parent_agent, '') = ?").run(row.session_id, agentKey);
    stmt(db, "delete from event_fts where session_id = ? and ifnull(agent_id, '') = ?").run(row.session_id, agentKey);
    // 日別の集計はこのファイル由来のぶんを鍵に持っている。
    // 残すと、同じ会話を別のパス（写しから手元へ切り替わったとき）で積み直したぶんと足し合わさり、
    // event_index が正しいのに使用量のゲージだけが静かに倍になる。indexFile の reset 側と同じ 1 文である。
    if (!o.keepUsage) stmt(db, 'delete from usage_daily where session_id = ? and file_path = ?').run(row.session_id, filePath);
    // 「いま何をしているか」は主線の行だけが持つ。主線のファイルそのものを手放すときは、
    // 残すと後で息を吹き返したセッションに、答え済みの問いなど古い「いま」を見せてしまう。
    // サブエージェントのファイルを手放すだけなら、主線の行はそのまま正しいので触らない。
    if (row.agent_id === null) stmt(db, 'delete from session_activity where session_id = ?').run(row.session_id);
    // 使用制限の行も主線のものである。
    if (row.agent_id === null) stmt(db, 'delete from session_limits where session_id = ?').run(row.session_id);
    stmt(db, 'delete from transcript_files where path = ?').run(filePath);
    // 上の 2 つの delete は位置ごとに消すので、同じ位置を別のパスで読んでいたぶんも消える。
    // EnterWorktree は本文を worktree 用の projects の下へ移すので、移った先を読み終えた後に元のパスを手放す順がありうる。
    // そのパスの読み進めた位置だけが残ると、続きしか積まれず、最初の依頼が目次から抜ける。版を 0 にして先頭から読み直させる。
    stmt(db, "update transcript_files set indexer_version = 0 where session_id = ? and ifnull(agent_id, '') = ?").run(row.session_id, agentKey);
  });
  run();
}

/**
 * 前に索引化したときから、大きさも更新時刻も索引の版も変わっていないか。
 * indexFile が何もせずに返す条件そのもので、呼び手が先に引いた行で同じ判定をして indexFile を呼ばずに済ませるのに使う。
 */
export function isUnchanged(tf: { size: number; mtime: number; indexer_version: number }, stat: FileStat, version = INDEXER_VERSION): boolean {
  return tf.indexer_version === version && tf.size === stat.size && tf.mtime === Math.floor(stat.mtimeMs);
}


/**
 * 1 つの transcript ファイルを索引化する。
 * 前回から size も mtime も版も変わっていなければ何もしない。
 * 版が違うか、ファイルが短くなっていたら、そのファイル分の索引を消して先頭から作り直す。
 * DB に置くのはバイト位置と検索用の本文だけで、記録そのものは保存しない。
 */
export function indexFile(db: Db, file: TranscriptFile, opts: IndexFileOptions): IndexFileResult {
  const version = opts.indexerVersion ?? INDEXER_VERSION;
  const stat = opts.stat ?? fs.statSync(file.path);
  const tf = stmt(db, 'select * from transcript_files where path = ?').get(file.path) as TfRow | undefined;
  const remote = opts.remote === true;
  // 論理削除したセッションと、行のまだ届いていない他端末の写しは、読まずに見送る（write.ts の skipWrite）。
  const known = tf
    ? (stmt(db, 'select id, deleted_at from sessions where id = ?').get(tf.session_id) as SessionRow | undefined)
    : sessionRow(db, file.sessionId, opts.reader.agent);
  const skip = skipWrite(known, remote && !tf);
  if (skip) return { ...skip, providerSessionId: file.sessionId, changed: false, badLines: 0 };
  const sameVersion = tf?.indexer_version === version;
  if (tf && isUnchanged(tf, stat, version)) {
    return { sessionId: tf.session_id, providerSessionId: file.sessionId, appended: 0, changed: false, badLines: 0, artifactIds: [], skipped: false };
  }
  const from = tf && sameVersion ? tf.indexed_bytes : 0;
  const batch = opts.reader.read(file, from);
  let written = { sessionId: '', appended: 0, artifactIds: [] as string[] };
  const run = db.transaction(() => {
    written = writeBatch(db, batch, { deviceId: opts.deviceId, remote, cwdFallback: opts.cwdFallback, processStartOf: opts.processStartOf, origin: file.path, sessionId: tf?.session_id ?? known?.id });
    stmt(db, `insert into transcript_files (path, session_id, agent_id, device_id, size, mtime, indexed_bytes, indexer_version, last_error) values (?,?,?,?,?,?,?,?,null)
      on conflict(path) do update set session_id = excluded.session_id, agent_id = excluded.agent_id, device_id = excluded.device_id, size = excluded.size, mtime = excluded.mtime, indexed_bytes = excluded.indexed_bytes, indexer_version = excluded.indexer_version, last_error = null`)
      .run(file.path, written.sessionId, file.agentId, file.deviceId, stat.size, Math.floor(stat.mtimeMs), batch.nextByte, version);
  });
  run();
  return { sessionId: written.sessionId, providerSessionId: file.sessionId, appended: written.appended, changed: true, badLines: batch.badLines, artifactIds: written.artifactIds, skipped: false };
}
