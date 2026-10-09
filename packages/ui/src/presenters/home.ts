import { ASIDE_FREE, asideHead, asideOf } from '../lib/aside.ts';
import { isReturnOn, isReturnTime, localDate, overdueDays, returnDue, returnPastMinutes, type Intent, type LiveStatus, type ProjectStatus, type SessionDto, type Translate } from '@agent-hangar/shared';
import { SEARCH_STEP, usesServerSearch } from '../mediator/screen.ts';
import type { State } from '../mediator/types.ts';
import type { IconName } from '../views/primitives/Icon.tsx';
import { aliveRunOf, liveFilterOfSession, outsideOpenOf, runningSessionIds, type Store } from '../store/store.ts';
import { durationLabel, percentLabel, relativeTime, shortenPaths, shortModel } from './format.ts';
import { presentTodoCandidate } from './project.ts';
import { translatorOf } from './i18n.ts';
import { presentReadiness } from './readiness.ts';
import { candidateLabel, dueOn, returnKey, returnOnLabel, sortSessions } from './row.ts';
import { presentSessionList, type SessionListProps } from './sessions.ts';

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
 * aside は裏だけ動いていること。そのときは activity も intent も出さず、note で裏のものと指揮役が空いていることを言う。
 */
export type RunningCard = { id: string; name: string; live: LiveStatus | null; aside: boolean; elapsed: string; meta: string; intent: string | null; activity: { tool: string; summary: string } | null; note: string | null; contextPercent: number | null; contextLabel: string };
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
 * 帯の引き出しの行になる 4 つの群の中身。要対応（入力待ちと今日戻る）、確認待ち、実行中である。
 * 引き出しの行は presentHomeBand が作る。
 */
export type HomeCards = { attention: AttentionCard[]; returning: ReturnCard[]; confirm: ConfirmCard[]; running: RunningCard[] };

/** 問いの文が取れなかった入力待ち（権限の確認など）に出す文。 */
export const NO_QUESTION = '入力を待っています';
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

/**
 * 今日戻るの札の並び。ホームの帯とベルの一覧（presenters/notices.ts）が、同じこの並びを読む。
 * alive は hangar の run が生きているセッションで、生きているものは出さない。
 */
export function returningCards(store: Store, now: number, alive: Set<string> = runningSessionIds(store)): ReturnCard[] {
  const name = (s: SessionDto) => s.name ?? '（名前なし）';
  const projectName = (s: SessionDto) => (s.projectId ? store.projects[s.projectId]?.name ?? null : null);
  // 今日戻る（C1）。戻る日の古い順で、欠けた日と壊れた日を先頭に、同じ日の中は新しい順にする。
  // 「今日」は手元の暦で、期間の「今日」（mediator/screen.ts の periodStart(1, now)）と同じ境にする。
  const today = localDate(now);
    const keyOf = (s: SessionDto) => returnKey({ returnOn: s.state?.returnOn ?? null, returnTime: s.state?.returnTime ?? null });
  return Object.values(store.sessions)
    .filter((s) => s.state?.status === 'paused' && dueOn(s.state.returnOn, today) && liveFilterOfSession(store, s, alive) === 'ended')
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .map((s): ReturnCard => {
      const on = s.state?.returnOn ?? null;
      const r = on !== null && isReturnOn(on) ? on : null;
      const t = r !== null && typeof s.state?.returnTime === 'string' && isReturnTime(s.state.returnTime) ? s.state.returnTime : null;
      // 当日の時刻つきは、時刻の前から札に出す（朝のうちに今日の予定として見える）。塗るのは時刻を過ぎてからにする。
      return { id: s.id, name: name(s), projectName: projectName(s), reason: s.state?.note || NO_REASON, returnOn: r, returnTime: t, overdueDays: r ? overdueDays(r, now) : null, due: r === null || returnDue(r, t, now), pastMin: r ? returnPastMinutes(r, t, now) : null };
    });
}

