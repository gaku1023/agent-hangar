import type { LiveStatus, ProjectStatus, SessionDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { aliveRunOf, runningSessionIds, type Store } from '../store/store.ts';
import { durationLabel, percentLabel, shortModel } from './format.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

/**
 * 要対応の札。入力待ちのセッション 1 件につき 1 枚。
 * canAnswer は hangar の生きた run があり、端末を開いて答えられること。
 * 入力待ちはマシン全体の Claude のレジストリから来るので、別のターミナル（iTerm など）で動くセッションは canAnswer が false になる。
 */
export type AttentionCard = { id: string; name: string; projectName: string | null; waited: string; question: string; canAnswer: boolean };
/** 実行中の札。activity があれば墨の地にツールと対象を、無ければ note の一言を出す。 */
export type RunningCard = { id: string; name: string; live: LiveStatus | null; elapsed: string; meta: string; activity: { tool: string; summary: string } | null; note: string | null; contextPercent: number | null; contextLabel: string };
/** Home のプロジェクトの小さな一覧の 1 行。counts は 0 でない数だけを並べた文。 */
export type ProjectMini = { id: string; name: string; status: ProjectStatus; counts: string };
export type HomeProps = { attention: AttentionCard[]; running: RunningCard[]; recent: SessionRowProps[]; projects: ProjectMini[] };

/** 問いの文が取れなかった入力待ち（権限の確認など）に出す文。 */
const NO_QUESTION = '入力を待っています';
const RECENT_LIMIT = 30;

export function presentHome(_state: State, store: Store, now: number): HomeProps {
  const sessions = Object.values(store.sessions);
  const projectName = (s: SessionDto) => (s.projectId ? store.projects[s.projectId]?.name ?? null : null);
  const name = (s: SessionDto) => s.name ?? '（名前なし）';

  // 長く待っているものほど先に答えたいので、最後に動いた時刻の古い順に並べる。
  const waiting = sessions.filter((s) => s.live === 'waiting').sort((a, b) => (a.lastActivityAt ?? now) - (b.lastActivityAt ?? now));
  const attention = waiting.map((s) => ({ id: s.id, name: name(s), projectName: projectName(s), waited: durationLabel(now - (s.lastActivityAt ?? now)), question: s.activity?.question ?? NO_QUESTION, canAnswer: aliveRunOf(store, s.id) !== null }));

  // Claude のレジストリに載る前の run も実行中に数える。
  // 信頼確認のダイアログ待ちの run が Home のどこにも出ないと、セッション画面への戻り道がなくなる。
  const alive = runningSessionIds(store);
  const running = sortSessions(sessions.filter((s) => s.live === 'busy' || s.live === 'idle' || (s.live === null && alive.has(s.id)))).map((s): RunningCard => {
    // 対象が取れない呼び出し（答えた後の AskUserQuestion など）は summary にツール名が入る。同じ語を 2 度並べないよう空にする。
    const activity = s.live === 'busy' && s.activity ? { tool: s.activity.tool, summary: s.activity.summary === s.activity.tool ? '' : s.activity.summary } : null;
    const note = activity ? null : s.live === 'idle' ? `休み。最後の返答から ${durationLabel(now - (s.lastActivityAt ?? now))}` : s.live === 'busy' ? '作業中' : '起動しています';
    const meta = [projectName(s) ?? '未分類', shortModel(s.stats.model), s.stats.effort ?? ''].filter((x) => x !== '').join(' · ');
    return { id: s.id, name: name(s), live: s.live, elapsed: durationLabel(now - (s.startedAt ?? now)), meta, activity, note, contextPercent: s.stats.contextPercent, contextLabel: percentLabel(s.stats.contextPercent) };
  });

  // 札に出したものは最近に重ねない。
  const shown = new Set([...attention.map((c) => c.id), ...running.map((c) => c.id)]);
  const recent = sessions.filter((s) => !shown.has(s.id)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, RECENT_LIMIT).map((s) => presentSessionRow(s, store, now));

  const projects = Object.values(store.projects).filter((p) => p.status === 'active' && !p.isScratch).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map((p): ProjectMini => {
    // サーバの runningCount は入力待ちも数える。入力待ちは要対応に出すので、Home の実行中の区画と同じく実行中からは引く。
    const waitingHere = waiting.filter((s) => s.projectId === p.id).length;
    const counts: [string, number][] = [['実行中', Math.max(0, p.runningCount - waitingHere)], ['TODO', p.openTodoCount], ['要対応', waitingHere]];
    return { id: p.id, name: p.name, status: p.status, counts: counts.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`).join(' · ') };
  });

  return { attention, running, recent, projects };
}
