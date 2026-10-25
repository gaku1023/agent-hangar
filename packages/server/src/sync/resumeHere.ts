import type { LaunchResultDto, ResumeHereConflictDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { RunError } from '../runs/manager.ts';
import { copyTranscriptForResume } from './copy.ts';
import { resumeOpencodeHere, type OpencodeResumeDeps } from './opencodeResume.ts';
import { msg } from '../i18n/message.ts';

export type ResumeHereDeps = {
  db: Db; home: string; claudeDir: string;
  /**
   * 写す前の確かめ。RunManager.resumeCwdOf を渡す。この PC で起こせない会話（この PC にプロジェクトの場所が無い）なら投げる。
   * 写してから再開で断ると、~/.claude に本文だけが残り、利用者には 400 しか見えない。
   */
  check?: (sessionId: string) => void;
  /** 写し終えたあとの再開。RunManager.resume を渡す。 */
  resume: (sessionId: string) => LaunchResultDto;
  /** 本文の控えの世代を刈る。 */
  pruneTranscripts: () => void;
  /** 試験が写しの結果を差し替える口。既定は copyTranscriptForResume である。 */
  copy?: typeof copyTranscriptForResume;
};

/** 他端末の本文を手元に写してから再開する。~/.claude への本文の書き込みはここだけを通る。 */
export function resumeHere(deps: ResumeHereDeps, sessionId: string, overwrite: boolean): LaunchResultDto | ResumeHereConflictDto {
  deps.check?.(sessionId);
  const r = (deps.copy ?? copyTranscriptForResume)({ db: deps.db, home: deps.home, claudeDir: deps.claudeDir, sessionId, overwrite });
  if (r.kind === 'ask') return { error: 'local_smaller', localSize: r.localSize, remoteSize: r.remoteSize };
  if (r.kind === 'none') throw new RunError(400, msg('sync.resume.noTranscript'));
  // 控えを取った回だけ刈る。控えはもうファイルになっているので、ここで転んでも書き戻しには響かない。
  if (r.kind === 'copied' && r.backedUp !== null) deps.pruneTranscripts();
  return deps.resume(sessionId);
}

/**
 * 「この PC で再開」を会話のエージェントで振り分ける。
 * Claude は今までどおり本文を ~/.claude に写して再開する（同期のまま返す）。
 * opencode は降ろした export を opencode に取り込んでから再開する（sync/opencodeResume.ts）。serve を起こすので約束で返す。
 * opencode の口は使うときにだけ組む（serve の管理は同期より後に組まれるため）。
 */
export function resumeHereFor(
  o: { db: Db; claude: ResumeHereDeps; opencode: () => OpencodeResumeDeps },
  sessionId: string,
  overwrite: boolean,
): LaunchResultDto | ResumeHereConflictDto | Promise<LaunchResultDto | ResumeHereConflictDto> {
  const row = o.db.prepare('select provider from sessions where id = ? and deleted_at is null').get(sessionId) as { provider: string } | undefined;
  if (row?.provider === 'opencode') return resumeOpencodeHere(o.opencode(), sessionId, overwrite);
  return resumeHere(o.claude, sessionId, overwrite);
}
