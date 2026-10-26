import { agentIconKindOf, agentIconsShown, codexEnabledOf, opencodeEnabledOf, type AgentIconKind, type LiveSessionDto, type SessionDto } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';

/** Claude 以外のエージェントの会話があるか。行ごとに全件を数え直さないよう、会話の表と実行中の写しの組ごとに覚える。 */
const hasOtherMemo = new WeakMap<Record<string, SessionDto>, WeakMap<LiveSessionDto[], { opencode: boolean; codex: boolean }>>();
function hasOther(store: Pick<Store, 'sessions' | 'live'>): { opencode: boolean; codex: boolean } {
  let byLive = hasOtherMemo.get(store.sessions);
  if (!byLive) { byLive = new WeakMap(); hasOtherMemo.set(store.sessions, byLive); }
  let v = byLive.get(store.live);
  if (v === undefined) {
    const sessions = Object.values(store.sessions);
    v = {
      opencode: store.live.some((l) => l.agent === 'opencode') || sessions.some((s) => s.provider === 'opencode'),
      codex: store.live.some((l) => l.agent === 'codex') || sessions.some((s) => s.provider === 'codex'),
    };
    byLive.set(store.live, v);
  }
  return v;
}

/**
 * 一覧とサイドバーにエージェントのアイコンを出すか（shared の agentIconsShown）。
 * 設定の「opencode を有効にする」「Codex を有効にする」が切で、Claude 以外の会話が 1 つも無いときは出さない。
 * 会話は bootstrap で全部が届くので、表に無ければ、その PC の hangar にはその会話が無い。
 */
export function agentIconsOn(store: Pick<Store, 'settings' | 'sessions' | 'live'>): boolean {
  const other = hasOther(store);
  const settings = store.settings ?? {};
  return agentIconsShown({ opencodeEnabled: opencodeEnabledOf(settings), hasOpencode: other.opencode, codexEnabled: codexEnabledOf(settings), hasCodex: other.codex });
}

/**
 * 会話のエージェントの絵の種類。
 * セッションの provider を正にし、実行中の写しがエージェントを言っていればそちらを採る（会話の行が届く前の写し）。
 * 種類の無い会話は Clawd、知らない種類は null（空の枠）である。
 */
export function agentOfSession(store: Pick<Store, 'live'>, s: SessionDto): AgentIconKind | null {
  // 写しの sessionId はエージェントの側の ID（SessionDto.providerSessionId）である（store の relive と同じ突き合わせ）。
  const liveAgent = store.live.find((l) => l.sessionId === s.providerSessionId && l.agent !== undefined)?.agent;
  if (liveAgent) return liveAgent;
  return agentIconKindOf(s.provider);
}

/** 行に載せるアイコンの種類。出さないときは undefined で、行は枠ごと置かない。 */
export function rowAgent(store: Pick<Store, 'settings' | 'sessions' | 'live'>, s: SessionDto): AgentIconKind | null | undefined {
  return agentIconsOn(store) ? agentOfSession(store, s) : undefined;
}
