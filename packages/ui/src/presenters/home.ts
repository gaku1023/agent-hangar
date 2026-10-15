import { asideFree, asideHead, asideOf } from '../lib/aside.ts';
import { presentGitChip, type GitChipProps } from './git.ts';
import { setupGuidePrompt, candidateDaysLeft, isReturnOn, isReturnTime, limitKindText, liveWithLimit, overdueDays, quietLive, resetAtText, returnDue, returnPastMinutes, stopReasonOf, type CandidateSource, type UiAction, type LiveStatus, type PermissionAskDto, type ProjectStatus, type SessionDto, type StopReason, type Translate } from '@agent-hangar/shared';
import { SEARCH_STEP, usesServerSearch } from '../mediator/screen.ts';
import type { State } from '../mediator/types.ts';
import type { IconName } from '../views/primitives/Icon.tsx';
import type { OverlapProps } from './overlap.ts';
import { aliveRunOf, awaitsAnswer, liveFilterOfSession, outsideOpenOf, runningSessionIds, shownAside, type Store } from '../store/store.ts';
import { durationLabel, percentLabel, relativeTime, shortenPaths, shortModel } from './format.ts';
import { presentTodoCandidate } from './project.ts';
import { translatorOf } from './i18n.ts';
import { projectDisplayName } from './projectName.ts';
import { liveReadiness, presentReadiness } from './readiness.ts';
import { presentInterrupted } from './interrupted.ts';
import { withOverlaps } from './overlap.ts';
import { presentSessionMenu, type SessionMenuProps } from './sessionMenu.ts';
import { presentSameFolder, presentUnresolved } from './unresolved.ts';
import { candidateLabel, returnHasCome, returnKey, returnOnLabel, sortSessions } from './row.ts';
import { presentSessionList, type SessionListProps } from './sessions.ts';

/**
 * 要対応の札。入力待ちのセッション 1 件につき 1 枚。
 * answer は札から答える手である。
 * terminal は hangar の生きた run があり、その端末を開いて答えられること。
 * 入力待ちはマシン全体の Claude のレジストリから来るので、hangar の run が無いものも載る。
 * attach は Claude のバックグラウンドのサービスが持つもので、hangar からつないで答えられる。
 * adopt は別のターミナル（VS Code など）で動くもので、引き取れば hangar の端末で答えられる。
 * どれでもなければ null で、端末は開けない。
 * reason は止まっている理由（試作 stop-reason-proto の B1）。permission は許可待ちで、permission にその中身（道具と命令）を持つ。
 * reset はリセット済みで、waited はリセットの時刻からの経過になる。どちらでもなければ問いの入力待ちである。
 */
export type AttentionCard = { id: string; name: string; projectName: string | null; waited: string; question: string; answer: 'terminal' | 'attach' | 'adopt' | null; reason?: StopReason | null; permission?: PermissionAskDto | null };
/**
 * 実行中の札。
 * intent は Claude がこのターンに書いた意図の 1 文で、書かれていなければ null である（右の欄の「いま」と同じもの。presenters/live.ts）。
 * activity があれば墨の帯にツールと対象を、無ければ note の一言を出す。
 * aside は裏だけ動いていること。そのときは activity も intent も出さず、note で裏のものと指揮役が空いていることを言う。
 * limit は使用制限でリセットを待っていること。text は枠とリセットの時刻と自動で続くか、left はリセットまでの残り（過ぎていれば空）である。
 */
export type RunningCard = { id: string; name: string; live: LiveStatus | null; aside: boolean; elapsed: string; meta: string; intent: string | null; activity: { tool: string; summary: string } | null; note: string | null; contextPercent: number | null; contextLabel: string; limit?: { text: string; left: string } | null;
  /** git の札（試作の 2-2 の A）。右端の、経過とコンテキストの左に置く。まだ届いていないものと git でないものは null。省けば出さない。 */
  git?: GitChipProps | null };
/**
 * 今日戻るの札（C1）。要対応の札の並びに、入力待ちの札の後ろで置く。
 * 戻る時点が来た Paused 1 件につき 1 枚。日付だけのものはその日の朝から、時刻つきのものは時刻を過ぎてから出す（returnHasCome）。
 * 日付なしは出さない（利用者が選んだもの。一覧の Paused で見る）。暦に無い日のものは、利用者が決めるまで出す（returnOn と overdueDays は null）。
 * 動いているセッションは入力待ちか実行中の札に出るので、ここには重ねない。
 * Paused は休みになっても止めない（parked にならない）ので、Claude が残っている間は実行中の札に出て、ここには出ない。
 */
