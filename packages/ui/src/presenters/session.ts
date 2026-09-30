import type { LiveStatus, RunKind, SessionDto, SessionSummaryDto, TranscriptEvent } from '@agent-hangar/shared';
import { defaultSessionView } from '../mediator/sessionView.ts';
import type { State } from '../mediator/types.ts';
import { aliveRunOf, artifactsOf, currentRunOf, eventsKey, hasRunOf, outsideOpenOf, tabsOf, type Store } from '../store/store.ts';
import { absoluteTime, costLabel, durationLabel, relativeTime, shortModel, SOURCE_LABEL, STATE_LABEL, SUMMARIZER_LABEL, tokensLabel } from './format.ts';
import { presentArtifactCard, type ArtifactCardProps } from './project.ts';
import { buildTurns } from './turns.ts';
import type { TurnJumpStatus } from '../mediator/types.ts';

export type TranscriptItem =
  | { kind: 'user' | 'assistant' | 'thinking' | 'system'; seq: number; text: string; when: string }
  | { kind: 'tool'; seq: number; summary: string; name: string; inputJson: string; result: { text: string; isError: boolean } | null; when: string; subagent: { agentId: string; label: string } | null }
  | { kind: 'meta'; seq: number; name: string; json: string };
export type TabItemProps = { id: string; title: string; kind: 'agent' | 'shell'; selected: boolean; closable: boolean };
/** 目次の 1 行。head は左のターミナルの指示の行と突き合わせる書き出しで、跳ぶ要求にそのまま載る。 */
export type TurnRowProps = { seq: number; when: string; text: string; head: string; tools: number; open: boolean };

/**
 * 要約に使った要約器とモデルの表示。
 * 種類は `sourceId`（要約器の id）が決める。モデル名から推し量らない。
 * `sourceId` を持たない古い行は、どの要約器が書いたか分からないので「不明」と出す。
 * 要約器を通していない要約（土台とセッション内）は、どちらも持たないので札を出さない。
 */
export function summarizerLabel(sourceId: string | null, sourceModel: string | null): string | null {
  if (!sourceId) return sourceModel ? `不明 / ${sourceModel}` : null;
  const kind = SUMMARIZER_LABEL[sourceId] ?? sourceId;
  return sourceModel && sourceModel !== kind ? `${kind} / ${sourceModel}` : kind;
}

export type SessionProps = { id: string; name: string; live: LiveStatus | null; cwd: string; projectName: string | null; projectId: string | null; summary: (SessionSummaryDto & { sourceLabel: string; stateLabel: string; summarizerLabel: string | null; generatedAt: string }) | null; summaryOpen: boolean; model: string; effort: string; turns: number; tokens: string; prUrl: string | null; memo: string | null; started: string; lastActivity: string; hasTranscript: boolean; items: TranscriptItem[]; total: number; loaded: number; loading: boolean; hasMore: boolean; showThinking: boolean; showRaw: boolean; follow: boolean; agentId: string | null; subagents: string[]; notFound: boolean; loadingSession: boolean; run: { id: string; kind: RunKind; alive: boolean; started: string } | null; tabs: TabItemProps[]; selectedTab: string | null; transcriptOpen: boolean; trustHint: boolean; canResume: boolean; canFork: boolean; contextPercent: number | null; cost: string; artifacts: ArtifactCardProps[]; summaryPending: boolean; summaryError: string | null; fromScratch: boolean; canPromote: boolean; split: { left: string; right: string } | null; canSplit: boolean; lock: SessionLockProps | null; remoteOnly: boolean; canResumeHere: boolean; outsideOpen: 'attach' | 'adopt' | null; liveLabel: string | null; filesChanged: number;
  /** ターンの目次。古い順。turnsComplete は会話の最初の指示まで読み込んでいるか。 */
  turnRows: TurnRowProps[]; turnsComplete: boolean; openTurnItems: TranscriptItem[]; turnJump: { seq: number; status: TurnJumpStatus } | null };

/**
 * 他端末がそのセッションを握っている間の表示。
 * heartbeat が途絶えていても（stale）ロックは外さず、文言だけを「応答がありません」に変える。
 * 消えた端末を理由に同じ run を横取りさせないための形である。
 * ただし行き止まりにはせず、stale のときは「この PC で再開」だけを開けて新しい run に逃がす（Ruling 14）。
 */
export type SessionLockProps = { deviceName: string; stale: boolean; heartbeat: string; label: string };

function lockProps(lock: SessionDto['lock'], now: number): SessionLockProps | null {
  if (!lock) return null;
  return { deviceName: lock.deviceName, stale: lock.stale, heartbeat: relativeTime(lock.heartbeatAt, now), label: `${lock.deviceName} ${lock.stale ? 'が応答がありません' : 'で実行中'}` };
}

/** チップの状態の言い方。Home の札（休み、入力待ち）と揃える。 */
const LIVE_WORD: Record<LiveStatus, string> = { busy: '作業中', idle: '休み', waiting: '入力待ち' };

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const when = (ts: number | undefined) => (ts === undefined ? '' : absoluteTime(ts).slice(11));

