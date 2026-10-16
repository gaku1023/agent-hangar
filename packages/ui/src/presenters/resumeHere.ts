import { osName, type ResumeHerePlanDto, type SessionDto, type Translate } from '@agent-hangar/shared';
import { homePath } from '../lib/paths.ts';
import type { Store } from '../store/store.ts';
import { absoluteTime, relativeTime } from './format.ts';
import { unresolvedKind } from './unresolved.ts';

/**
 * 「この PC で再開」を押せるか（ほかの PC で進めた会話）。
 * disabled は押せない理由で、この PC にプロジェクトのフォルダが無いことを言う。
 * ほかの PC で実行中（生きたロック）は理由にしない。押すと、停止して引き継ぐ確認の 1 枚が出る。
 * noRoot は、この PC にプロジェクトのフォルダが無いときの理由と、場所を指定する先のプロジェクト。セッション画面は見出しの下に常に出す（1a）。
 * プロジェクトに属さない会話とスクラッチは、場所では止めない（サーバは前の cwd で起こす）。
 * ほかの PC の会話（写しだけか、ほかの PC のロックがあるか、ほかの PC の続きの方が新しい）でなければ null。
 */
export type ResumeHereFacts = { disabled: string | null; noRoot: { reason: string; projectId: string } | null };

export function resumeHereOf(store: Store, s: SessionDto, t: Translate): ResumeHereFacts | null {
  // 古いサーバの行や試験の行は lock を持たないことがあるので、無いものとして読む。
  const lock = s.lock ?? null;
  // ほかの PC の続きの方が新しい会話（A → B → A）は、手元にトランスクリプトがあっても「この PC で再開」に回す。
  if (!s.remoteOnly && lock === null && s.newerElsewhere !== true) return null;
  const p = s.projectId ? store.projects[s.projectId] : undefined;
  const lost = p !== undefined && unresolvedKind(p) !== null;
  const reason = t('session.action.resumeHereNoRoot');
  const noRoot = lost ? { reason, projectId: p.id } : null;
  return { disabled: noRoot ? reason : null, noRoot };
}

/**
 * 確認の 1 枚の、PC 1 台分のカード。at は前の PC の最後に使った日時の行で、この PC では null。path が null ならこの PC で場所が決まっていない。
 * note はパスの下に添える 1 行で、ほかの PC のクイックセッションをこの PC の置き場に作って再開するときだけ出す（試作の 6A）。
 */
export type ResumeHereCard = { label: string; name: string; os: string | null; path: string | null; at: string | null; note: string | null };
/**
 * 確認の 1 枚の種類。resume はほかの PC で動いていない会話（今までの再開）、
 * takeover は相手が生きていて、停止を頼んでから引き継ぐ（試作の 1 の A1）、
 * stale は相手が応答していなくて、頼まずにそのまま引き継ぐ（試作の 3 の下の 1 枚）。
 */
export type ResumeHereMode = 'resume' | 'takeover' | 'stale';
/**
 * 「この PC で再開」の確認（2 枚のカードと黄の帯、試作の 2a の A、2b の Y、2c の P）。
 * takeover は赤みの帯（takeover のときだけ）で、相手が作業中なら作業中の 2 文、そうでなければ実行中の 2 文。
 * blocked は、この PC で場所が決まらないときの理由で、そのときは再開のボタンを押せなくする。
 * replace は、この PC のトランスクリプトを置き換えるときの 1 行（バックアップに残すこと）で、そのとき承諾は上書きつき（overwrite）で送る。
 */
export type ResumeHereProps = {
  sessionId: string; title: string; lead: string;
  from: ResumeHereCard; to: ResumeHereCard;
  band: { strong: string; text: string };
  action: string; blocked: string | null;
  replace: string | null; overwrite: boolean;
  mode: ResumeHereMode; takeover: { strong: string; text: string } | null;
};

/**
 * サーバの ResumeHerePlanDto を、確認の 1 枚にする。
 * この PC のパスはホームを ~ に縮める。前の PC のパスはその PC の形のまま出す（ホームが違うので縮めない）。
 * 日時は一覧の行の絶対時刻と同じ形（YYYY-MM-DD HH:MM）で出す。
 */
export function presentResumeHere(t: Translate, plan: ResumeHerePlanDto, home: string | null, now: number): ResumeHereProps {
  // 古いサーバは lock を送らない。無いものとして読む。
  const lock = plan.lock ?? null;
  const mode: ResumeHereMode = lock === null ? 'resume' : lock.stale ? 'stale' : 'takeover';
  const prev = plan.from.deviceName ?? t('confirm.resumeHere.unknownDevice');
  const device = lock?.deviceName ?? prev;
  const takeover = mode !== 'takeover' || lock === null ? null
    : lock.working ? { strong: t('confirm.takeover.workingStrong', { device }), text: t('confirm.takeover.workingText') }
    : { strong: t('confirm.takeover.runningStrong', { device }), text: t('confirm.takeover.runningText', { device }) };
  const at = mode === 'stale' && lock !== null ? t('confirm.takeover.lastSeen', { when: relativeTime(t, lock.heartbeatAt, now) }) : t('confirm.resumeHere.lastAt', { at: absoluteTime(t, plan.from.lastAt) });
  return {
    sessionId: plan.sessionId,
    title: mode === 'resume' ? t('confirm.resumeHere.title') : mode === 'stale' ? t('confirm.takeover.staleTitle', { device }) : t('confirm.takeover.title'),
    lead: t('confirm.resumeHere.lead', { device: prev }),
    from: { label: t('confirm.resumeHere.from'), name: prev, os: osName(t, plan.from.platform), path: plan.from.path, at, note: null },
    to: { label: t('confirm.resumeHere.to'), name: plan.to.deviceName ?? t('confirm.resumeHere.to'), os: osName(t, plan.to.platform), path: plan.to.path === null ? null : homePath(plan.to.path, home), at: null, note: plan.to.path !== null && plan.to.createsFolder === true ? t('confirm.resumeHere.createQuick') : null },
    band: { strong: t('confirm.resumeHere.notSynced'), text: t('confirm.resumeHere.synced') },
    action: mode === 'resume' ? t('confirm.resumeHere.action') : mode === 'stale' ? t('confirm.takeover.forceAction') : t('confirm.takeover.action'),
    blocked: plan.to.path === null ? t('session.action.resumeHereNoRoot') : null,
    replace: plan.replace === null ? null : t(plan.replace.kind === 'ahead' ? 'confirm.resumeHere.replaceAhead' : 'confirm.resumeHere.replaceDiverged'),
    overwrite: plan.replace !== null,
    mode, takeover,
  };
}
