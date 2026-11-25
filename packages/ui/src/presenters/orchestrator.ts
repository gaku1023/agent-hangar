import { ORCHESTRATOR_CONTEXT_LIMIT, permissionToolLabel, stripPasted, VOICE_MARK, VOICE_WINDOW_MARK, type OrchestratorStateDto, type Translate, type TranscriptEvent } from '@agent-hangar/shared';
import { contextTokensLabel } from './format.ts';
import { unreadOf, type Store } from '../store/store.ts';
import type { PeerChatRow } from './peerChat.ts';

/**
 * 統括の柱（views/OrchestratorPillar.tsx、docs/design.md「統括」）の描き分け。
 * 画面は state を読まず、ここで決めた値だけを描く。
 * 会話の列は PeerChatLog と同じ行（PeerChatRow）にして、ほかの PC の会話の表示の部品をそのまま使う。
 */

/** 出来事（hangar が送り込む文）の印。この印で始まる入力は利用者の言葉ではない。 */
export const HANGAR_TAG = '[hangar]';
/** 音声入力の印（強い声と弱い声）。サーバが由来から付ける（shared の markOrchestratorText）。利用者が話した入力で、返答を読み上げる。 */
const VOICE_TAGS = [VOICE_WINDOW_MARK, VOICE_MARK] as const;
const voiceTagOf = (text: string): string | undefined => VOICE_TAGS.find((m) => text.startsWith(m));

export type Speak = { key: string; text: string };

/**
 * 読み上げる文の決まり（docs/design.md「統括」の読み上げ）。
 * reply は、最後のターンが音声で始まったときの最後の返答。notices は、出来事で始まったターンの notify_user の文。
 * 文字で打ったターンと、出来事で始まったターンの返答は読まない。
 * voiceOn は、利用者の最後の入力が音声だったか（出来事のターンは数えない。画面がマイクを使った印と合わせて、notify_user を読むかを決める）。
 */
export type SpeakPlan = { reply: Speak | null; notices: Speak[]; voiceOn: boolean };

type Turn = 'typed' | 'voice' | 'hangar';

const turnOf = (text: string): Turn => (text.startsWith(HANGAR_TAG) ? 'hangar' : voiceTagOf(text) !== undefined ? 'voice' : 'typed');
const isNotify = (e: TranscriptEvent): e is Extract<TranscriptEvent, { kind: 'tool_call' }> => e.kind === 'tool_call' && /(^|__)notify_user$/.test(e.name);
const notifyText = (e: Extract<TranscriptEvent, { kind: 'tool_call' }>): string => {
  const t = (e.input as { text?: unknown } | null)?.text;
  return typeof t === 'string' ? t.trim() : '';
};

/** 統括の会話の本文を、柱の列と読み上げの計画にする（純粋）。 */
export function orchestratorRows(events: readonly TranscriptEvent[]): { rows: PeerChatRow[]; speak: SpeakPlan } {
  const rows: PeerChatRow[] = [];
  const notices: Speak[] = [];
  let turn: Turn = 'typed';
  let last: Speak | null = null;
  let voiceOn = false;
  // notify_user は、成功の結果が付いた呼び出しだけを描く（失敗の再試行で同じ文が重なるため）。
  const ok = new Set<string>();
  for (const e of events) if (e.kind === 'tool_result' && !e.isError) ok.add(e.toolId);
  for (const e of events) {
    if (e.kind === 'user') {
      turn = turnOf(e.text);
      last = null;
      if (turn !== 'hangar') voiceOn = turn === 'voice';
      if (turn === 'hangar') continue;
      const text = stripPasted(turn === 'voice' ? e.text.slice(voiceTagOf(e.text)!.length) : e.text).trim();
      if (text !== '') rows.push({ kind: 'user', key: String(e.seq), text, from: null });
    } else if (e.kind === 'assistant') {
      if (turn === 'hangar' || e.text.trim() === '') continue;
      rows.push({ kind: 'assistant', key: String(e.seq), text: e.text });
      last = { key: String(e.seq), text: e.text };
    } else if (isNotify(e)) {
      const text = notifyText(e);
      if (text === '' || !ok.has(e.toolId)) continue;
      rows.push({ kind: 'assistant', key: `n${e.seq}`, text });
      if (turn === 'hangar') notices.push({ key: `n${e.seq}`, text });
    }
  }
  return { rows, speak: { reply: turn === 'voice' ? last : null, notices, voiceOn } };
}

export type ApprovalRowView = { id: string; sessionId: string; title: string; tool: string; head: string };