/** タグの中身。無ければ null。 */
const tagText = (text: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1]!.trim() : null;
};

/**
 * ローカルコマンド（/exit、/model など）の記録を読める形にする。null なら出さない。
 * Claude Code はこれを user の発言として、タグで包んで書く。そのまま出すとタグと決まり文句が本文に並ぶ。
 * 決まり文句（local-command-caveat）と空の出力は落とし、コマンドは「/model opus」の 1 行に、出力は中身だけにする。
 * どのタグでもない system の記録はそのまま返す。
 */
export function localCommandText(text: string): string | null {
  const head = text.trimStart();
  if (head.startsWith('<local-command-caveat>')) return null;
  // スキルを読み込むと、その本文がまるごと記録に入る。ターミナルは 1 行しか出さないので、ここも名前だけにする。
  const skill = /^Base directory for this skill: (\S+)/.exec(head);
  if (skill) return `スキル ${skill[1]!.split('/').filter(Boolean).pop()} を読み込みました`;
  const name = tagText(head, 'command-name');
  if (name !== null) {
    const args = tagText(head, 'command-args') ?? '';
    return args ? `${name} ${args}` : name;
  }
  const out = tagText(head, 'local-command-stdout');
  if (out !== null) return out === '' || out === '(no content)' ? null : out;
  return text;
}

export function buildItems(events: TranscriptEvent[], opts: { showThinking: boolean; showRaw: boolean; subagents: string[] }): TranscriptItem[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.toolId, { text: e.text, isError: e.isError });
  const items: TranscriptItem[] = [];
  let nextSub = 0;
  for (const e of events) {
    switch (e.kind) {
      case 'user': case 'assistant': items.push({ kind: e.kind, seq: e.seq, text: e.text, when: when(e.ts) }); break;
      case 'system': {
        // 生の記録を出すときは、手を加えずにそのまま見せる。
        // 種類の名前しか持たない行（turn_duration と stop_hook_summary は毎ターン 1 つずつ出る）は、読む中身が無いので落とす。
        if (!opts.showRaw && e.subtype !== undefined && e.text === e.subtype) break;
        const text = opts.showRaw ? e.text : localCommandText(e.text);
        if (text !== null) items.push({ kind: 'system', seq: e.seq, text, when: when(e.ts) });
        break;
      }
      case 'thinking': if (opts.showThinking) items.push({ kind: 'thinking', seq: e.seq, text: e.text, when: when(e.ts) }); break;
      case 'tool_call': {
        const sub = SUBAGENT_TOOLS.has(e.name) && opts.subagents[nextSub] ? { agentId: opts.subagents[nextSub++]!, label: e.summary } : null;
        items.push({ kind: 'tool', seq: e.seq, summary: e.summary, name: e.name, inputJson: JSON.stringify(e.input, null, 2), result: results.get(e.toolId) ?? null, when: when(e.ts), subagent: sub });
        break;
      }
      case 'tool_result': break;
      case 'subagent': break;
      case 'meta': if (opts.showRaw) items.push({ kind: 'meta', seq: e.seq, name: e.name, json: JSON.stringify(e.value, null, 2) }); break;
    }
  }
  return items;
}