export function presentHome(_state: State, store: Store, now: number): HomeCards {
  const sessions = Object.values(store.sessions);
  const projectName = (s: SessionDto) => (s.projectId ? store.projects[s.projectId]?.name ?? null : null);
  const name = (s: SessionDto) => s.name ?? '（名前なし）';
  // Claude のレジストリに載る前の run も実行中に数える。
  // 信頼確認のダイアログ待ちの run が Home のどこにも出ないと、セッション画面への戻り道がなくなる。
  const alive = runningSessionIds(store);

  // 長く待っているものほど先に答えたいので、最後に動いた時刻の古い順に並べる。
  const waiting = sessions.filter((s) => s.live === 'waiting').sort((a, b) => (a.lastActivityAt ?? now) - (b.lastActivityAt ?? now));
  const attention = waiting.map((s) => ({ id: s.id, name: name(s), projectName: projectName(s), waited: durationLabel(now - (s.lastActivityAt ?? now)), question: s.activity?.question ?? NO_QUESTION, answer: aliveRunOf(store, s.id) ? 'terminal' as const : outsideOpenOf(store, s) }));

  const returning = returningCards(store, now, alive);

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
    // 裏だけ動いているときは、本体の手も意図も今のものではないので出さず、裏のものと指揮役が空いていることを言う。
    const aside = asideOf(s.live, s.liveAside);
    const working = s.live === 'busy' && aside === null;
    const activity = working && s.activity ? { tool: s.activity.tool, summary: shortenPaths(stripLeadingTool(s.activity.tool, s.activity.summary)) } : null;
    const note = activity ? null : aside ? `${asideHead(aside)}。${ASIDE_FREE}` : s.live === 'idle' ? `休み。最後の返答から ${durationLabel(now - (s.lastActivityAt ?? now))}` : s.live === 'busy' ? '作業中' : '起動しています';
    const meta = [projectName(s) ?? '未分類', shortModel(s.stats.model), s.stats.effort ?? ''].filter((x) => x !== '').join(' · ');
    // 意図は作業中の間だけ出す。前のターンの意図は、いまの作業を言っていないので出さない。
    const said = store.liveDigests[s.id]?.intent;
    const intent = working && said && said.inThisTurn ? said.text : null;
    return { id: s.id, name: name(s), live: s.live, aside: aside !== null, elapsed: durationLabel(now - (s.startedAt ?? now)), meta, intent, activity, note, contextPercent: s.stats.contextPercent, contextLabel: percentLabel(s.stats.contextPercent) };
  });

  return { attention, returning, confirm, running };
}

/**
 * 帯の引き出しの 1 行が持つ押せるもの。intent は押したときに View が発行する Intent である。
 * ariaLabel は読み上げの名前で、見える語（label）と相手の名前を含める。
 * primary は青いボタン、ghost は地の無いボタンで、どちらでもなければ枠のボタンである。
 */
export type BandAction = { id: string; label: string; ariaLabel: string; primary: boolean; ghost: boolean; intent: Intent };
/**
 * 行頭の印。dot は状態の点、tag は戻る日や提案の札（tone の due は戻る時点を過ぎて塗る、soon は時刻の前で文字だけ、cand は提案）、todo は TODO の完了の提案の印である。
 * check は始める前の確認の印で、色だけでなく形（✓、ⓘ、!、✗）でも分ける。label は読み上げの名前に添える状態の語である。
 */
export type BandLead =
  | { kind: 'dot'; live: LiveStatus | null; aside: boolean }
  | { kind: 'tag'; text: string; tone: 'due' | 'soon' | 'cand'; title?: string }
  | { kind: 'todo' }
  | { kind: 'check'; tone: 'ok' | 'info' | 'soft' | 'ng'; label: string };
