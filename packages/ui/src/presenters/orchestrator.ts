import type { Translate, TranscriptEvent } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import type { PeerChatRow } from './peerChat.ts';

/**
 * 統括の柱（views/OrchestratorPillar.tsx、docs/design.md「統括」）の描き分け。
 * 画面は state を読まず、ここで決めた値だけを描く。
 * 会話の列は PeerChatLog と同じ行（PeerChatRow）にして、ほかの PC の会話の表示の部品をそのまま使う。
 */

/** 出来事（hangar が送り込む文）の印。この印で始まる入力は利用者の言葉ではない。 */
export const HANGAR_TAG = '[hangar]';
/** 音声入力の印。利用者が話した入力で、返答を読み上げる。 */
export const VOICE_TAG = '[voice]';

export type Speak = { key: string; text: string };

/**
 * 読み上げる文の決まり（docs/design.md「統括」の読み上げ）。
 * reply は、最後のターンが音声で始まったときの最後の返答。notices は、出来事で始まったターンの notify_user の文。
 * 文字で打ったターンと、出来事で始まったターンの返答は読まない。
 * voiceOn は、利用者の最後の入力が音声だったか（出来事のターンは数えない。画面がマイクを使った印と合わせて、notify_user を読むかを決める）。
 */
export type SpeakPlan = { reply: Speak | null; notices: Speak[]; voiceOn: boolean };

type Turn = 'typed' | 'voice' | 'hangar';

const turnOf = (text: string): Turn => (text.startsWith(HANGAR_TAG) ? 'hangar' : text.startsWith(VOICE_TAG) ? 'voice' : 'typed');
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
      const text = (turn === 'voice' ? e.text.slice(VOICE_TAG.length) : e.text).trim();
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
};

const STATUS_KEY = { busy: 'peerChat.status.busy', idle: 'peerChat.status.idle', waiting: 'peerChat.status.waiting', ended: 'peerChat.status.stopped' } as const;

/** 記録の中身の先頭（最初の空でない行）。 */
const headOf = (input: string): string => input.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';

/** 柱の中身。統括が無効か、会話がまだ無ければ null（柱ごと出さない）。 */
export function presentOrchestrator(store: Store, t: Translate): OrchestratorPillarProps | null {
  const o = store.settings?.orchestrator;
  if (!o?.enabled || !o.sessionId) return null;
  const sessionId = o.sessionId;
  const live = store.live.find((l) => l.sessionId === sessionId)?.status ?? store.sessions[sessionId]?.live ?? null;
  const tone = live ?? 'ended';
  const { rows, speak } = orchestratorRows(store.orchestrator.events);
  return {
    sessionId, tone, statusLabel: t(STATUS_KEY[tone]),
    policy: store.settings?.permissionPolicy?.text ?? null,
    approvals: store.orchestrator.approvals.map((a) => ({ id: a.id, sessionId: a.sessionId, title: a.title, tool: a.tool, head: headOf(a.input) })),
    rows, loading: !store.orchestrator.loaded, canSend: live !== null, sending: store.orchestrator.sending, speak,
  };
}
