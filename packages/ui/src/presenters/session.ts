import type { LiveStatus, RunKind, SessionSummaryDto, TranscriptEvent } from '@agent-hangar/shared';
import { defaultSessionView } from '../mediator/sessionView.ts';
import type { State } from '../mediator/types.ts';
import { aliveRunOf, artifactsOf, currentRunOf, eventsKey, hasRunOf, tabsOf, type Store } from '../store/store.ts';
import { absoluteTime, costLabel, relativeTime, shortModel, SOURCE_LABEL, STATE_LABEL, tokensLabel } from './format.ts';
import { presentArtifactCard, type ArtifactCardProps } from './project.ts';

export type TranscriptItem =
  | { kind: 'user' | 'assistant' | 'thinking' | 'system'; seq: number; text: string; when: string }
  | { kind: 'tool'; seq: number; summary: string; name: string; inputJson: string; result: { text: string; isError: boolean } | null; when: string; subagent: { agentId: string; label: string } | null }
  | { kind: 'meta'; seq: number; name: string; json: string };
export type TabItemProps = { id: string; title: string; kind: 'agent' | 'shell'; selected: boolean; closable: boolean };

/**
 * 要約に使った要約器とモデルの表示。
 * DB には `source_model` しか無く、要約器の id は別に持っていない。
 * claude -p のフォールバックは必ず `haiku` と書き、LM Studio は読み込んでいるモデルの id を書くので、
 * モデル名の側から種類を見分ける。モデル名を言えなかったときは要約器の id がそのまま入るので、
 * 同じ名前を 2 回並べない。
 */
export function summarizerLabel(sourceModel: string | null): string | null {
  if (!sourceModel) return null;
  const kind = /^(haiku|sonnet|opus|claude)/.test(sourceModel) ? 'claude' : 'lmstudio';
  const model = sourceModel === `${kind}:auto` || sourceModel === kind || sourceModel === 'claude-headless' ? null : sourceModel;
  return model ? `${kind} / ${model}` : kind;
}

export type SessionProps = { id: string; name: string; live: LiveStatus | null; cwd: string; projectName: string | null; projectId: string | null; summary: (SessionSummaryDto & { sourceLabel: string; stateLabel: string; summarizerLabel: string | null; generatedAt: string }) | null; summaryOpen: boolean; model: string; effort: string; turns: number; tokens: string; prUrl: string | null; memo: string | null; started: string; lastActivity: string; hasTranscript: boolean; items: TranscriptItem[]; total: number; loaded: number; loading: boolean; hasMore: boolean; showThinking: boolean; showRaw: boolean; follow: boolean; agentId: string | null; subagents: string[]; notFound: boolean; loadingSession: boolean; run: { id: string; kind: RunKind; alive: boolean; started: string } | null; tabs: TabItemProps[]; selectedTab: string | null; transcriptOpen: boolean; trustHint: boolean; canResume: boolean; canFork: boolean; contextPercent: number | null; cost: string; artifacts: ArtifactCardProps[]; summaryPending: boolean; summaryError: string | null; fromScratch: boolean; canPromote: boolean; split: { left: string; right: string } | null; canSplit: boolean };

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const when = (ts: number | undefined) => (ts === undefined ? '' : absoluteTime(ts).slice(11));

export function buildItems(events: TranscriptEvent[], opts: { showThinking: boolean; showRaw: boolean; subagents: string[] }): TranscriptItem[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.toolId, { text: e.text, isError: e.isError });
  const items: TranscriptItem[] = [];
  let nextSub = 0;
  for (const e of events) {
    switch (e.kind) {
      case 'user': case 'assistant': case 'system': items.push({ kind: e.kind, seq: e.seq, text: e.text, when: when(e.ts) }); break;
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
  const base = { id, live: null, cwd: '', projectName: null, projectId: null, summary: null, summaryOpen: view.summaryOpen, model: '', effort: '', turns: 0, tokens: '0', prUrl: null, memo: null, started: '', lastActivity: '', hasTranscript: false, items: [], total: 0, loaded: 0, loading: false, hasMore: false, showThinking: view.showThinking, showRaw: view.showRaw, follow: view.follow, agentId: view.agentId, subagents: store.subagents[id] ?? [], loadingSession: false, run: null, tabs: [], selectedTab: null, transcriptOpen: view.transcriptOpen, trustHint: false, canResume: false, canFork: false, contextPercent: null, cost: '', artifacts: [], summaryPending: false, summaryError: null, fromScratch: false, canPromote: false, split: null, canSplit: false };
  // 起動の応答は HTTP で先に返り、session.upsert は WebSocket で遅れて届く。
  // run だけ知っている間は「見つかりません」ではなく読み込み中にする。
  if (!s) { const loading = hasRunOf(store, id); return { ...base, name: id, notFound: !loading, loadingSession: loading }; }
  const slice = store.events[eventsKey(id, view.agentId)];
  const items = buildItems(slice?.items ?? [], { showThinking: view.showThinking, showRaw: view.showRaw, subagents: store.subagents[id] ?? [] });
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
    summary: s.summary ? { ...s.summary, sourceLabel: SOURCE_LABEL[s.summary.source], stateLabel: STATE_LABEL[s.summary.state], summarizerLabel: summarizerLabel(s.summary.sourceModel), generatedAt: absoluteTime(s.summary.updatedAt) } : null,
    model: shortModel(s.stats.model), effort: s.stats.effort ?? '', turns: s.stats.turns, tokens: tokensLabel(s.stats.inputTokens + s.stats.outputTokens), prUrl: s.stats.prUrl, memo: s.memo,
    started: relativeTime(s.startedAt, now), lastActivity: relativeTime(s.lastActivityAt, now), hasTranscript: s.hasTranscript,
    items, total: slice?.total ?? 0, loaded: slice?.items.length ?? 0, loading: slice?.loading ?? false, hasMore: slice ? slice.nextSeq !== null || slice.total > slice.items.length : false, notFound: false,
    run: run ? { id: run.id, kind: run.kind, alive: run.endedAt === null, started: relativeTime(run.startedAt, now) } : null,
    tabs, selectedTab, trustHint: alive && s.live === null, canResume: s.hasTranscript && idle, canFork: s.hasTranscript && idle,
    contextPercent: s.stats.contextPercent, cost: costLabel(s.stats.costUsd),
    artifacts: artifactsOf(store, { sessionId: id }).map((a) => presentArtifactCard(a, now)),
    summaryPending: store.summaryPending[id] === true, summaryError: state.summaryFailed[id] ?? null,
    fromScratch: s.fromScratch, canPromote: !!(s.projectId && store.projects[s.projectId]?.isScratch),
    split: right && selectedTab ? { left: selectedTab, right: right.id } : null, canSplit,
  };
}
