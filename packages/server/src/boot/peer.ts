import { notifyRulesOf, sealPeerLaunch, type AgentKind, type PeerBellKind, type PeerKeyring, type PeerLaunchApi, type PeerLaunchIncoming, type ServerEvent } from '@agent-hangar/shared';
import { AGENT_ENTRY } from '../agent/entry.ts';
import type { LiveHub } from '../agent/liveHub.ts';
import { getSession } from '../db/queries.ts';
import { touchRow } from '../db/notify.ts';
import { INTENT_MAX } from '../live/intents.ts';
import { addUnread, noteUnread, NOTIFY_TARGETS } from '../live/unread.ts';
import { MAX_SEND_CHARS, sanitizeInput } from '../mcp/screenTools.ts';
import { lastReply, noteTurnStart } from '../mcp/waitTool.ts';
import { msg, render } from '../i18n/message.ts';
import { PeerApprovals } from '../peer/approvals.ts';
import { choosePeerRoute, resolvePeer } from '../peer/caller.ts';
import { PeerLaunchInbox, type PeerAccount } from '../peer/launchInbox.ts';
import { PeerOutbox, recordPeerRequest } from '../peer/outbox.ts';
import { PeerRelay } from '../peer/relay.ts';
import { aliveRunForSession } from '../runs/queries.ts';
import type { RunManager } from '../runs/manager.ts';
import type { SyncEngine } from '../sync/engine.ts';
import type { DeliveryParts } from './delivery.ts';
import type { HomeParts } from './home.ts';
import type { RunsParts } from './runs.ts';
import type { PeerSshParts } from './peerSsh.ts';
import type { PeerLink, SyncParts } from './sync.ts';

/** 答えを送れなかった頼みを送り直す見回りの間隔。 */
export const PEER_RESEND_MS = 30_000;
/** SSH の頼みを待っているあいだ、呼び出し元がトンネル越しに答えと結果を取る間隔。呼び鈴が無いので、クラウドの 30 秒より短くする。 */
export const PEER_SSH_POLL_MS = 5_000;

export type PeerParts = {
  start(): void;
  stop(): void;
  /** 呼び鈴に鳴った、答えと結果の知らせ。呼ぶ側の取得（PeerOutbox）をすぐ回す。boot/mobile.ts の onPeer へ渡す。 */
  onBell(kind: PeerBellKind, id: string): void;
  /** 別の PC への起動の承認待ち（D8）。MCP の呼び出し（peerCall.requestApproval）が預け、画面の HTTP とスマホの問い合わせが答える。 */
  approvals: PeerApprovals;
};

/**
 * 別の PC からの起動の頼みを受ける持ち場（peer/launchInbox.ts）を組む。
 * 頼みは同期の engine の pull（peerLaunches）で届く。呼び鈴の知らせも pull を前倒しするだけである（boot/mobile.ts）。
 * 同期を設定していない、または Worker の版が足りないあいだは何もしない（canCarryPeer）。
 * 呼ぶ側（peer/outbox.ts の PeerOutbox）もここで組む。別の PC へ頼んだ答えと結果を取り、呼び出し元の会話へ入力として送り込む。
 * 取得は 30 秒ごとと、呼び鈴の answer と result で回り、実行中の一覧が変わるたびに預かりを渡し直す。
 * 組み立てた受け口は inbox() で引ける。SSH の /peer の入口は、同じ受け口の receive に頼みを渡す。
 * 起こした会話のターンの止まりは、結果の見張り（peer/relay.ts）が呼び出し元へ書く。登録の変化（live）と run の終わりを聞き、返す。
 * send と stop の頼み（D16）は、受け口が結び付きを確かめたうえで、この組みの入力の口と run の停止に渡す。
 */