export type OrchestratorPillarProps = {
  sessionId: string;
  tone: 'busy' | 'idle' | 'waiting' | 'ended';
  statusLabel: string;
  /** 方針の 1 行（利用者の言葉そのまま）。無ければ null。 */
  policy: string | null;
  /** 自動許可の記録（新しい順）。 */
  approvals: ApprovalRowView[];
  rows: PeerChatRow[];
  loading: boolean;
  /** 統括が動いていなければ入力欄は送れない。 */
  canSend: boolean;
  sending: boolean;
  speak: SpeakPlan;
  /** 机の音声の状態。補助が使えるとき（available）だけ丸が VoicePill になる。 */
  voice?: import('@agent-hangar/shared').VoiceStateDto | null;
  /** 見張りの状態（柱のメニュー）。stopped は止まった理由で、止まっていれば停止の代わりに再開を出す。switching の間は操作を押せない。 */
  keeper: { stopped: null | 'user' | 'failures'; switching: boolean };
  /** 文脈の量（柱の上端の棒）。ratio は棒の幅（0〜1）、over は自動の切り替えの閾値を超えたか、label は札。量が分からなければ null。 */
  context: { ratio: number; over: boolean; label: string } | null;
};

/** 棒の右端の量。閾値が棒の 3/4 の位置に来るようにする。 */
const CONTEXT_FULL = (ORCHESTRATOR_CONTEXT_LIMIT * 4) / 3;

/** 見張りの状態を、メニューと棒の値にする（純粋）。 */
export function keeperView(k: OrchestratorStateDto | null, t: Translate): Pick<OrchestratorPillarProps, 'keeper' | 'context'> {
  const tokens = k?.contextTokens;
  return {
    keeper: { stopped: k?.status === 'stopped' ? k.reason : null, switching: k?.switching === true },
    context: tokens === undefined ? null : { ratio: Math.min(1, tokens / CONTEXT_FULL), over: tokens > ORCHESTRATOR_CONTEXT_LIMIT, label: t('orchestratorPane.context.label', { tokens: contextTokensLabel(tokens) }) },
  };
}

const STATUS_KEY = { busy: 'peerChat.status.busy', idle: 'peerChat.status.idle', waiting: 'peerChat.status.waiting', ended: 'peerChat.status.stopped' } as const;

/** 記録の中身の先頭（最初の空でない行）。 */
const headOf = (input: string): string => input.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';

/** 柱の中身。統括が無効か、会話がまだ無ければ null（柱ごと出さない）。 */
export function presentOrchestrator(store: Store, t: Translate): OrchestratorPillarProps | null {
  const o = store.settings?.orchestrator;
  if (!o?.enabled || !o.sessionId) return null;
  const sessionId = o.sessionId;
  const live = store.live.find((l) => l.sessionId === sessionId)?.status ?? store.sessions[sessionId]?.live ?? null;
  const kv = keeperView(store.orchestrator.keeper, t);
  // 止めた会話は、run が消えるまでの間も止まった色で見せる。
  const tone = kv.keeper.stopped ? 'ended' : live ?? 'ended';
  const statusLabel = kv.keeper.switching ? t('orchestratorPane.status.switching')
    : kv.keeper.stopped === 'failures' ? t('orchestratorPane.status.stoppedFailures')
    : t(STATUS_KEY[tone]);
  const { rows, speak } = orchestratorRows(store.orchestrator.events);
  return {
    sessionId, tone, statusLabel, ...kv,
    policy: store.settings?.permissionPolicy?.text ?? null,
    approvals: store.orchestrator.approvals.map((a) => ({ id: a.id, sessionId: a.sessionId, title: a.title, tool: permissionToolLabel(t, a.tool), head: headOf(a.input) })),
    rows, loading: !store.orchestrator.loaded, canSend: live !== null && !kv.keeper.stopped && !kv.keeper.switching, sending: store.orchestrator.sending, speak, voice: store.voice,
  };
}

/**
 * サイドバーの上の「統括」の行（views/Sidebar.tsx）。無効か会話がまだ無ければ null（行ごと出さない）。
 * 色は柱の丸と同じ tone。数は、判断待ちの 1 に統括の会話の未読の数を足したもの（ホームの行の数と同じ組み方）。
 */
export type OrchestratorNavProps = { label: string; tone: OrchestratorPillarProps['tone']; statusLabel: string; count: number; waiting: number; unread: number };

export function presentOrchestratorNav(store: Store, t: Translate): OrchestratorNavProps | null {
  const o = store.settings?.orchestrator;
  if (!o?.enabled || !o.sessionId) return null;
  const live = store.live.find((l) => l.sessionId === o.sessionId)?.status ?? store.sessions[o.sessionId]?.live ?? null;
  const tone = live ?? 'ended';
  const waiting = tone === 'waiting' ? 1 : 0;
  const unread = unreadOf(store, o.sessionId)?.count ?? 0;
  return { label: t('orchestratorPane.pillar.region'), tone, statusLabel: t(STATUS_KEY[tone]), count: waiting + unread, waiting, unread };
}