export type ReturnCard = { id: string; name: string; projectName: string | null; reason: string; returnOn: string | null; returnTime: string | null; overdueDays: number | null; due: boolean; pastMin: number | null };
/** 確かめるの行のうち、TODO の完了の候補。押すとそのプロジェクトへ移る。 */
export type TodoConfirmCard = { kind: 'todo'; id: string; text: string; projectId: string; projectName: string; sessionName: string; ago: string; note: string };
/**
 * 確かめるの行のうち、セッションの状態の提案（Q3）。label は行の頭の札の文言（「Done にする？」「Paused · 10/3（土）？」）。
 * 確定、日を変える（Paused のときだけ）、却下を行から押せる。名前を押すとそのセッションを開く。
 * source は提案の出どころ（会話の中か、事後の要約か）、daysLeft は Done の提案が自動で確定するまでの残りの日数で、Paused の提案では null（2026-10-13 の決定、知らせの 9d）。
 */
export type SessionConfirmCard = { kind: 'session'; id: string; name: string; projectName: string | null; status: 'paused' | 'done'; label: string; note: string; ago: string; source: CandidateSource; daysLeft: number | null };
/** 確かめるの行。TODO の候補とセッションの提案を、候補になった時刻の古い順に混ぜる。 */
export type ConfirmCard = TodoConfirmCard | SessionConfirmCard;
/**
 * 帯の引き出しの行になる 4 つの群の中身。要対応（入力待ちと今日戻る）、確認待ち、実行中である。
 * 引き出しの行は presentHomeBand が作る。
 */
export type HomeCards = { attention: AttentionCard[]; returning: ReturnCard[]; confirm: ConfirmCard[]; running: RunningCard[] };

/** 使用制限の 1 行（枠、リセットの時刻、自動で続くか）と、リセットまでの残り。 */
export function limitCardOf(t: Translate, limit: NonNullable<SessionDto['limit']>, now: number): { text: string; left: string } {
  const time = resetAtText(t, limit.resetsAt, now);
  const auto = t(limit.auto ? 'stop.limit.auto' : 'stop.limit.noAuto');
  const text = limit.kind === 'other' ? t('stop.limit.lineOther', { time, auto }) : t('stop.limit.line', { kind: limitKindText(t, limit.kind), time, auto });
  const left = limit.resetsAt > now ? t('stop.limit.left', { time: durationLabel(t, limit.resetsAt - now) }) : '';
  return { text, left };
}

/** 問いの文が取れなかった入力待ち（権限の確認など）に出す文。 */
export const noQuestionText = (t: Translate): string => t('home.card.noQuestion');

