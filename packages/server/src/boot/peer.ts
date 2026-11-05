import type { AgentKind, PeerLaunchIncoming } from '@agent-hangar/shared';
import { AGENT_ENTRY } from '../agent/entry.ts';
import { getSession } from '../db/queries.ts';
import { MAX_SEND_CHARS, sanitizeInput } from '../mcp/screenTools.ts';
import { lastReply, noteTurnStart } from '../mcp/waitTool.ts';
import { PeerLaunchInbox, type PeerAccount } from '../peer/launchInbox.ts';
import { PeerRelay } from '../peer/relay.ts';
import { aliveRunForSession } from '../runs/queries.ts';
import type { SyncEngine } from '../sync/engine.ts';
import type { DeliveryParts } from './delivery.ts';
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
 * 起こした会話のターンの止まりは、結果の見張り（peer/relay.ts）が呼び出し元へ書く。登録の変化（live）と run の終わりを聞き、返す。
 * send と stop の頼み（D16）は、受け口が結び付きを確かめたうえで、この組みの入力の口と run の停止に渡す。
 */
export function bootPeer(p: {
  home: Pick<HomeParts, 'db' | 'device' | 'settings'>;
  runs: Pick<RunsParts, 'runs' | 'accounts' | 'claudeBin'>;
  delivery: Pick<DeliveryParts, 'live'>;
  sync: Pick<SyncParts, 'engine' | 'peerLink' | 'canCarryPeer'>;
  now?: () => number;
  setInterval?: typeof setInterval;
}): PeerParts & { inbox(): PeerLaunchInbox | null; relay: PeerRelay } {
  const { db } = p.home;
  const deviceId = p.home.device.id;
  const accounts = p.runs.accounts;
  const placeHere = db.prepare('select 1 from project_roots r join projects p on p.id = r.project_id where r.project_id = ? and r.device_id = ? and r.deleted_at is null and r.resolved = 1 and p.deleted_at is null and p.is_scratch = 0');
  let cur: { link: ReturnType<SyncParts['peerLink']> & object; inbox: PeerLaunchInbox } | null = null;
  let sub: { engine: Pick<SyncEngine, 'on'>; off: () => void } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const now = p.now ?? Date.now;
  const relay = new PeerRelay({
    db, deviceId, now,
    live: () => p.delivery.live.current(),
    ring: async () => { const l = p.sync.peerLink(); if (!l) throw new Error('peer link is not ready'); return l.ring(); },
    api: () => p.sync.peerLink()?.api ?? null,
    canProcess: () => !stopped && p.sync.canCarryPeer(),
    lastReply: (id) => lastReply(db, id),
    describe: (id) => {
      const s = getSession(db, p.delivery.live.current(), id, { deviceId });
      return s ? { title: s.name ?? s.summary?.title ?? s.aiTitle ?? s.firstPrompt ?? null, summary: s.summary?.oneLiner ?? null, status: s.summary?.state ?? null } : null;
    },
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); },
  });
  const ownRun = (sessionId: string) => {
    const run = aliveRunForSession(db, sessionId, deviceId, now());
    if (!run || run.deviceId !== deviceId) throw new Error('the session is not running on this device');
    return run;
  };
  const control = {
    async send(sessionId: string, text: string): Promise<void> {
      const run = ownRun(sessionId);
      const clean = sanitizeInput(text);
      if (!clean.trim() || clean.length > MAX_SEND_CHARS) throw new Error('the text cannot be sent');
      // 入れる直前に印を付ける。届いた直後の止まりを取りこぼさず、前のターンの idle を結果にしないためである。
      relay.arm(sessionId);
      noteTurnStart(db, sessionId, { at: now() });
      try {
        await p.runs.runs.sendInput(run.tmuxName, clean, true);
      } catch (e) {
        relay.disarm(sessionId);
        throw e;
      }
    },
    stop(sessionId: string): void {
      p.runs.runs.kill(ownRun(sessionId).id);
    },
  };
  let offLive: (() => void) | null = null;
  let offRuns: (() => void) | null = null;

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
      now,
      onStarted: (e) => relay.onStarted(e),
      control,
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
      relay.check();
      void relay.flush();
    } catch (e) {
      console.error('[peer] could not run the peer watch', e instanceof Error ? e.constructor.name : typeof e);
    }
  };

  return {
    inbox: () => ensure(),
    relay,
    start() {
      if (timer || stopped) return;
      offLive = p.delivery.live.onChange(() => relay.check());
      offRuns = p.runs.runs.on({ runEnded: (run) => relay.onProcessEnded(run.sessionId) });
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
      offLive?.();
      offRuns?.();
    },
  };
}
