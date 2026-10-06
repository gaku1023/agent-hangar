import { isReturnOn, isReturnTime, localDate, overdueDays, returnDue, returnPastMinutes, type LiveStatus, type ProjectStatus, type SessionDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import { aliveRunOf, liveFilterOfSession, outsideOpenOf, runningSessionIds, type Store } from '../store/store.ts';
import { durationLabel, percentLabel, relativeTime, shortenPaths, shortModel } from './format.ts';
import { presentTodoCandidate } from './project.ts';
import { candidateLabel, presentSessionRow, sortSessions, type SessionRowProps } from './row.ts';
import { dueOn, returnKey } from './sections.ts';

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
/**
 * 実行中の札。
 * intent は Claude がこのターンに書いた意図の 1 文で、書かれていなければ null である（右の欄の「いま」と同じもの。presenters/live.ts）。
 * activity があれば墨の帯にツールと対象を、無ければ note の一言を出す。
 */
export type RunningCard = { id: string; name: string; live: LiveStatus | null; elapsed: string; meta: string; intent: string | null; activity: { tool: string; summary: string } | null; note: string | null; contextPercent: number | null; contextLabel: string };
/**
 * Home のプロジェクトの 1 行に並べる 1 件。counts は 0 でない数だけを並べた文。
 * 数えるのは TODO と確かめるだけにする。実行中と要対応は、すぐ上の札で見えているからである。
 */
export type ProjectMini = { id: string; name: string; status: ProjectStatus; counts: string };
/**
 * 今日戻るの札（C1）。要対応の札の並びに、入力待ちの札の後ろで置く。
 * 戻る日が今日か過ぎた Paused 1 件につき 1 枚。戻る日が欠けたり壊れたりしたものも、利用者が決めるまで出す（returnOn と overdueDays は null）。
 * 動いているセッションは入力待ちか実行中の札に出るので、ここには重ねない。
 * 区切りを付けて休みのまま残っているもの（parked）は実行中に数えないので、戻る日が来ていればここに出る。
 */
export type ReturnCard = { id: string; name: string; projectName: string | null; reason: string; returnOn: string | null; returnTime: string | null; overdueDays: number | null; due: boolean; pastMin: number | null };
/** 確かめるの行のうち、TODO の完了の候補。押すとそのプロジェクトへ移る。 */
export type TodoConfirmCard = { kind: 'todo'; id: string; text: string; projectId: string; projectName: string; sessionName: string; ago: string; note: string };
/**
 * 確かめるの行のうち、セッションの状態の提案（Q3）。label は行の頭の札の文言（「Done にする？」「Paused · 10/3（土）？」）。
 * 確定、日を変える（Paused のときだけ）、却下を行から押せる。名前を押すとそのセッションを開く。
 */
export type SessionConfirmCard = { kind: 'session'; id: string; name: string; projectName: string | null; status: 'paused' | 'done'; label: string; note: string; ago: string };
/** 確かめるの行。TODO の候補とセッションの提案を、候補になった時刻の古い順に混ぜる。 */
export type ConfirmCard = TodoConfirmCard | SessionConfirmCard;
/**
 * idle は何も動いていないこと（実行中の札も要対応の札も無い）で、真なら実行中の札の場所に 1 行の文を出す（試作 home-lists の F1）。
 * 入力待ちも生きたセッションなので、入力待ちがあるときは偽にする。今日戻るの札も要対応に並ぶので、あれば偽にする。
 */
export type HomeProps = { attention: AttentionCard[]; returning: ReturnCard[]; confirm: ConfirmCard[]; running: RunningCard[]; recent: SessionRowProps[]; projects: ProjectMini[]; idle: boolean };

/** 問いの文が取れなかった入力待ち（権限の確認など）に出す文。 */
export const NO_QUESTION = '入力を待っています';
/**
 * 最近に渡す行の上限。何行見せるかは窓の残りの高さで画面が決める（HomeScreen の useFitRows）ので、背の高い窓でも足りる数を渡す。
 * 続きは「すべて見る」からセッション一覧で見る。
 */
export const HOME_RECENT_MAX = 40;
/** 今日戻るの理由が無いときに出す文。 */
const NO_REASON = '理由は書かれていません';
/** 提案の根拠が無いときに出す文。TODO の候補（presenters/project.ts）と同じ言い方にする。 */
const NO_NOTE = '根拠は書かれていません';

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
  // Claude のレジストリに載る前の run も実行中に数える。
  // 信頼確認のダイアログ待ちの run が Home のどこにも出ないと、セッション画面への戻り道がなくなる。
  const alive = runningSessionIds(store);

  // 長く待っているものほど先に答えたいので、最後に動いた時刻の古い順に並べる。
  const waiting = sessions.filter((s) => s.live === 'waiting').sort((a, b) => (a.lastActivityAt ?? now) - (b.lastActivityAt ?? now));
  const attention = waiting.map((s) => ({ id: s.id, name: name(s), projectName: projectName(s), waited: durationLabel(now - (s.lastActivityAt ?? now)), question: s.activity?.question ?? NO_QUESTION, answer: aliveRunOf(store, s.id) ? 'terminal' as const : outsideOpenOf(store, s) }));

  // 今日戻る（C1）。戻る日の古い順で、欠けた日と壊れた日を先頭に、同じ日の中は新しい順にする。
  // 「今日」は手元の暦で、期間の「今日」（mediator/screen.ts の periodStart(1, now)）と同じ境にする。
  const today = localDate(now);
  // 並びの鍵は節の並び（presenters/sections.ts）と同じ式を使う。
  const keyOf = (s: SessionDto) => returnKey({ returnOn: s.state?.returnOn ?? null, returnTime: s.state?.returnTime ?? null });
  const returning = sessions
    .filter((s) => s.state?.status === 'paused' && dueOn(s.state.returnOn, today) && liveFilterOfSession(store, s, alive) === 'ended')
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .map((s): ReturnCard => {
      const on = s.state?.returnOn ?? null;
      const r = on !== null && isReturnOn(on) ? on : null;
      const t = r !== null && typeof s.state?.returnTime === 'string' && isReturnTime(s.state.returnTime) ? s.state.returnTime : null;
      // 当日の時刻つきは、時刻の前から札に出す（朝のうちに今日の予定として見える）。塗るのは時刻を過ぎてからにする。
      return { id: s.id, name: name(s), projectName: projectName(s), reason: s.state?.note || NO_REASON, returnOn: r, returnTime: t, overdueDays: r ? overdueDays(r, now) : null, due: r === null || returnDue(r, t, now), pastMin: r ? returnPastMinutes(r, t, now) : null };
    });

  // 確かめる。TODO の完了の候補とセッションの状態の提案を、候補になった時刻の古い順に混ぜる。
  // 放っておくと溜まるので、長く待っているものほど先に出す。
  const candidates = Object.values(store.todos)
    .map((t) => ({ t, c: presentTodoCandidate(t, store, now) }))
    .filter((x): x is { t: typeof x.t; c: NonNullable<typeof x.c> } => x.c !== null);
  const proposed = sessions.filter((s) => !!s.state?.candidate);
  const confirm = [
    ...candidates.map(({ t, c }): { at: number; card: ConfirmCard } => ({ at: t.candidate!.at, card: { kind: 'todo', id: t.id, text: t.text, projectId: t.projectId, projectName: store.projects[t.projectId]?.name ?? '未分類', sessionName: c.sessionName, ago: c.ago, note: c.note } })),
    ...proposed.map((s): { at: number; card: ConfirmCard } => {
      const c = s.state!.candidate!;
      // 札の文言は行の提案の札（第 1 段の candidateLabel）と同じにする。
      return { at: c.at, card: { kind: 'session', id: s.id, name: name(s), projectName: projectName(s), status: c.status, label: candidateLabel(c), note: c.note || NO_NOTE, ago: relativeTime(c.at, now) } };
    }),
  ].sort((a, b) => (a.at - b.at) || a.card.id.localeCompare(b.card.id)).map((x) => x.card);

  const running = sortSessions(sessions.filter((s) => liveFilterOfSession(store, s, alive) === 'running')).map((s): RunningCard => {
    // 対象が取れない呼び出し（答えた後の AskUserQuestion など）は summary にツール名が入る。同じ語を 2 度並べないよう空にする。
    // summary の先頭に「ツール名+半角空白」が付くこともある（サーバの toolSummary が付けた分）。カードはツール名を <i> で先に出すので、その重なりを削る。
    const activity = s.live === 'busy' && s.activity ? { tool: s.activity.tool, summary: shortenPaths(stripLeadingTool(s.activity.tool, s.activity.summary)) } : null;
    const note = activity ? null : s.live === 'idle' ? `休み。最後の返答から ${durationLabel(now - (s.lastActivityAt ?? now))}` : s.live === 'busy' ? '作業中' : '起動しています';
    const meta = [projectName(s) ?? '未分類', shortModel(s.stats.model), s.stats.effort ?? ''].filter((x) => x !== '').join(' · ');
    // 意図は作業中の間だけ出す。前のターンの意図は、いまの作業を言っていないので出さない。
    const said = store.liveDigests[s.id]?.intent;
    const intent = s.live === 'busy' && said && said.inThisTurn ? said.text : null;
    return { id: s.id, name: name(s), live: s.live, elapsed: durationLabel(now - (s.startedAt ?? now)), meta, intent, activity, note, contextPercent: s.stats.contextPercent, contextLabel: percentLabel(s.stats.contextPercent) };
  });

  // 札に出したものは最近に重ねない。
  const shown = new Set([...attention.map((c) => c.id), ...returning.map((c) => c.id), ...running.map((c) => c.id)]);
  // 行を組むのは渡す分だけにする。ホームではページを送らない。
  const ended = sessions.filter((s) => !shown.has(s.id)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const recent = ended.slice(0, HOME_RECENT_MAX).map((s) => presentSessionRow(s, store, now));

  const projects = Object.values(store.projects).filter((p) => p.status === 'active' && !p.isScratch).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map((p): ProjectMini => {
    // 確かめるは TODO の候補とセッションの提案を合わせて数える。
    const confirmHere = candidates.filter(({ t }) => t.projectId === p.id).length + proposed.filter((s) => s.projectId === p.id).length;
    const counts: [string, number][] = [['TODO', p.openTodoCount], ['確かめる', confirmHere]];
    return { id: p.id, name: p.name, status: p.status, counts: counts.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`).join(' · ') };
  });

  return { attention, returning, confirm, running, recent, projects, idle: attention.length === 0 && running.length === 0 };
}