/** summary がツール名そのもの、または「ツール名+半角空白」で始まるなら、その分を削る。 */
function stripLeadingTool(tool: string, summary: string): string {
  if (summary === tool) return '';
  const prefix = `${tool} `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

/**
 * 今日戻るに出すか。Paused で戻る時点が来ていて、終わっているもの（区切りを付けて休みのまま残っているものを含む）と、
 * Claude Code が休みのまま生きているもの（Paused は自動で止めないため。#206）。
 * 作業中のもの（裏の作業だけが動いているものを含む）は実行中に、入力待ちは要対応の入力待ちに出るので、ここには重ねない。
 */
export function returnsNow(store: Store, s: SessionDto, now: number, alive: Set<string> = runningSessionIds(store)): boolean {
  if (s.state?.status !== 'paused' || !returnHasCome(s.state.returnOn, s.state.returnTime, now)) return false;
  const filter = liveFilterOfSession(store, s, alive);
  if (filter === 'ended') return true;
  return filter === 'running' && quietLive(liveWithLimit(s.live, s.limit), s.state.status) !== 'busy' && shownAside(s) === null;
}

/**
 * 今日戻るの札の並び。ホームの帯が読む。ヘッダーの注意（presenters/notices.ts）には入れない（2026-10-13 の決定、9a）。
 * alive は hangar の run が生きているセッションで、生きているものは出さない。
 */
export function returningCards(store: Store, now: number, alive: Set<string> = runningSessionIds(store)): ReturnCard[] {
  const tr = translatorOf(store);
  const name = (s: SessionDto) => s.name ?? tr('common.label.noName');
  const projectName = (s: SessionDto) => (s.projectId && store.projects[s.projectId] ? projectDisplayName(store.projects[s.projectId]!, tr) : null);
  // 今日戻る（C1）。戻る日の古い順で、壊れた日を先頭に、同じ日の中は時刻の早い順（時刻なしは最後）、同じ時点は新しい順にする。
  // 「今日」は手元の暦で、期間の「今日」（mediator/screen.ts の periodStart(1, now)）と同じ境にする。
  const keyOf = (s: SessionDto) => returnKey({ returnOn: s.state?.returnOn ?? null, returnTime: s.state?.returnTime ?? null });
  return Object.values(store.sessions)
    .filter((s) => returnsNow(store, s, now, alive))
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .map((s): ReturnCard => {
      const on = s.state?.returnOn ?? null;
      const r = on !== null && isReturnOn(on) ? on : null;
      const t = r !== null && typeof s.state?.returnTime === 'string' && isReturnTime(s.state.returnTime) ? s.state.returnTime : null;
      // 当日の時刻つきは、時刻を過ぎてから札に出す（2026-10-13。時刻の前は一覧の行に枠だけの札が出る）。
      return { id: s.id, name: name(s), projectName: projectName(s), reason: s.state?.note || tr('home.card.noReason'), returnOn: r, returnTime: t, overdueDays: r ? overdueDays(r, now) : null, due: r === null || returnDue(r, t, now), pastMin: r ? returnPastMinutes(r, t, now) : null };
    });
}

export function presentHome(_state: State, store: Store, now: number): HomeCards {
  const sessions = Object.values(store.sessions);
  const t = translatorOf(store);
  const projectName = (s: SessionDto) => (s.projectId && store.projects[s.projectId] ? projectDisplayName(store.projects[s.projectId]!, t) : null);
  const name = (s: SessionDto) => s.name ?? t('common.label.noName');
  // Claude のレジストリに載る前の run も実行中に数える。
  // 信頼確認のダイアログ待ちの run が Home のどこにも出ないと、セッション画面への戻り道がなくなる。
  const alive = runningSessionIds(store);

  // 長く待っているものほど先に答えたいので、最後に動いた時刻の古い順に並べる。
  // Done と Archived にしたものは、live が waiting のままでも出さない（store.ts の awaitsAnswer）。
  const waiting = sessions.filter(awaitsAnswer).sort((a, b) => (a.lastActivityAt ?? now) - (b.lastActivityAt ?? now));
  const attention = waiting.map((s): AttentionCard => {
    // 許可待ちとリセット済みは、理由を添える（試作の B1）。リセット済みの経過は、リセットの時刻から数える。
    const reason = stopReasonOf(s);
    const shown = reason === 'permission' || reason === 'reset' ? reason : null;
    const since = shown === 'reset' && s.limit ? s.limit.resetsAt : s.lastActivityAt ?? now;
    return { id: s.id, name: name(s), projectName: projectName(s), waited: durationLabel(t, Math.max(0, now - since)), question: s.activity?.question ?? noQuestionText(t), answer: aliveRunOf(store, s.id) ? 'terminal' as const : outsideOpenOf(store, s), reason: shown, permission: shown === 'permission' ? s.permission : null };
  });

  const returning = returningCards(store, now, alive);

  // 確かめる。TODO の完了の候補とセッションの状態の提案を、候補になった時刻の古い順に混ぜる。
  // 放っておくと溜まるので、長く待っているものほど先に出す。
  const candidates = Object.values(store.todos)
    .map((todo) => ({ todo, c: presentTodoCandidate(todo, store, now) }))
    .filter((x): x is { todo: typeof x.todo; c: NonNullable<typeof x.c> } => x.c !== null);
  const proposed = sessions.filter((s) => !!s.state?.candidate);
  const confirm = [
    ...candidates.map(({ todo, c }): { at: number; card: ConfirmCard } => ({ at: todo.candidate!.at, card: { kind: 'todo', id: todo.id, text: todo.text, projectId: todo.projectId, projectName: store.projects[todo.projectId] ? projectDisplayName(store.projects[todo.projectId]!, t) : t('common.label.uncategorized'), sessionName: c.sessionName, ago: c.ago, note: c.note } })),
    ...proposed.map((s): { at: number; card: ConfirmCard } => {
      const c = s.state!.candidate!;
      // 札の文言は行の提案の札（第 1 段の candidateLabel）と同じにする。
      // Done の提案は放っておくと自動で確定するので、残りの日数を添える。見回りの合間に 0 日になっても「あと 1 日」と言う。
      const daysLeft = c.status === 'done' ? Math.max(1, candidateDaysLeft(c.at, now)) : null;
      return { at: c.at, card: { kind: 'session', id: s.id, name: name(s), projectName: projectName(s), status: c.status, label: candidateLabel(t, c), note: c.note || t('projectScreen.todo.noNote'), ago: relativeTime(t, c.at, now), source: c.source, daysLeft } };
    }),
  ].sort((a, b) => (a.at - b.at) || a.card.id.localeCompare(b.card.id)).map((x) => x.card);

  // 今日戻るに寄せたもの（戻る時点が来た、休みのまま生きている Paused）は、実行中に重ねない。
  const back = new Set(returning.map((r) => r.id));
  const running = sortSessions(sessions.filter((s) => liveFilterOfSession(store, s, alive) === 'running' && !back.has(s.id))).map((s): RunningCard => {
    // 対象が取れない呼び出し（答えた後の AskUserQuestion など）は summary にツール名が入る。同じ語を 2 度並べないよう空にする。
    // summary の先頭に「ツール名+半角空白」が付くこともある（サーバの toolSummary が付けた分）。カードはツール名を <i> で先に出すので、その重なりを削る。
    // 裏だけ動いているときは、本体の手も意図も今のものではないので出さず、裏のものと指揮役が空いていることを言う。
    // 動きは、入力待ちの数え方と同じ規則を通す。Done と Archived にした入力待ちは休みとして出す（store.ts の shownLive と同じ quietLive）。
    const live = quietLive(liveWithLimit(s.live, s.limit), s.state?.status);
    const aside = asideOf(live, s.liveAside);
    // 使用制限でリセットを待っているものは、実行中のまま理由と時刻を言う（試作の B1）。
    const limit = live === 'idle' && stopReasonOf(s) === 'limit' && s.limit ? limitCardOf(t, s.limit, now) : null;
    const working = live === 'busy' && aside === null;
    const activity = working && s.activity ? { tool: s.activity.tool, summary: shortenPaths(stripLeadingTool(s.activity.tool, s.activity.summary)) } : null;
    const note = activity ? null : aside ? t('home.card.asideNote', { head: asideHead(t, aside), free: asideFree(t) }) : live === 'idle' ? t('home.card.idleNote', { time: durationLabel(t, now - (s.lastActivityAt ?? now)) }) : live === 'busy' ? t('home.card.workingNote') : t('home.card.startingNote');
    const meta = [projectName(s) ?? t('common.label.uncategorized'), shortModel(s.stats.model), s.stats.effort ?? ''].filter((x) => x !== '').join(' · ');
    // 意図は作業中の間だけ出す。前のターンの意図は、いまの作業を言っていないので出さない。
    const said = store.liveDigests[s.id]?.intent;
    const intent = working && said && said.inThisTurn ? said.text : null;
    return { id: s.id, name: name(s), live, aside: aside !== null, elapsed: durationLabel(t, now - (s.startedAt ?? now)), meta, intent, activity, note, contextPercent: s.stats.contextPercent, contextLabel: percentLabel(t, s.stats.contextPercent), limit, git: presentGitChip(t, store.git, s.id, store.sessions) };
  });

  return { attention, returning, confirm, running };
}

/**
 * 帯の引き出しの 1 行が持つ押せるもの。send は押したときに View が発行する UiAction である。
 * ariaLabel は読み上げの名前で、見える語（label）と相手の名前を含める。
 * primary は青いボタン、ghost は地の無いボタンで、どちらでもなければ枠のボタンである。
 */
export type BandAction = { id: string; label: string; ariaLabel: string; primary: boolean; ghost: boolean; send: UiAction;
  /** 押せない形にする（未ログインのアカウントの「再開」など）。 */
  disabled?: boolean;
  /** 文字の代わりに出す絵（行の「再開しない」の ×）。読み上げの名前は ariaLabel のまま。 */
  icon?: IconName;
  /** send が clipboard.copy のとき、写せたら COPIED_MS のあいだ文字を「コピーしました」に替える（始める前の確認の「仕上げ」の行）。 */
  copyFeedback?: boolean };
/**
 * 行頭の印。dot は状態の点、tag は戻る日や提案の札（tone の due は戻る時点を過ぎて塗る、soon は時刻の前で文字だけ、cand は提案）、todo は TODO の完了の提案の印である。
 * check は始める前の確認の印で、色だけでなく形（✓、ⓘ、!、✗）でも分ける。label は読み上げの名前に添える状態の語である。
 * place は場所の不明なプロジェクトの印（フォルダの絵）である。
 * guide は始める前の確認の最後の「仕上げ」の行の印（直すものではないので、状態の語を持たない）。
 */
export type BandLead =
  | { kind: 'dot'; live: LiveStatus | null; aside: boolean; reason?: StopReason | null }
  | { kind: 'tag'; text: string; tone: 'due' | 'soon' | 'cand'; title?: string }
  | { kind: 'todo' }
  | { kind: 'place' }
  | { kind: 'guide' }
  | { kind: 'check'; tone: 'ok' | 'info' | 'soft' | 'ng'; label: string }
  // 中断の印（中身の無い輪）。spin は再開を頼んで返事を待っている間で、輪が回る。label は読み上げの名前に添える語。
  | { kind: 'ring'; spin: boolean; label: string };
/** 行の右端に並べる文字。tone の wait は入力待ちの色、busy は作業中の色、limit は使用制限の色である。 */
export type BandTrail = { text: string; tone?: 'wait' | 'busy' | 'limit' };
/**
 * 帯の引き出しの 1 行（1 件 1 行）。
 * 名前（name）、薄い添え（context）、本文（text）、等幅の詳細（detail、いまの手など）、右端の文字（trail）、ボタン（actions）を並べる。
 * open があれば名前がボタンになり、押すとその UiAction を発行する。tone の wait は行の地に入力待ちの色を薄く敷く。
 * badge は名前の横に添える小さな札で、始める前の確認の「任意」に使う。
 * ask は許可待ちの道具と命令で、本文の前に道具の札と等幅の命令として出す。
 * どの群の行もこの形にするので、群を足すときに View を触らずに済む。
 */
export type BandRow = { key: string; lead: BandLead; name: string; badge?: string | null; context: string | null; text: string; detail: string | null; tone: 'wait' | null; trail: BandTrail[]; open: UiAction | null; actions: BandAction[]; ask?: { tool: string; input: string } | null;
  /** 本文の頭に添える色の語（中断の行の「作業中だった」「再開中」「失敗」）。 */
  textHead?: { text: string; tone: 'busy' | 'wait' | 'faint' | 'error' };
  /** 行の上に小見出しを置く区切り。key が前の行と替わったところで見出しを出す（中断の群のアカウントごとの小見出し）。 */
  section?: BandSection;
  /** 同じファイルの編集の警告。行の右端に琥珀の札を置き、押すと中身が開く（presenters/overlap.ts）。 */
  overlap?: OverlapProps | null;
  /** 右端の git の札（実行中の行だけ）。trail の左に置く。 */
  git?: { id: string; chip: GitChipProps } | null;
  /** セッションの行の右クリックと . で開くメニュー（1A）。セッションを開く行だけが持つ（withSessionMenus）。 */
  menu?: SessionMenuProps };
/**
 * 引き出しの中の小見出し（アカウント）。color は色の点、meter は 5 時間の使用率、note は添える一言（未ログイン、制限に近い）、action は見出しのボタン（ログイン）。
 */
export type BandSection = { key: string; name: string; color: string; meter: { percent: number; label: string; high: boolean } | null; note: { text: string; tone: 'warn' | 'faint' } | null; action: BandAction | null };
/**
 * 帯の群 1 つ。錠剤 1 つとその引き出しにあたる。
 * count は錠剤の数で、0 なら薄く出して押せない。summary は引き出しの見出しに添える内訳である。
 * tone は件数の色（wait は入力待ちの赤茶、cand は確認待ちの紫、warn は直すものの黄）、icon は錠剤の絵である。
 * morning は、朝に最初に開く群の候補になること（既定の 3 つだけが真。足す群は真にしてよいかを足す側が決める）。
 * 次の 3 つは、足す群だけが持てる。countText は錠剤の件数の代わりに出す文字（「6 つ中 3 つ」）、progress は錠剤の横に出す進みの棒（0 から 100）、
 * fold は引き出しの末尾に畳む 1 行で、押すと rows を開く（済んだ確認の行）。
 */
export type BandGroup = {
  id: string; label: string; icon: IconName; tone: 'default' | 'wait' | 'cand' | 'warn'; count: number; summary: string; morning: boolean; rows: BandRow[];
  countText?: string; progress?: number; fold?: { text: string; rows: BandRow[] };
  /** 引き出しの最後（fold の後ろ）に置く行。件数には数えない（始める前の確認の「仕上げ」の行）。 */
  tail?: BandRow[];
  /** 引き出しの見出しの右に置くボタン（中断の群の「すべて再開」「閉じる」）。 */
  headActions?: BandAction[];
  /** 錠剤に添える琥珀の点（同じファイルを編集中のセッションがあること）。件数には入れない。文字は読み上げの名前に添える。 */
  mark?: string | null;
};
/**
 * 帯が受け取るもの。groups は錠剤の並びで、morning は開いたときに最初から開いている群の id（無ければ null）。
 * 開閉は View の中の状態で、ここは朝に開く群だけを決める（設計書 4.4）。
 */
export type HomeBandProps = { groups: BandGroup[]; morning: string | null };

/** 朝に開く群。件数があって morning の立っている群のうち、並びの先頭のもの。 */
export function morningGroup(groups: BandGroup[]): string | null {
  return groups.find((g) => g.morning && g.count > 0)?.id ?? null;
}

type BandInput = HomeCards;

/** 行の末尾に付ける「相手の名前」入りの読み上げの名前を持つボタン。 */
function action(t: Translate, id: string, label: string, name: string, send: UiAction, kind: 'primary' | 'ghost' | 'plain' = 'plain'): BandAction {
  return { id, label, ariaLabel: t('home.band.actionFor', { action: label, name }), primary: kind === 'primary', ghost: kind === 'ghost', send };
}

function attentionRow(t: Translate, a: AttentionCard): BandRow {
  const open: UiAction = { type: 'session.open', id: a.id };
  // 許可待ちは「ターミナルで許可」、リセット済みは「ターミナルで続ける」で答える。
  const answerLabel = a.reason === 'permission' ? t('stop.action.allow') : a.reason === 'reset' ? t('stop.action.continue') : t('home.band.answer');
  const answer = a.answer === 'terminal' ? action(t, 'answer', answerLabel, a.name, { type: 'session.open', id: a.id, focus: 'terminal' }, 'primary')
    : a.answer === 'attach' ? action(t, 'answer', answerLabel, a.name, { type: 'session.attach', id: a.id }, 'primary')
      : a.answer === 'adopt' ? action(t, 'answer', t('home.band.move'), a.name, { type: 'session.adopt', id: a.id }, 'primary')
        : action(t, 'open', t('home.band.open'), a.name, open);
  const project = a.projectName ?? t('common.label.uncategorized');
  // 端末の無い入力待ち（外部ターミナルで動くもの）は、答えが hangar の外にあることを添える。
  const outside = a.answer === 'adopt' || a.answer === null;
  const context = outside ? `${project} · ${t('home.band.external')}` : project;
  const lead: BandLead = { kind: 'dot', live: 'waiting', aside: false, reason: a.reason ?? null };
  if (a.reason === 'permission') {
    const p = a.permission ?? null;
    // 中身（hook）が届いていなければ、ターミナルに出ていると言う。外部ターミナルの run は中身を受け取れない。
    const text = p ? p.description ?? '' : t('stop.permission.unknown');
    return { key: `wait:${a.id}`, lead, name: a.name, context, text, detail: null, tone: 'wait', trail: [{ text: t('stop.waited.permission', { time: a.waited }), tone: 'wait' }], open, actions: [answer], ask: p ? { tool: p.tool, input: p.input } : null };
  }
  if (a.reason === 'reset') return { key: `wait:${a.id}`, lead, name: a.name, context, text: t('stop.notify.reset'), detail: null, tone: 'wait', trail: [{ text: t('stop.waited.reset', { time: a.waited }), tone: 'wait' }], open, actions: [answer] };
  return { key: `wait:${a.id}`, lead: { kind: 'dot', live: 'waiting', aside: false }, name: a.name, context, text: a.question, detail: null, tone: 'wait', trail: [{ text: t('home.band.waited', { time: a.waited }), tone: 'wait' }], open, actions: [answer] };
}

function returnRow(t: Translate, r: ReturnCard): BandRow {
  const open: UiAction = { type: 'session.open', id: r.id };
  const text = r.returnOn === null ? t('home.band.noDate') : returnOnLabel(t, r.returnOn, r.overdueDays, r.returnTime, r.pastMin);
  const lead: BandLead = { kind: 'tag', text, tone: r.due ? 'due' : 'soon', ...(r.returnTime ? { title: t('home.band.reminderTime', { time: r.returnTime }) } : {}) };
  return {
    key: `return:${r.id}`, lead, name: r.name, context: r.projectName ?? t('common.label.uncategorized'), text: r.reason, detail: null, tone: null, trail: [], open,
    actions: [
      action(t, 'open', t('home.band.open'), r.name, open),
      action(t, 'changeDate', t('home.band.changeDate'), r.name, { type: 'session.pause.open', id: r.id, from: 'menu' }, 'ghost'),
      action(t, 'done', 'Done', r.name, { type: 'session.state.set', id: r.id, status: 'done' }, 'ghost'),
    ],
  };
}

function runningRow(t: Translate, r: RunningCard): BandRow {
  // 使用制限でリセットを待っているものは、砂時計と時刻を主役にする。利用者にできることは無いので、ボタンは「開く」だけ。
  if (r.limit) {
    const open: UiAction = { type: 'session.open', id: r.id };
    return { key: `run:${r.id}`, lead: { kind: 'dot', live: r.live, aside: false, reason: 'limit' }, name: r.name, context: r.meta, text: r.limit.text, detail: null, tone: null, trail: r.limit.left ? [{ text: r.limit.left, tone: 'limit' }] : [], open, actions: [action(t, 'open', t('home.band.open'), r.name, open)] };
  }
  const working = r.live === 'busy' && !r.aside;
  // 作業中は意図が本文で、いまの手は等幅の詳細にする。手が取れない間は note を本文にする。
  // 作業中でないもの（アイドル、起動中、裏だけ動くもの）は note の一言が本文である。
  const detail = working && r.activity ? (r.activity.summary === '' ? r.activity.tool : `${r.activity.tool} ${r.activity.summary}`) : null;
  const text = r.intent ?? (detail !== null ? '' : r.note ?? '');
  const trail: BandTrail[] = [];
  if (working) trail.push({ text: t('home.band.working', { time: r.elapsed }), tone: 'busy' });
  if (r.contextPercent !== null) trail.push({ text: r.contextLabel });
  return { key: `run:${r.id}`, lead: { kind: 'dot', live: r.live, aside: r.aside }, name: r.name, context: r.meta, text, detail, tone: null, trail, open: { type: 'session.open', id: r.id }, actions: [], git: r.git ? { id: r.id, chip: r.git } : null };
}

function confirmRow(t: Translate, c: ConfirmCard): BandRow {
  if (c.kind === 'todo') {
    // 別のプロジェクトに同じ本文の候補があっても、ボタンの名前が 1 つに決まるよう、読み上げの名前にプロジェクトを添える。
    const who = `${c.text}（${c.projectName}）`;
    return {
      key: `todo:${c.id}`, lead: { kind: 'todo' }, name: c.text, context: `${c.projectName} · ${c.ago}`, text: c.note, detail: null, tone: null, trail: [], open: { type: 'project.open', id: c.projectId },
      actions: [
        action(t, 'confirm', t('home.band.confirm'), who, { type: 'todo.confirm', id: c.id }, 'primary'),
        action(t, 'dismiss', t('home.band.dismiss'), who, { type: 'todo.reject', id: c.id }),
      ],
    };
  }
  // 名前の後ろに出どころの小札（会話の中で／要約から）を添え、Done の提案には右に自動で確定するまでの日数を出す（試作の 9d の A）。
  // 取りやめた出どころ（exit）は書き手がいないので、小札を付けない。
  const badge = c.source === 'in_session' ? t('home.band.source.inSession') : c.source === 'post_hoc' ? t('home.band.source.postHoc') : null;
  return {
    key: `session:${c.id}`, lead: { kind: 'tag', text: c.label, tone: 'cand' }, name: c.name, badge, context: `${c.projectName ?? t('common.label.uncategorized')} · ${c.ago}`, text: c.note, detail: null, tone: null,
    trail: c.daysLeft === null ? [] : [{ text: t('home.band.autoConfirmIn', { n: c.daysLeft }) }], open: { type: 'session.open', id: c.id },
    actions: [
      action(t, 'confirm', t('home.band.confirm'), c.name, { type: 'session.state.confirm', id: c.id }, 'primary'),
      ...(c.status === 'paused' ? [action(t, 'changeDate', t('home.band.changeDate'), c.name, { type: 'session.pause.open', id: c.id, from: 'candidate' })] : []),
      action(t, 'dismiss', t('home.band.dismiss'), c.name, { type: 'session.state.reject', id: c.id }),
    ],
  };
}

/**
 * 確認待ちの群の見出しのボタン（2026-10-13 の決定、知らせの 9d）。中断の群と同じ並びで、確定が先、却下は控えめ（ghost）にする。
 * いまある提案を全部渡す。提案が無ければ置かない。
 */
function pendingHeadActions(t: Translate, confirm: ConfirmCard[]): BandAction[] {
  if (confirm.length === 0) return [];
  const sessionIds = confirm.filter((c) => c.kind === 'session').map((c) => c.id);
  const todoIds = confirm.filter((c) => c.kind === 'todo').map((c) => c.id);
  const group = t('home.band.pending');
  return [
    action(t, 'confirmAll', t('home.band.confirmAll'), group, { type: 'pending.resolve', accept: true, sessionIds, todoIds }),
    action(t, 'dismissAll', t('home.band.dismissAll'), group, { type: 'pending.resolve', accept: false, sessionIds, todoIds }, 'ghost'),
  ];
}

/**
 * ホームの帯（上の件数の細い帯と、押した群の引き出し）に渡すものを組む。
 * 3 つの群は要対応、実行中、確認待ちの順で、0 件でも群は残す（薄い錠剤として出す）。
 * extra は後ろに足す群で、足したものがそのまま 4 つ目以降の錠剤になる（未解決のプロジェクトなど）。
 * 要対応は入力待ちの札に、今日戻るの札を続ける。実行中の内訳は、作業中（裏だけ動くものも含む）とアイドルを数える。起動中は内訳に入れない。
 */
export function presentHomeBand(home: BandInput, t: Translate, extra: BandGroup[] = []): HomeBandProps {
  const busy = home.running.filter((r) => r.live === 'busy').length;
  // 使用制限でリセットを待っているものは、アイドルと分けて数える。
  const limited = home.running.filter((r) => !!r.limit).length;
  const idle = home.running.filter((r) => r.live === 'idle' && !r.limit).length;
  const permission = home.attention.filter((a) => a.reason === 'permission').length;
  const reset = home.attention.filter((a) => a.reason === 'reset').length;
  const asking = home.attention.length - permission - reset;
  const reminders = home.returning.length;
  const attentionSummary = reset > 0 ? t('stop.band.attentionSummaryReset', { waiting: asking, permission, reset, reminders })
    : permission > 0 ? t('stop.band.attentionSummary', { waiting: asking, permission, reminders })
      : t('home.band.attentionSummary', { waiting: asking, reminders });
  const groups: BandGroup[] = [
    { id: 'attention', label: t('home.band.attention'), icon: 'alert', tone: 'wait', count: home.attention.length + home.returning.length, summary: attentionSummary, morning: true, rows: [...home.attention.map((a) => attentionRow(t, a)), ...home.returning.map((r) => returnRow(t, r))] },
    { id: 'running', label: t('home.band.running'), icon: 'tool', tone: 'default', count: home.running.length, summary: limited > 0 ? t('stop.band.runningSummary', { busy, idle, limit: limited }) : t('home.band.runningSummary', { busy, idle }), morning: true, rows: home.running.map((r) => runningRow(t, r)) },
    { id: 'pending', label: t('home.band.pending'), icon: 'check', tone: 'cand', count: home.confirm.length, summary: t('home.band.pendingSummary', { n: home.confirm.length }), morning: true, rows: home.confirm.map((c) => confirmRow(t, c)), headActions: pendingHeadActions(t, home.confirm) },
    ...extra,
  ];
  return { groups, morning: morningGroup(groups) };
}

/** 「さらに読み込む」の表示。remaining は全件から持っている行を引いた数、step は 1 回に読む件数、loading は読んでいる最中。 */
export type LoadMoreProps = { remaining: number; step: number; loading: boolean };

/**
 * ホームの画面に渡すもの（設計書 2.2、試作 B）。
 * band は上の帯と引き出し、idle は 3 つの群がどれも 0 件のこと（帯の代わりに「実行中のセッションはありません」の 1 行を出す）、
 * searching は語か触ったファイルで探している最中のこと（引き出しを閉じ、帯の件数だけを残す）である。
 * list はステータスのタブ、欄、絞り込み、行を持つ平らな一覧で、loadMore は検索の結果の末尾の「さらに読み込む」（検索でないときは null）。
 * note は帯の右端に添える 1 行で、始める前の確認のうち始めるのに要る道具が足りないあいだだけ持つ（2.11.4）。
 * setup は始める前の確認の群が帯にあること（一覧の空の札の文を選ぶ）。
 * 始める前の確認は、直すものがあるあいだ、帯の最後の群（錠剤と引き出し）になる。
 * 要対応と実行中と確認待ちがどれも 0 件のときは、その 3 つの薄い錠剤を出さず、確認の群だけを帯に置き、「実行中のセッションはありません」の 1 行は出さない。
 * 4 つ目の錠剤（場所の不明なプロジェクト）は、この PC で場所が消えたものがあるときだけ、3 つの群と確認の群のあいだに足す（presenters/unresolved.ts、2.11.5）。
 */
export type HomeScreenProps = { band: HomeBandProps; idle: boolean; searching: boolean; list: SessionListProps; allCount: number; loadMore: LoadMoreProps | null; note: string | null; setup: boolean };

/**
 * 帯の行のうち、セッションを開く行（入力待ち、戻る、実行中、確認待ち、中断）に、セッションのメニューを添える。
 * どの群から来た行でも、開く先（open の session.open）でセッションを見分ける。セッションが Store に無い行には付けない。
 */
export function withSessionMenus(group: BandGroup, store: Store, t: Translate): BandGroup {
  const add = (rows: BandRow[]) => rows.map((r) => {
    const s = r.open?.type === 'session.open' ? store.sessions[r.open.id] : undefined;
    return s ? { ...r, menu: presentSessionMenu(store, s, t) } : r;
  });
  return {
    ...group,
    rows: add(group.rows),
    ...(group.fold ? { fold: { ...group.fold, rows: add(group.fold.rows) } } : {}),
    ...(group.tail ? { tail: add(group.tail) } : {}),
  };
}

export function presentHomeScreen(state: State, store: Store, now: number): HomeScreenProps {
  const t = translatorOf(store);
  // 準備の確かめは起動のたびに取る。届くまで、また届いても直すものが無ければ、確認の群は出さない。
  // プロジェクトの行は、画面が持っているプロジェクトの数で決める（登録した直後に、準備の確かめを取り直す前でも行を消す）。
  const ready = store.readiness ? presentReadiness(liveReadiness(store.readiness, Object.values(store.projects)), t, undefined, state.muxCheck, { desktop: store.desktop, running: state.setupRunning, notifyAsk: store.notify.ask === true, guide: store.setupGuide ? setupGuidePrompt(t, store.setupGuide) : null }) : null;
  const band0 = presentHomeBand(presentHome(state, store, now), t);
  // 実行中の行に、同じファイルの編集の札を重ねる（presenters/overlap.ts）。
  const base = { ...band0, groups: band0.groups.map((g) => withOverlaps(g, store, now)) };
  // 3 つの群の後ろに足す群は、前回実行中（中断の群）、場所の不明なプロジェクト、同じフォルダのプロジェクト、始める前の確認の順に並べる。0 件の群は足さない。
  const extra = [presentInterrupted(state, store, now), presentUnresolved(store, t), presentSameFolder(store, t), ready?.group ?? null].filter((g): g is BandGroup => g !== null);
  // 静かな日は、3 つの群がどれも 0 件のこと。足す群があれば、薄い 3 つの錠剤は出さず、足す群だけを帯に置く。
  const quiet = base.groups.every((g) => g.count === 0);
  const groups = quiet ? extra : [...base.groups, ...extra];
  const band: HomeBandProps = { groups: (groups.length === 0 ? base.groups : groups).map((g) => withSessionMenus(g, store, t)), morning: morningGroup(groups) };
  const list = presentSessionList(state, store, now);
  const remaining = list.total - list.rows.length;
  return {
    band,
    idle: quiet && extra.length === 0,
    searching: usesServerSearch(state.search),
    list,
    allCount: list.allCount,
    loadMore: list.mode === 'search' && remaining > 0 ? { remaining, step: SEARCH_STEP, loading: list.loading } : null,
    note: ready?.note ?? null,
    setup: ready !== null,
  };
}
