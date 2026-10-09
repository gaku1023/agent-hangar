import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import type { NoticeEvent } from '../events/publisher.ts';
import type { IndexerListener } from '../indexer/service.ts';
import { assignSession, registerWorkspaceChildOf } from './registry.ts';
import type { GetLanguage } from '../i18n/language.ts';
import { translatorOf } from '../i18n/message.ts';

type SessionChanged = Parameters<NonNullable<IndexerListener['sessionChanged']>>[0];

export type SessionChangeDeps = {
  db: Db; deviceId: string;
  hub: { broadcast(ev: NoticeEvent): void };
  /** 知らせの文の言語。 */
  language: GetLanguage;
  /**
   * 起動の手続きが済んだか。
   * 最初の全走査では未分類のセッションを数えきれないほど流すので、知らせるのもその場の登録も起動後だけにする。
   */
  started: () => boolean;
  /** ワークスペースの置き場。設定は書き替わるので、呼ばれた時点の値を読む。 */
  workspaceRoot: () => string;
  /** 手元の本文が動いたときに呼ぶ。同期の上げ手へ渡す。 */
  onLocalTranscript?: (f: { path: string; sessionId: string; agentId: string | null }) => void;
};

/**
 * 索引が「セッションが変わった」と知らせたときの受け手を作る。IndexerService.on の sessionChanged に渡す。
 *
 * セッションの行（session.upsert）は、索引が行の変化の口へ知らせ、events/publisher.ts が配る。
 * ここが受け持つのは、プロジェクトへの紐づけと、行に対応しない知らせである。
 *
 * どのルートの配下でもない cwd のセッションは「未分類」に残る（設計どおり）。
 * ただし黙って残ると利用者は気付けないので、セッションごとに 1 度だけ知らせる。
 * ワークスペース直下のフォルダは、その場でプロジェクトにするので、知らせるのはワークスペースの外だけである。
 * 外のフォルダで勝手にプロジェクトを作ることはしない。紐づけは利用者が決める。
 */
export function createSessionChangeHandler(deps: SessionChangeDeps): (e: SessionChanged) => void {
  const { db, deviceId, hub } = deps;
  const tr = translatorOf(deps.language);
  // 未分類だと知らせたセッション。本文が伸びるたびに同じ知らせを出さないために持つ。
  const toldUnassigned = new Set<string>();
  // その場の自動登録を試したセッション。本文が伸びるたびにディスクを見に行かないために持つ。
  const triedRegister = new Set<string>();
  const tellUnassigned = (sessionId: string, cwd: string): void => {
    if (!deps.started() || toldUnassigned.has(sessionId)) return;
    toldUnassigned.add(sessionId);
    hub.broadcast({ type: 'toast', level: 'info', message: tr('project.unassigned.appeared', { cwd }) });
  };
  return (e) => {
    // 手元のファイルだけを上げる。他端末の写し（deviceId が入っているもの）は持ち主が上げる。
    if (e.deviceId === null) deps.onLocalTranscript?.({ path: e.path, sessionId: e.providerSessionId, agentId: e.agentId });
    // 起動後に現れたセッションは project_id が空のままなので、ここで紐づける。
    const row = db.prepare('select project_id, cwd from sessions where id = ? and deleted_at is null').get(e.sessionId) as { project_id: string | null; cwd: string } | undefined;
    // 消されたセッションは配らない。
    if (!row) return;
    let assigned = row.project_id === null ? assignSession(db, deviceId, e.sessionId) : null;
    // 当たるルートが無ければ、ワークスペース直下の新しいフォルダかを見て、起動時と同じ規則でその場でプロジェクトにする。
    // 起動の途中は syncProjectsFromWorkspace が受け持つので行わない。同じセッションで何度も試さない。
    if (row.project_id === null && !assigned && deps.started() && !triedRegister.has(e.sessionId)) {
      triedRegister.add(e.sessionId);
      if (registerWorkspaceChildOf(db, deviceId, deps.workspaceRoot(), row.cwd)) assigned = assignSession(db, deviceId, e.sessionId);
    }
    // 紐づいたプロジェクトは、行は書いていないが中身（セッションの数と最終活動）が変わったので、配り直しを頼む。
    if (assigned) touchRow(db, 'projects', assigned);
    else if (row.project_id === null) tellUnassigned(e.sessionId, row.cwd);
    if (e.appended > 0) hub.broadcast({ type: 'transcript.appended', sessionId: e.sessionId, count: e.appended });
    // 索引化が拾ったアーティファクト。書いたときにも知らせてあるが、本文の伸びの後に並ぶよう、ここでもう一度名指しする。
    for (const id of e.artifactIds) touchRow(db, 'artifacts', id);
  };
}
