import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSafeKeyId, type LaunchResultDto, type ResumeHereConflictDto, type ResumeHereReplaceDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { causeOf, msg } from '../i18n/message.ts';
import { opencodeExportDir } from '../provider/opencode/export.ts';
import { OpencodeImportError, type OpencodeTransfer } from '../provider/opencode/transfer.ts';
import { RunError } from '../runs/errors.ts';
import { backupBeforeOverwrite, type RemotePick } from './copy.ts';
import { remoteTranscriptPath } from './puller.ts';

/**
 * opencode の会話の「この PC で再開」（docs/design.md「opencode の本文の同期」）。
 *
 * Claude は降ろした jsonl を ~/.claude に写して `claude -r` で開く（sync/copy.ts）。
 * opencode の本文は opencode の記録の置き場（SQLite）にあり、hangar はそこを読み書きしない。
 * そこで、降ろした export の JSON を `opencode session import --directory <この PC の場所>` で入れてから、ふだんの再開（RunManager.resumeWith）で開く。
 *
 * 手元の会話と写しの比べ方は、Claude の大きさの比べ方ではなく、メッセージの ID で行う。
 * export の JSON は場所（info.location.directory）を含むので、同じ中身でも PC ごとに大きさが変わるからである。
 * - 写しのメッセージが全部手元にある（写しが古いか同じ）なら、取り込まずに手元の会話を開く。
 * - 手元に会話が無ければ、そのまま取り込む。
 * - 写しに手元に無い続きがあれば、Claude と同じく上書きの承認を求め（local_smaller）、承認があれば手元の書き出しの控えを取ってから置き換える。
 *   既にある ID への import は上書きされない（実物の 2.1.4）ので、置き換えは消してから入れる（provider/opencode/transfer.ts）。
 */

/** 写しと手元の比べ。none は写しも手元も無い、kept は手元を開く、import は手元が無いので入れる、ask は置き換えるかを尋ねる。 */
type Decision = { kind: 'none' } | { kind: 'kept' } | { kind: 'import'; pick: RemotePick } | { kind: 'ask'; pick: RemotePick; replace: ResumeHereReplaceDto['kind']; localSize: number };

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** export の JSON のメッセージの ID（古い順）。読めなければ null。 */
function messageIds(file: string): string[] | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { messages?: unknown };
    if (!Array.isArray(v.messages)) return null;
    return v.messages.flatMap((m) => (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? [(m as { id: string }).id] : []));
  } catch {
    return null;
  }
}

/**
 * 手元に降ろした opencode の写しのうち、台帳（file_sync）の指紋と合う最も新しいものを選ぶ。
 * 自分が上げたもの（device が自分）は選ばない。置き場の組み立ては puller の remoteTranscriptPath に任せる。
 */
export function pickRemoteOpencode(db: Db, home: string, self: string, providerSessionId: string): RemotePick | null {
  if (!isSafeKeyId(providerSessionId)) return null;
  const rows = db.prepare("select path, device_id, sha256, size, mtime from file_sync where kind = 'transcript' and key like ? and device_id <> ? order by mtime desc")
    .all(`opencode/%/${providerSessionId}.json.gz`, self) as { path: string; device_id: string; sha256: string; size: number; mtime: number }[];
  for (const r of rows) {
    let p: string;
    try { p = remoteTranscriptPath(home, r.device_id, r.path); } catch { continue; }
    let size: number;
    try { size = fs.statSync(p).size; } catch { continue; }
    if (size !== r.size) continue;
    try { if (sha256File(p) !== r.sha256) continue; } catch { continue; }
    return { deviceId: r.device_id, path: p, size, mtime: r.mtime };
  }
  return null;
}

/** 写しと手元の書き出し（無ければ null）を比べる。 */
function decide(pick: RemotePick | null, localFile: string | null): Decision {
  if (!pick) return localFile ? { kind: 'kept' } : { kind: 'none' };
  if (!localFile) return { kind: 'import', pick };
  const remoteIds = messageIds(pick.path) ?? [];
  const localIds = messageIds(localFile);
  // 手元の書き出しが読めなければ、手元の中身が分からないので置き換えるかを尋ねる。
  if (localIds !== null) {
    const have = new Set(localIds);
    if (remoteIds.every((id) => have.has(id))) return { kind: 'kept' };
  }
  const ahead = localIds !== null && localIds.every((id, i) => remoteIds[i] === id);
  let localSize = 0;
  try { localSize = fs.statSync(localFile).size; } catch { /* 大きさは見せるだけなので 0 のままにする */ }
  return { kind: 'ask', pick, replace: ahead ? 'ahead' : 'diverged', localSize };
}

