import type { LiveStatus, ProjectStatus, SessionDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { aliveRunOf, liveFilterOfSession, outsideOpenOf, runningSessionIds, type Store } from '../store/store.ts';
import { durationLabel, percentLabel, shortModel } from './format.ts';
import { presentTodoCandidate } from './project.ts';
import { liveCountsOf } from './projects.ts';
import { presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';

/**
 * 要対応の札。入力待ちのセッション 1 件につき 1 枚。
 * answer は札から答える手である。
 * terminal は hangar の生きた run があり、その端末を開いて答えられること。
 * 入力待ちはマシン全体の Claude のレジストリから来るので、hangar の run が無いものも載る。
 * attach は Claude のバックグラウンドのサービスが持つもので、hangar からつないで答えられる。
 * adopt は別のターミナル（VS Code など）で動くもので、引き取れば hangar の端末で答えられる。
 * どれでもなければ null で、端末は開けない。
 */
export type AttentionCard = { id: string; name: string; projectName: string | null; waited: string; question: string; answer: 'terminal' | 'attach' | 'adopt' | null };
/** 実行中の札。activity があれば墨の地にツールと対象を、無ければ note の一言を出す。 */
export type RunningCard = { id: string; name: string; live: LiveStatus | null; elapsed: string; meta: string; activity: { tool: string; summary: string } | null; note: string | null; contextPercent: number | null; contextLabel: string };
/** Home のプロジェクトの小さな一覧の 1 行。counts は 0 でない数だけを並べた文。 */
export type ProjectMini = { id: string; name: string; status: ProjectStatus; counts: string };
/** 確かめるの行。完了の候補 1 件につき 1 行で、押すとそのプロジェクトへ移る。 */
export type ConfirmCard = { id: string; text: string; projectId: string; projectName: string; sessionName: string; ago: string; note: string };
export type HomeProps = { attention: AttentionCard[]; confirm: ConfirmCard[]; running: RunningCard[]; recent: SessionRowProps[]; projects: ProjectMini[] };

/** 問いの文が取れなかった入力待ち（権限の確認など）に出す文。 */
const NO_QUESTION = '入力を待っています';
const RECENT_LIMIT = 30;

/** summary がツール名そのもの、または「ツール名+半角空白」で始まるなら、その分を削る。 */
function stripLeadingTool(tool: string, summary: string): string {
  if (summary === tool) return '';
  const prefix = `${tool} `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

export function presentHome(_state: State, store: Store, now: number): HomeProps {
  const sessions = Object.values(store.sessions);
  const projectName = (s: SessionDto) => (s.projectId ? store.projects[s.projectId]?.name ?? null : null);
  const name = (s: SessionDto) => s.name ?? '（名前なし）';

  // 長く待っているものほど先に答えたいので、最後に動いた時刻の古い順に並べる。
  const waiting = sessions.filter((s) => s.live === 'waiting').sort((a, b) => (a.lastActivityAt ?? now) - (b.lastActivityAt ?? now));
  const attention = waiting.map((s) => ({ id: s.id, name: name(s), projectName: projectName(s), waited: durationLabel(now - (s.lastActivityAt ?? now)), question: s.activity?.question ?? NO_QUESTION, answer: aliveRunOf(store, s.id) ? 'terminal' as const : outsideOpenOf(store, s) }));

  // 完了の候補。放っておくと溜まるので、長く待っているものほど先に出す。
  const candidates = Object.values(store.todos)
    .map((t) => ({ t, c: presentTodoCandidate(t, store, now) }))
    .filter((x): x is { t: typeof x.t; c: NonNullable<typeof x.c> } => x.c !== null)
    .sort((a, b) => (a.t.candidate!.at - b.t.candidate!.at) || a.t.id.localeCompare(b.t.id));
  const confirm = candidates.map(({ t, c }): ConfirmCard => ({ id: t.id, text: t.text, projectId: t.projectId, projectName: store.projects[t.projectId]?.name ?? '未分類', sessionName: c.sessionName, ago: c.ago, note: c.note }));

  // Claude のレジストリに載る前の run も実行中に数える。
  // 信頼確認のダイアログ待ちの run が Home のどこにも出ないと、セッション画面への戻り道がなくなる。
  const alive = runningSessionIds(store);
  const running = sortSessions(sessions.filter((s) => liveFilterOfSession(store, s, alive) === 'running')).map((s): RunningCard => {
    // 対象が取れない呼び出し（答えた後の AskUserQuestion など）は summary にツール名が入る。同じ語を 2 度並べないよう空にする。
    // summary の先頭に「ツール名+半角空白」が付くこともある（サーバの toolSummary が付けた分）。カードはツール名を <i> で先に出すので、その重なりを削る。
    const activity = s.live === 'busy' && s.activity ? { tool: s.activity.tool, summary: stripLeadingTool(s.activity.tool, s.activity.summary) } : null;
    const note = activity ? null : s.live === 'idle' ? `休み。最後の返答から ${durationLabel(now - (s.lastActivityAt ?? now))}` : s.live === 'busy' ? '作業中' : '起動しています';
    const meta = [projectName(s) ?? '未分類', shortModel(s.stats.model), s.stats.effort ?? ''].filter((x) => x !== '').join(' · ');
    return { id: s.id, name: name(s), live: s.live, elapsed: durationLabel(now - (s.startedAt ?? now)), meta, activity, note, contextPercent: s.stats.contextPercent, contextLabel: percentLabel(s.stats.contextPercent) };
  });

  // 札に出したものは最近に重ねない。
  const shown = new Set([...attention.map((c) => c.id), ...running.map((c) => c.id)]);
  const recent = sessions.filter((s) => !shown.has(s.id)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, RECENT_LIMIT).map((s) => presentSessionRow(s, store, now));

  const projects = Object.values(store.projects).filter((p) => p.status === 'active' && !p.isScratch).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map((p): ProjectMini => {
    // 実行中と入力待ちは、プロジェクトのカードと同じく手元のセッションから数える。入力待ちは要対応として別に数える。
    const live = liveCountsOf(store, p.id, alive);
    const confirmHere = candidates.filter(({ t }) => t.projectId === p.id).length;
    const counts: [string, number][] = [['実行中', live.running], ['TODO', p.openTodoCount], ['要対応', live.waiting], ['確かめる', confirmHere]];
    return { id: p.id, name: p.name, status: p.status, counts: counts.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`).join(' · ') };
  });

  return { attention, confirm, running, recent, projects };
}
