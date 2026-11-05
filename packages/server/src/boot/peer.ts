import type { AgentKind, PeerLaunchIncoming } from '@agent-hangar/shared';
import { AGENT_ENTRY } from '../agent/entry.ts';
import { PeerLaunchInbox, type PeerAccount } from '../peer/launchInbox.ts';
import type { SyncEngine } from '../sync/engine.ts';
import type { HomeParts } from './home.ts';
import type { RunsParts } from './runs.ts';
import type { SyncParts } from './sync.ts';

/** 答えを送れなかった頼みを送り直す見回りの間隔。 */
export const PEER_RESEND_MS = 30_000;

export type PeerParts = { start(): void; stop(): void };

/**
 * 別の PC からの起動の頼みを受ける持ち場（peer/launchInbox.ts）を組む。
 * 頼みは同期の engine の pull（peerLaunches）で届く。呼び鈴の知らせも pull を前倒しするだけである（boot/mobile.ts）。
 * 同期を設定していない、または Worker の版が足りないあいだは何もしない（canCarryPeer）。
 * 組み立てた受け口は inbox() で引ける。SSH の /peer の入口は、同じ受け口の receive に頼みを渡す。
 */
export function bootPeer(p: {
  home: Pick<HomeParts, 'db' | 'device' | 'settings'>;
  runs: Pick<RunsParts, 'runs' | 'accounts' | 'claudeBin'>;
  sync: Pick<SyncParts, 'engine' | 'peerLink' | 'canCarryPeer'>;
  now?: () => number;
  setInterval?: typeof setInterval;
}): PeerParts & { inbox(): PeerLaunchInbox | null } {
  const { db } = p.home;
  const deviceId = p.home.device.id;
  const accounts = p.runs.accounts;
  const placeHere = db.prepare('select 1 from project_roots r join projects p on p.id = r.project_id where r.project_id = ? and r.device_id = ? and r.deleted_at is null and r.resolved = 1 and p.deleted_at is null and p.is_scratch = 0');
  let cur: { link: ReturnType<SyncParts['peerLink']> & object; inbox: PeerLaunchInbox } | null = null;
  let sub: { engine: Pick<SyncEngine, 'on'>; off: () => void } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const byName = (agent: 'claude-code' | 'codex', name: string): PeerAccount | null => {
    const store = agent === 'claude-code' ? accounts.store : accounts.codex?.store;
    const auth = agent === 'claude-code' ? accounts.auth : accounts.codex?.auth;
    if (!store || !auth || (agent === 'codex' && !accounts.codex?.enabled())) return null;
    const a = store.list().find((x) => x.name === name);
    if (!a) return null;
    if (auth.get(a.id) === null) auth.ensureChecked(a as never);
    return { id: a.id, loggedIn: auth.get(a.id)?.loggedIn ?? null };
  };
  const agentUsable = (k: AgentKind): boolean => (k === 'claude-code' ? p.runs.claudeBin() !== null : AGENT_ENTRY[k].enabled(p.home.settings.current) && AGENT_ENTRY[k].bin() !== null);

  /** 今の同期の口に合う受け口を返す。口が変わっていたら組み直す。 */
  const ensure = (): PeerLaunchInbox | null => {
    if (stopped) return null;
    const link = p.sync.peerLink();
    if (!link) { cur = null; return null; }
    if (cur && cur.link.api === link.api && cur.link.ring === link.ring) return cur.inbox;
    const inbox = new PeerLaunchInbox({
      db, api: link.api, ring: link.ring, reread: link.reread, deviceId,
      start: (params) => p.runs.runs.start(params),
      hasProjectHere: (id) => !!placeHere.get(id, deviceId),
      accountByName: byName,
      hasAgent: agentUsable,
      canProcess: () => !stopped && p.sync.canCarryPeer(),
      now: p.now ?? Date.now,
    });
    cur = { link, inbox };
    return inbox;
  };
  const follow = (): void => {
    const engine = p.sync.engine;
    if (sub?.engine === engine) return;
    sub?.off();
    sub = { engine, off: engine.on({ peerLaunches: (l: PeerLaunchIncoming[]) => { void ensure()?.receive(l).catch((e: unknown) => console.error('[peer] could not handle the launch requests', e instanceof Error ? e.constructor.name : typeof e)); } }) };
  };
  const tick = (): void => {
    try {
      follow();
      void ensure()?.resendAnswers();
    } catch (e) {
      console.error('[peer] could not run the peer watch', e instanceof Error ? e.constructor.name : typeof e);
    }
  };

  return {
    inbox: () => ensure(),
    start() {
      if (timer || stopped) return;
      tick();
      timer = (p.setInterval ?? setInterval)(tick, PEER_RESEND_MS);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      sub?.off();
      sub = null;
    },
  };
}