/** 会話の行。opencode の会話でなければ null。 */
function opencodeRow(db: Db, sessionId: string): { id: string; provider_session_id: string } | null {
  const s = db.prepare("select id, provider_session_id from sessions where id = ? and provider = 'opencode' and deleted_at is null").get(sessionId) as { id: string; provider_session_id: string } | undefined;
  return s && isSafeKeyId(s.provider_session_id) ? s : null;
}

/**
 * 「この PC で再開」の確認に出す、手元の会話を置き換えるか（ResumeHereReplaceDto）。opencode の会話のときだけ答える。
 * 手元は、上げるために書き出した最後のファイル（`~/.agent-hangar/opencode/export/<会話>.json`）で見る。ここでは opencode を起こさない。
 */
export function compareOpencodeForResume(o: { db: Db; home: string; deviceId: string; sessionId: string }): ResumeHereReplaceDto | null {
  const s = opencodeRow(o.db, o.sessionId);
  if (!s) return null;
  const localFile = path.join(opencodeExportDir(o.home), `${s.provider_session_id}.json`);
  const d = decide(pickRemoteOpencode(o.db, o.home, o.deviceId, s.provider_session_id), fs.existsSync(localFile) ? localFile : null);
  return d.kind === 'ask' ? { kind: d.replace, localSize: d.localSize, remoteSize: d.pick.size } : null;
}

export type OpencodeResumeDeps = {
  db: Db;
  home: string;
  deviceId: string;
  /**
   * 取り込む前の確かめと用意。RunManager.prepareResumeDir を渡す。
   * 設定、この PC で動いている run、実行ファイル、場所を確かめ、ほかの PC のクイックセッションのフォルダを作り、再開する場所を返す。
   * import は無い場所を断るので、取り込む前に作っておく。
   */
  prepare: (sessionId: string) => string;
  /** この PC の opencode にある会話を書き出し直し、そのファイルを返す。この PC に会話が無ければ null（OpencodeExporter.export）。 */
  exportLocal: (providerSessionId: string) => Promise<string | null>;
  transfer: Pick<OpencodeTransfer, 'importSession'>;
  /** 取り込みに起こした会話の serve を止める（失敗したとき）。 */
  stopServe: (sessionId: string) => Promise<void>;
  /** 取り込んだあとの再開。RunManager.resumeWith を渡す（opencode は serve を起こし直してから TUI をつなぐ）。 */
  resume: (sessionId: string) => Promise<LaunchResultDto>;
  /** 本文の控えの世代を刈る。 */
  pruneTranscripts: () => void;
  now?: () => number;
};

/** opencode の会話を、ほかの PC の写しで取り込んでから再開する。opencode の記録の置き場への書き込みは、ここ（と新しい起動）だけを通る。 */
export async function resumeOpencodeHere(deps: OpencodeResumeDeps, sessionId: string, overwrite: boolean): Promise<LaunchResultDto | ResumeHereConflictDto> {
  const s = opencodeRow(deps.db, sessionId);
  if (!s) throw new RunError(400, msg('sync.resume.noTranscript'));
  const cwd = deps.prepare(sessionId);
  const localFile = await deps.exportLocal(s.provider_session_id);
  const d = decide(pickRemoteOpencode(deps.db, deps.home, deps.deviceId, s.provider_session_id), localFile);
  if (d.kind === 'none') throw new RunError(400, msg('sync.resume.noTranscript'));
  if (d.kind === 'ask' && !overwrite) return { error: 'local_smaller', localSize: d.localSize, remoteSize: d.pick.size };
  if (d.kind === 'kept') return deps.resume(sessionId);
  let backedUp = false;
  if (d.kind === 'ask' && localFile) {
    try {
      backupBeforeOverwrite(localFile, deps.home, s.provider_session_id, (deps.now ?? Date.now)(), '.json');
      backedUp = true;
    } catch (e) {
      // 控えが取れないなら置き換えない。何を消したか後から追えない上書きは作らない（Claude と同じ）。
      throw new RunError(409, msg('sync.copy.backupFailed', { cause: causeOf(e) }));
    }
  }
  try {
    await deps.transfer.importSession({ hangarSessionId: sessionId, providerSessionId: s.provider_session_id, file: d.pick.path, directory: cwd, replace: d.kind === 'ask' });
  } catch (e) {
    await deps.stopServe(sessionId).catch(() => undefined);
    const reason = e instanceof OpencodeImportError ? e.reason : causeOf(e);
    throw new RunError(400, msg('sync.resume.opencodeImportFailed', { reason }));
  }
  if (backedUp) deps.pruneTranscripts();
  return deps.resume(sessionId);
}