/** 行の右端に並べる文字。tone の wait は入力待ちの色、busy は作業中の色である。 */
export type BandTrail = { text: string; tone?: 'wait' | 'busy' };
/**
 * 帯の引き出しの 1 行（1 件 1 行）。
 * 名前（name）、薄い添え（context）、本文（text）、等幅の詳細（detail、いまの手など）、右端の文字（trail）、ボタン（actions）を並べる。
 * open があれば名前がボタンになり、押すとその Intent を発行する。tone の wait は行の地に入力待ちの色を薄く敷く。
 * badge は名前の横に添える小さな札で、始める前の確認の「任意」に使う。
 * どの群の行もこの形にするので、群を足すときに View を触らずに済む。
 */
export type BandRow = { key: string; lead: BandLead; name: string; badge?: string | null; context: string | null; text: string; detail: string | null; tone: 'wait' | null; trail: BandTrail[]; open: Intent | null; actions: BandAction[] };
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
function action(t: Translate, id: string, label: string, name: string, intent: Intent, kind: 'primary' | 'ghost' | 'plain' = 'plain'): BandAction {
  return { id, label, ariaLabel: t('home.band.actionFor', { action: label, name }), primary: kind === 'primary', ghost: kind === 'ghost', intent };
}

function attentionRow(t: Translate, a: AttentionCard): BandRow {
  const open: Intent = { type: 'session.open', id: a.id };
  const answer = a.answer === 'terminal' ? action(t, 'answer', t('home.band.answer'), a.name, { type: 'session.open', id: a.id, focus: 'terminal' }, 'primary')
    : a.answer === 'attach' ? action(t, 'answer', t('home.band.answer'), a.name, { type: 'session.attach', id: a.id }, 'primary')
      : a.answer === 'adopt' ? action(t, 'answer', t('home.band.move'), a.name, { type: 'session.adopt', id: a.id }, 'primary')
        : action(t, 'open', t('home.band.open'), a.name, open);
  const project = a.projectName ?? t('common.label.uncategorized');
  // 端末の無い入力待ち（外部ターミナルで動くもの）は、答えが hangar の外にあることを添える。
  const outside = a.answer === 'adopt' || a.answer === null;
  return { key: `wait:${a.id}`, lead: { kind: 'dot', live: 'waiting', aside: false }, name: a.name, context: outside ? `${project} · ${t('home.band.external')}` : project, text: a.question, detail: null, tone: 'wait', trail: [{ text: t('home.band.waited', { time: a.waited }), tone: 'wait' }], open, actions: [answer] };
}

function returnRow(t: Translate, r: ReturnCard): BandRow {
  const open: Intent = { type: 'session.open', id: r.id };
  const text = r.returnOn === null ? t('home.band.noDate') : returnOnLabel(r.returnOn, r.overdueDays, r.returnTime, r.pastMin);
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
  const working = r.live === 'busy' && !r.aside;
  // 作業中は意図が本文で、いまの手は等幅の詳細にする。手が取れない間は note を本文にする。
  // 作業中でないもの（アイドル、起動中、裏だけ動くもの）は note の一言が本文である。
  const detail = working && r.activity ? (r.activity.summary === '' ? r.activity.tool : `${r.activity.tool} ${r.activity.summary}`) : null;
  const text = r.intent ?? (detail !== null ? '' : r.note ?? '');
  const trail: BandTrail[] = [];
  if (working) trail.push({ text: t('home.band.working', { time: r.elapsed }), tone: 'busy' });
  if (r.contextPercent !== null) trail.push({ text: r.contextLabel });
  return { key: `run:${r.id}`, lead: { kind: 'dot', live: r.live, aside: r.aside }, name: r.name, context: r.meta, text, detail, tone: null, trail, open: { type: 'session.open', id: r.id }, actions: [] };
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
  return {
    key: `session:${c.id}`, lead: { kind: 'tag', text: c.label, tone: 'cand' }, name: c.name, context: `${c.projectName ?? t('common.label.uncategorized')} · ${c.ago}`, text: c.note, detail: null, tone: null, trail: [], open: { type: 'session.open', id: c.id },
    actions: [
      action(t, 'confirm', t('home.band.confirm'), c.name, { type: 'session.state.confirm', id: c.id }, 'primary'),
      ...(c.status === 'paused' ? [action(t, 'changeDate', t('home.band.changeDate'), c.name, { type: 'session.pause.open', id: c.id, from: 'candidate' })] : []),
      action(t, 'dismiss', t('home.band.dismiss'), c.name, { type: 'session.state.reject', id: c.id }),
    ],
  };
}

