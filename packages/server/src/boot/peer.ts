import { notifyRulesOf, type AgentKind, type PeerBellKind, type PeerKeyring, type PeerLaunchIncoming, type ServerEvent } from '@agent-hangar/shared';
import { AGENT_ENTRY } from '../agent/entry.ts';
import type { LiveHub } from '../agent/liveHub.ts';
import { touchRow } from '../db/notify.ts';
import { INTENT_MAX } from '../live/intents.ts';
import { addUnread, noteUnread, NOTIFY_TARGETS } from '../live/unread.ts';
import { sanitizeInput } from '../mcp/screenTools.ts';
import { noteTurnStart } from '../mcp/waitTool.ts';
import { PeerLaunchInbox, type PeerAccount } from '../peer/launchInbox.ts';
import { PeerOutbox } from '../peer/outbox.ts';
import { aliveRunForSession } from '../runs/queries.ts';
import type { RunManager } from '../runs/manager.ts';
import type { SyncEngine } from '../sync/engine.ts';
import type { HomeParts } from './home.ts';
import type { RunsParts } from './runs.ts';
import type { SyncParts } from './sync.ts';

/** 答えを送れなかった頼みを送り直す見回りの間隔。 */
export const PEER_RESEND_MS = 30_000;

export type PeerParts = {
  start(): void;
  stop(): void;
  /** 呼び鈴に鳴った、答えと結果の知らせ。呼ぶ側の取得（PeerOutbox）をすぐ回す。boot/mobile.ts の onPeer へ渡す。 */
  onBell(kind: PeerBellKind, id: string): void;
};

/**
 * 別の PC からの起動の頼みを受ける持ち場（peer/launchInbox.ts）を組む。
 * 頼みは同期の engine の pull（peerLaunches）で届く。呼び鈴の知らせも pull を前倒しするだけである（boot/mobile.ts）。
 * 同期を設定していない、または Worker の版が足りないあいだは何もしない（canCarryPeer）。
 * 呼ぶ側（peer/outbox.ts の PeerOutbox）もここで組む。別の PC へ頼んだ答えと結果を取り、呼び出し元の会話へ入力として送り込む。
 * 取得は 30 秒ごとと、呼び鈴の answer と result で回り、実行中の一覧が変わるたびに預かりを渡し直す。
 * 組み立てた受け口は inbox() で引ける。SSH の /peer の入口は、同じ受け口の receive に頼みを渡す。
 */
export function bootPeer(p: {
  home: Pick<HomeParts, 'db' | 'device' | 'settings' | 'language'>;
  runs: { runs: Pick<RunManager, 'start' | 'sendInput'>; accounts: RunsParts['accounts']; claudeBin: RunsParts['claudeBin'] };
  /** 実行中の一覧と、画面への知らせの口。呼ぶ側が使う。 */
  delivery: { live: Pick<LiveHub, 'current' | 'onChange'>; hub: { broadcast(ev: Extract<ServerEvent, { type: 'toast' }>): void } };
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
  const now = p.now ?? Date.now;

  /**
   * 封を開く鍵の束。PeerOutbox は同期の口で鍵を求めるが、同期の ring は Promise なので、読めた最後のものを持つ。
   * 呼ぶ前に refreshRing で読み直す。同期が無い、または読めなければ null。
   */
  let ringNow: PeerKeyring | null = null;
  const refreshRing = async (): Promise<void> => {
    try {
      const link = p.sync.peerLink();
      ringNow = link ? await link.ring() : null;
    } catch (e) {
      ringNow = null;
      console.error('[peer] could not read the peer keys', e instanceof Error ? e.constructor.name : typeof e);
    }
  };
  const outbox = new PeerOutbox({
    db,
    deviceId,
    api: () => (p.sync.canCarryPeer() ? p.sync.peerLink()?.api ?? null : null),
    ring: () => ringNow,
    live: () => p.delivery.live.current(),
    language: p.home.language,
    now,
    // 呼び出し元の会話は、この PC で動かしているものだけに入力できる。届けられなければ false で、預かったまま次に渡す。
    inject: async (sessionId, text) => {
      const run = aliveRunForSession(db, sessionId, deviceId);
      if (!run || run.deviceId !== deviceId) return false;
      // 貼る前に印を残す（mcp/screenTools.ts の sendToSessionTool と同じ。wait_for_session が前のターンの idle を終わりと読まないため）。
      noteTurnStart(db, sessionId, { at: now() });
      await p.runs.runs.sendInput(run.tmuxName, sanitizeInput(text), true);
      return true;
    },
    // 利用者への知らせ。会話があれば未読と通知、消えていれば OS とスマホだけ（画面の札）。出し先は ask の決まりに従う。
    notify: (sessionId, text) => {
      const rules = notifyRulesOf(p.home.settings.current);
      const clipped = [...text].slice(0, INTENT_MAX).join('');
      const sent = NOTIFY_TARGETS.filter((x) => rules[x].includes('ask') && (x !== 'unread' || sessionId !== null));
      if (sent.length === 0) return;
      if (sessionId === null) {
        if (sent.includes('os') || sent.includes('phone')) p.delivery.hub.broadcast({ type: 'toast', level: 'info', message: clipped });
        return;
      }
      let unread = 0;
      if (sent.includes('unread')) {
        unread = addUnread(db, sessionId, clipped, now());
        touchRow(db, 'sessions', sessionId);
      }
      noteUnread(sessionId, clipped, unread, sent, { kind: 'ask', immediate: true });
    },
  });
  let stopOutbox: (() => void) | null = null;
  let offLive: (() => void) | null = null;

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
      void refreshRing();
    } catch (e) {
      console.error('[peer] could not run the peer watch', e instanceof Error ? e.constructor.name : typeof e);
    }
  };

  return {
    inbox: () => ensure(),
    onBell(kind) {
      if (stopped || (kind !== 'answer' && kind !== 'result')) return;
      void refreshRing().then(() => outbox.sync()).catch(() => {});
    },
    start() {
      if (timer || stopped) return;
      tick();
      stopOutbox = outbox.start();
      // 実行中の一覧が変わったら、預かっている入力を渡し直す（止められていた呼び出し元が再開したときなど）。
      offLive = p.delivery.live.onChange(() => { void outbox.flush(); });
      void refreshRing().then(() => outbox.tick()).catch(() => {});
      timer = (p.setInterval ?? setInterval)(tick, PEER_RESEND_MS);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      stopOutbox?.();
      stopOutbox = null;
      offLive?.();
      offLive = null;
      sub?.off();
      sub = null;
    },
  };
}