export function bootPeer(p: {
  home: Pick<HomeParts, 'db' | 'device' | 'settings' | 'language'>;
  runs: { runs: Pick<RunManager, 'start' | 'sendInput' | 'kill' | 'on'>; accounts: RunsParts['accounts']; claudeBin: RunsParts['claudeBin'] };
  /** 実行中の一覧と、画面への知らせの口。呼ぶ側が使う。 */
  delivery: { live: Pick<LiveHub, 'current' | 'onChange'>; hub: { broadcast(ev: Extract<ServerEvent, { type: 'toast' }>): void } };
  sync: Pick<SyncParts, 'engine' | 'peerLink' | 'canCarryPeer'>;
  /** SSH の予備の経路（boot/peerSsh.ts）。渡せば、SSH で来た頼みを受け、SSH で頼んだ答えと結果を取る。 */
  ssh?: Pick<PeerSshParts, 'local' | 'link' | 'bindInbox'>;
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
  let sshTimer: ReturnType<typeof setInterval> | null = null;
  let sshCur: { link: PeerLink; inbox: PeerLaunchInbox } | null = null;
  let stopped = false;
  const now = p.now ?? Date.now;
  const cloudPost: PeerLaunchApi['postResult'] = (id, body) => {
    const l = p.sync.peerLink();
    return l ? l.api.postResult(id, body) : Promise.reject(new Error('peer link is not ready'));
  };
  const relay = new PeerRelay({
    db, deviceId, now,
    live: () => p.delivery.live.current(),
    ring: async () => { const l = p.sync.peerLink(); if (!l) throw new Error('peer link is not ready'); return l.ring(); },
    // 結果は頼みが来た経路で書く。SSH で来た頼みは手元の口へ書き、相手が /peer の results で取りに来る。
    api: () => (p.ssh ? { postResult: (id, body) => (p.ssh!.local.has(id) ? p.ssh!.local.api.postResult(id, body) : cloudPost(id, body)) } : p.sync.peerLink()?.api ?? null),
    canProcess: () => !stopped && (p.sync.canCarryPeer() || p.ssh !== undefined),
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
  let offRelayLive: (() => void) | null = null;
  let offRuns: (() => void) | null = null;

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
  /** 利用者への知らせ。会話があれば未読と通知、消えていれば起こした会話を軸に OS とスマホだけ（D14）。出し先は ask の決まりに従う。 */
  const notify = (sessionId: string | null, text: string, anchor?: string | null): void => {
    const rules = notifyRulesOf(p.home.settings.current);
    const clipped = [...text].slice(0, INTENT_MAX).join('');
    const sent = NOTIFY_TARGETS.filter((x) => rules[x].includes('ask') && (x !== 'unread' || sessionId !== null));
    if (sent.length === 0) return;
    if (sessionId === null) {
      const out = sent.filter((x) => x !== 'unread');
      if (out.length === 0) return;
      // 消えた会話には未読を積めないので、起こした会話を軸に OS とスマホの通知を出す（押すと、その報告元の会話が開く）。軸が無いときだけ画面の札に落とす。
      if (anchor) noteUnread(anchor, clipped, 0, out, { kind: 'ask', immediate: true });
      else p.delivery.hub.broadcast({ type: 'toast', level: 'info', message: clipped });
      return;
    }
    let unread = 0;
    if (sent.includes('unread')) {
      unread = addUnread(db, sessionId, clipped, now());
      touchRow(db, 'sessions', sessionId);
    }
    noteUnread(sessionId, clipped, unread, sent, { kind: 'ask', immediate: true });
  };
  const outbox = new PeerOutbox({
    db,
    deviceId,
    api: () => (p.sync.canCarryPeer() ? p.sync.peerLink()?.api ?? null : null),
    // SSH の頼みは相手ごとの口で取る。口はトンネルを持ち、切れていれば張り直す。
    ...(p.ssh ? { sshApi: (id: string) => p.ssh!.link.api(id) } : {}),
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
    notify,
  });
  const callDeps = { link: () => (p.sync.canCarryPeer() ? p.sync.peerLink() : null), workerOk: () => p.sync.canCarryPeer() };
  // 別の PC への起動の承認待ち（D8）。承認されたら経路を決めて封じて置き、断りと時間切れは呼び出し元に入力として入れる。
  const approvals = new PeerApprovals({
    db, now,
    send: async (row) => {
      const peer = resolvePeer(db, deviceId, row.to);
      if (!peer) throw new Error('device-unknown');
      const route = choosePeerRoute(peer, callDeps, now());
      if ('refuse' in route) throw new Error(route.refuse);
      const sealed = await sealPeerLaunch(await route.ring(), { requestId: row.requestId, from: deviceId, to: row.to }, { ...row.request, createdAt: now() });
      await route.api.put({ id: row.requestId, to: row.to, sealed, from: deviceId });
      recordPeerRequest(db, { requestId: row.requestId, to: row.to, callerSessionId: row.callerSessionId, now: now() });
    },
    refuse: (o) => { void outbox.refuseLocal(o); },
    // 承認待ちは答えがないと進まないので、会話の状態によらず、ask の決まりの出し先へ出す。
    notify: (o) => {
      const text = render(p.home.language(), o.from ? msg('mcp.peer.notice.approval', { from: o.from.slice(0, 80), device: o.device.slice(0, 80) }) : msg('mcp.peer.notice.approvalNoFrom', { device: o.device.slice(0, 80) }));
      notify(o.callerSessionId, text);
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

  /** 受け口を組む。クラウドの経路と SSH の経路で、api と canProcess だけが違う。 */
  const makeInbox = (api: PeerLaunchApi, link: PeerLink, canProcess: () => boolean): PeerLaunchInbox => new PeerLaunchInbox({
    db, api, ring: link.ring, reread: link.reread, deviceId,
    start: (params) => p.runs.runs.start(params),
    hasProjectHere: (id) => !!placeHere.get(id, deviceId),
    accountByName: byName,
    hasAgent: agentUsable,
    canProcess,
    now,
    onStarted: (e) => relay.onStarted(e),
    control,
  });

  /** 今の同期の口に合う受け口を返す。口が変わっていたら組み直す。 */
  const ensure = (): PeerLaunchInbox | null => {
    if (stopped) return null;
    const link = p.sync.peerLink();
    if (!link) { cur = null; return null; }
    if (cur && cur.link.api === link.api && cur.link.ring === link.ring) return cur.inbox;
    const inbox = makeInbox(link.api, link, () => !stopped && p.sync.canCarryPeer());
    cur = { link, inbox };
    return inbox;
  };

  /**
   * SSH で来た頼みの受け口。claim・answer・結果は手元の口（ssh.local.api）で済ませ、トンネルの向こうへは送らない。
   * 封の鍵は同期の口から引く（クラウドの Worker の版が古くても、参加していれば鍵はある）。鍵が無ければ組めず、頼みは受け取られないまま期限で切れる。
   */
  const ensureSsh = (): PeerLaunchInbox | null => {
    if (stopped || !p.ssh) return null;
    const link = p.sync.peerLink();
    if (!link) { sshCur = null; return null; }
    if (sshCur && sshCur.link.ring === link.ring) return sshCur.inbox;
    const inbox = makeInbox(p.ssh.local.api, link, () => !stopped);
    sshCur = { link, inbox };
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
      void refreshRing();
    } catch (e) {
      console.error('[peer] could not run the peer watch', e instanceof Error ? e.constructor.name : typeof e);
    }
  };

  return {
    inbox: () => ensure(),
    relay,
    approvals,
    onBell(kind) {
      if (stopped || (kind !== 'answer' && kind !== 'result')) return;
      void refreshRing().then(() => outbox.sync()).catch(() => {});
    },
    start() {
      if (timer || stopped) return;
      offRelayLive = p.delivery.live.onChange(() => relay.check());
      offRuns = p.runs.runs.on({ runEnded: (run) => relay.onProcessEnded(run.sessionId) });
      tick();
      approvals.start();
      stopOutbox = outbox.start();
      // 実行中の一覧が変わったら、預かっている入力を渡し直す（止められていた呼び出し元が再開したときなど）。
      offLive = p.delivery.live.onChange(() => { void outbox.flush(); });
      void refreshRing().then(() => outbox.tick()).catch(() => {});
      timer = (p.setInterval ?? setInterval)(tick, PEER_RESEND_MS);
      timer.unref?.();
      if (p.ssh) {
        // SSH で頼みが来たら、その場で処理する（呼び鈴が無い）。差し込むまで /peer の頼みの口は 503 を返す。
        p.ssh.local.onReceive((l) => { void ensureSsh()?.receive([l]).catch((e: unknown) => console.error('[peer] could not handle the SSH launch request', e instanceof Error ? e.constructor.name : typeof e)); });
        p.ssh.bindInbox(p.ssh.local);
        // 張り直しを諦めたら、答えか結果を待っていた頼みの呼び出し元に 1 度だけ知らせる。
        p.ssh.link.onGaveUp((id) => { void outbox.noteSshGaveUp(id); });
        // SSH で頼んだ答えと結果を、トンネルを張ったまま短い間隔で取る。待つ頼みが無ければ何もしない（トンネルも張らない）。
        sshTimer = (p.setInterval ?? setInterval)(() => { if (outbox.hasSshWork()) void outbox.syncSsh(); }, PEER_SSH_POLL_MS);
        sshTimer.unref?.();
      }
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (sshTimer) clearInterval(sshTimer);
      sshTimer = null;
      p.ssh?.local.onReceive(null);
      p.ssh?.link.onGaveUp(null);
      approvals.stop();
      stopOutbox?.();
      stopOutbox = null;
      offLive?.();
      offLive = null;
      sub?.off();
      sub = null;
      offRelayLive?.();
      offRelayLive = null;
      offRuns?.();
    },
  };
}
