import type { LaunchResultDto, ResumeHereConflictDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { RunError } from '../runs/manager.ts';
import { copyTranscriptForResume } from './copy.ts';

export type ResumeHereDeps = {
  db: Db; home: string; claudeDir: string;
  /** 写し終えたあとの再開。RunManager.resume を渡す。 */
  resume: (sessionId: string) => LaunchResultDto;
  /** 本文の控えの世代を刈る。 */
  pruneTranscripts: () => void;
  /** 試験が写しの結果を差し替える口。既定は copyTranscriptForResume である。 */
  copy?: typeof copyTranscriptForResume;
};

/** 他端末の本文を手元に写してから再開する。~/.claude への本文の書き込みはここだけを通る。 */
export function resumeHere(deps: ResumeHereDeps, sessionId: string, overwrite: boolean): LaunchResultDto | ResumeHereConflictDto {
  const r = (deps.copy ?? copyTranscriptForResume)({ db: deps.db, home: deps.home, claudeDir: deps.claudeDir, sessionId, overwrite });
  if (r.kind === 'ask') return { error: 'local_smaller', localSize: r.localSize, remoteSize: r.remoteSize };
  if (r.kind === 'none') throw new RunError(400, 'このセッションの本文がありません');
  // 控えを取った回だけ刈る。控えはもうファイルになっているので、ここで転んでも書き戻しには響かない。
  if (r.kind === 'copied' && r.backedUp !== null) deps.pruneTranscripts();
  return deps.resume(sessionId);
}