/**
 * ホームの帯（上の件数の細い帯と、押した群の引き出し）に渡すものを組む。
 * 3 つの群は要対応、実行中、確認待ちの順で、0 件でも群は残す（薄い錠剤として出す）。
 * extra は後ろに足す群で、足したものがそのまま 4 つ目以降の錠剤になる（未解決のプロジェクトなど）。
 * 要対応は入力待ちの札に、今日戻るの札を続ける。実行中の内訳は、作業中（裏だけ動くものも含む）とアイドルを数える。起動中は内訳に入れない。
 */
export function presentHomeBand(home: BandInput, t: Translate, extra: BandGroup[] = []): HomeBandProps {
  const busy = home.running.filter((r) => r.live === 'busy').length;
  const idle = home.running.filter((r) => r.live === 'idle').length;
  const groups: BandGroup[] = [
    { id: 'attention', label: t('home.band.attention'), icon: 'alert', tone: 'wait', count: home.attention.length + home.returning.length, summary: t('home.band.attentionSummary', { waiting: home.attention.length, reminders: home.returning.length }), morning: true, rows: [...home.attention.map((a) => attentionRow(t, a)), ...home.returning.map((r) => returnRow(t, r))] },
    { id: 'running', label: t('home.band.running'), icon: 'tool', tone: 'default', count: home.running.length, summary: t('home.band.runningSummary', { busy, idle }), morning: true, rows: home.running.map((r) => runningRow(t, r)) },
    { id: 'pending', label: t('home.band.pending'), icon: 'check', tone: 'cand', count: home.confirm.length, summary: t('home.band.pendingSummary', { n: home.confirm.length }), morning: true, rows: home.confirm.map((c) => confirmRow(t, c)) },
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
 * note は帯の右端に添える 1 行で、始める前の確認があるあいだだけ持つ（2.11.4）。
 * 始める前の確認は、直すものがあるあいだ、帯の最後の群（錠剤と引き出し）になる。
 * 要対応と実行中と確認待ちがどれも 0 件のときは、その 3 つの薄い錠剤を出さず、確認の群だけを帯に置き、「実行中のセッションはありません」の 1 行は出さない。
 * 4 つ目の錠剤（場所の不明なプロジェクト）は、presentHomeBand の extra に群を足して作る（PR 33）。
 */
export type HomeScreenProps = { band: HomeBandProps; idle: boolean; searching: boolean; list: SessionListProps; allCount: number; loadMore: LoadMoreProps | null; note: string | null };

export function presentHomeScreen(state: State, store: Store, now: number): HomeScreenProps {
  const t = translatorOf(store);
  // 準備の確かめは起動のたびに取る。届くまで、また届いても直すものが無ければ、確認の群は出さない。
  const ready = store.readiness ? presentReadiness(store.readiness, t) : null;
  const base = presentHomeBand(presentHome(state, store, now), t);
  const quiet = base.groups.every((g) => g.count === 0);
  const groups = ready ? (quiet ? [ready.group] : [...base.groups, ready.group]) : base.groups;
  const band: HomeBandProps = { groups, morning: morningGroup(groups) };
  const list = presentSessionList(state, store, now);
  const remaining = list.total - list.rows.length;
  return {
    band,
    idle: quiet && !ready,
    searching: usesServerSearch(state.search),
    list,
    allCount: list.allCount,
    loadMore: list.mode === 'search' && remaining > 0 ? { remaining, step: SEARCH_STEP, loading: list.loading } : null,
    note: ready?.note ?? null,
  };
}
