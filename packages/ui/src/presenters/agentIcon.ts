import { agentIconKindOf, agentIconsShown, opencodeEnabledOf, type AgentIconKind, type LiveSessionDto, type SessionDto } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';

/** opencode の会話があるか。行ごとに全件を数え直さないよう、会話の表と実行中の写しの組ごとに覚える。 */
const hasOpencodeMemo = new WeakMap<Record<string, SessionDto>, WeakMap<LiveSessionDto[], boolean>>();
function hasOpencode(store: Pick<Store, 'sessions' | 'live'>): boolean {
  let byLive = hasOpencodeMemo.get(store.sessions);
  if (!byLive) { byLive = new WeakMap(); hasOpencodeMemo.set(store.sessions, byLive); }
  let v = byLive.get(store.live);
  if (v === undefined) {
    v = store.live.some((l) => l.agent === 'opencode') || Object.values(store.sessions).some((s) => s.provider === 'opencode');
    byLive.set(store.live, v);
  }
  return v;
}

/**
 * 一覧とサイドバーにエージェントのアイコンを出すか（shared の agentIconsShown）。
 * 設定の「opencode を有効にする」が切で、opencode の会話が 1 つも無いときは出さない。
 * 会話は bootstrap で全部が届くので、表に無ければ、その PC の hangar には opencode の会話が無い。
 */
export function agentIconsOn(store: Pick<Store, 'settings' | 'sessions' | 'live'>): boolean {
  return agentIconsShown({ opencodeEnabled: opencodeEnabledOf(store.settings ?? {}), hasOpencode: hasOpencode(store) });
}

/**
 * 会話のエージェントの絵の種類。
 * セッションの provider を正にし、実行中の写しが opencode と言っていればそちらを採る（会話の行が届く前の写し）。
 * 種類の無い会話は Clawd、知らない種類は null（空の枠）である。
 */
export function agentOfSession(store: Pick<Store, 'live'>, s: SessionDto): AgentIconKind | null {
  // 写しの sessionId はエージェントの側の ID（SessionDto.providerSessionId）である（store の relive と同じ突き合わせ）。
  if (store.live.some((l) => l.sessionId === s.providerSessionId && l.agent === 'opencode')) return 'opencode';
  return agentIconKindOf(s.provider);
}

/** 行に載せるアイコンの種類。出さないときは undefined で、行は枠ごと置かない。 */
export function rowAgent(store: Pick<Store, 'settings' | 'sessions' | 'live'>, s: SessionDto): AgentIconKind | null | undefined {
  return agentIconsOn(store) ? agentOfSession(store, s) : undefined;
}