export function presentSession(state: State, store: Store, now: number, id: string): SessionProps {
  const s = store.sessions[id];
  const view = state.sessionView[id] ?? defaultSessionView();
  const base = { id, live: null, cwd: '', projectName: null, projectId: null, summary: null, summaryOpen: view.summaryOpen, model: '', effort: '', turns: 0, tokens: '0', prUrl: null, memo: null, started: '', lastActivity: '', hasTranscript: false, items: [], total: 0, loaded: 0, loading: false, hasMore: false, showThinking: view.showThinking, showRaw: view.showRaw, follow: view.follow, agentId: view.agentId, subagents: store.subagents[id] ?? [], loadingSession: false, run: null, tabs: [], selectedTab: null, transcriptOpen: view.transcriptOpen, trustHint: false, canResume: false, canFork: false, contextPercent: null, cost: '', artifacts: [], summaryPending: false, summaryError: null, fromScratch: false, canPromote: false, split: null, canSplit: false, lock: null, remoteOnly: false, canResumeHere: false, outsideOpen: null, liveLabel: null, filesChanged: 0, turnRows: [], turnsComplete: true, openTurnItems: [], turnJump: null };
  // 起動の応答は HTTP で先に返り、session.upsert は WebSocket で遅れて届く。
  // run だけ知っている間は「見つかりません」ではなく読み込み中にする。
  if (!s) { const loading = hasRunOf(store, id); return { ...base, name: id, notFound: !loading, loadingSession: loading }; }
  const slice = store.events[eventsKey(id, view.agentId)];
  // 本文は最新の側から読み、遡ったページは store の後ろに足される。並びは表示の直前にここで戻す。
  // 走査して崩れているときだけ並べ直すので、遡っていない間は写しも取らない。
  const raw = slice?.items ?? [];
  let sorted = true;
  for (let i = 1; i < raw.length; i++) if (raw[i]!.seq < raw[i - 1]!.seq) { sorted = false; break; }
  const events = sorted ? raw : [...raw].sort((a, b) => a.seq - b.seq);
  const itemOpts = { showThinking: view.showThinking, showRaw: view.showRaw, subagents: store.subagents[id] ?? [] };
  const items = buildItems(events, itemOpts);
  const turnList = buildTurns(events);
  const openTurn = turnList.find((t) => t.seq === view.openTurn) ?? null;
  const turnRows: TurnRowProps[] = turnList.map((t) => ({ seq: t.seq, when: when(t.ts), text: t.text, head: t.head, tools: t.tools, open: t === openTurn }));
  const openTurnItems = openTurn ? buildItems(events.filter((e) => e.seq >= openTurn.from && e.seq < openTurn.to), itemOpts) : [];
  const run = currentRunOf(store, id);
  const alive = aliveRunOf(store, id) !== null;
  const open = run ? tabsOf(store, run.id) : [];
  const selectedTab = run ? (view.selectedTab && open.some((t) => t.id === view.selectedTab) ? view.selectedTab : run.id) : null;
  const tabs: TabItemProps[] = open.map((t) => ({ id: t.id, title: t.title, kind: t.kind, selected: t.id === selectedTab, closable: t.kind === 'shell' }));
  const idle = !alive && s.live === null && state.launch.kind !== 'submitting';
  const canSplit = open.length >= 2;
  // splitTab が閉じたタブを指していることがあるので、左と違う最初のタブに落とす。
  const right = view.split && canSplit && selectedTab ? open.find((t) => t.id === view.splitTab && t.id !== selectedTab) ?? open.find((t) => t.id !== selectedTab) ?? null : null;
  return {
    ...base, name: s.name ?? '（名前なし）', live: s.live, cwd: s.cwd, projectName: s.projectId ? store.projects[s.projectId]?.name ?? null : null, projectId: s.projectId,
    summary: s.summary ? { ...s.summary, sourceLabel: SOURCE_LABEL[s.summary.source], stateLabel: STATE_LABEL[s.summary.state], summarizerLabel: summarizerLabel(s.summary.sourceId, s.summary.sourceModel), generatedAt: absoluteTime(s.summary.updatedAt) } : null,
    model: shortModel(s.stats.model), effort: s.stats.effort ?? '', turns: s.stats.turns, tokens: tokensLabel(s.stats.inputTokens + s.stats.outputTokens), prUrl: s.stats.prUrl, memo: s.memo,
    started: relativeTime(s.startedAt, now), lastActivity: relativeTime(s.lastActivityAt, now), hasTranscript: s.hasTranscript,
    items, total: slice?.total ?? 0, loaded: slice?.items.length ?? 0, loading: slice?.loading ?? false, hasMore: slice ? slice.total > slice.items.length : false, notFound: false,
    turnRows, turnsComplete: slice ? slice.total <= slice.items.length : true, openTurnItems, turnJump: view.turnJump,
    run: run ? { id: run.id, kind: run.kind, alive: run.endedAt === null, started: relativeTime(run.startedAt, now) } : null,
    tabs, selectedTab, trustHint: alive && s.live === null,
    // 他端末が動かしている間は再開もフォークもさせない。手元に写ししか無いセッションも同じである。
    // 手元で続けたいときは「この PC で再開」に回して、本文を降ろしてから新しい run を立てる。
    canResume: s.hasTranscript && idle && s.lock === null && !s.remoteOnly, canFork: s.hasTranscript && idle && s.lock === null && !s.remoteOnly,
    // Ruling 14。heartbeat が途絶えたロック（stale）は行き止まりにせず、「この PC で再開」だけを開ける。
    // 相手の run は止めに行かないので、同じ run の続きである再開とフォークは閉じたままにする。
    lock: lockProps(s.lock, now), remoteOnly: s.remoteOnly, canResumeHere: s.lock === null ? s.remoteOnly : s.lock.stale,
    // hangar の run が無いまま外で動いているとき、本文しか見せられない。hangar の端末で開く手を出す（store の outsideOpenOf）。
    outsideOpen: outsideOpenOf(store, s),
    contextPercent: s.stats.contextPercent, cost: costLabel(s.stats.costUsd), filesChanged: s.stats.filesChanged,
    // 作業中は Home の実行中の札と同じく始まりから、入力待ちと休みは Home の要対応と休みの札と同じく最後の動きから数える。
    liveLabel: s.live ? `${LIVE_WORD[s.live]} ${durationLabel(now - ((s.live === 'busy' ? s.startedAt : s.lastActivityAt) ?? now))}` : null,
    artifacts: artifactsOf(store, { sessionId: id }).map((a) => presentArtifactCard(a, now)),
    summaryPending: store.summaryPending[id] === true, summaryError: state.summaryFailed[id] ?? null,
    fromScratch: s.fromScratch, canPromote: !!(s.projectId && store.projects[s.projectId]?.isScratch),
    split: right && selectedTab ? { left: selectedTab, right: right.id } : null, canSplit,
  };
}
