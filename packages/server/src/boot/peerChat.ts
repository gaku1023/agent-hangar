import path from 'node:path';
import { PRIMARY_ACCOUNT_ID, peerChatAcceptOf, phoneChatAcceptOf, type PeerChatBellAsk, type PeerChatBellReply, type SessionDto } from '@agent-hangar/shared';
import type { LiveHub } from '../agent/liveHub.ts';
import { onRowChange } from '../db/notify.ts';
import { accountOfSession, getSession } from '../db/queries.ts';
import { listFilesIn } from '../mobile/asks.ts';
import { listPromptCommands } from '../provider/claude-code/prompt/commands.ts';
import { sanitizeInput } from '../mcp/screenTools.ts';
import { noteTurnStart } from '../mcp/waitTool.ts';
import { createPeerChatHost, type PeerChatHost } from '../peer/chat/host.ts';
import type { HostPane, HostSession, PeerChatHostDeps, PeerChatHostEvent } from '../peer/chat/hostTypes.ts';
import { createTailCache, dbTranscriptReader } from '../peer/chat/tail.ts';
import { turnEventsReader } from '../peer/chat/turnEvents.ts';
import type { LiveDigester } from '../live/digest.ts';
import { aliveRunForSession } from '../runs/queries.ts';
import type { RunManager } from '../runs/manager.ts';
import type { Db } from '../db/open.ts';
import type { HomeParts } from './home.ts';
import { panesOf, type RunsParts } from './runs.ts';
import type { SyncParts } from './sync.ts';

/**
 * 会話の素性を覚えておく長さ。
 * 長いポーリングが 1 秒ごとに調べ直すので、毎回 DB の組み立てをしない。
 */
const SESSION_MEMO_MS = 1500;

export type PeerChatParts = {
  /** 呼び鈴の chat の枠に答える（boot/mobile.ts の onChat へ渡す）。 */
  handle(frame: PeerChatBellAsk): Promise<PeerChatBellReply | null>;
  /**
   * 実行中の一覧と行の変化を聞き始める。
   * ターンが変わったら預かりを確かめ、会話が消えたら預かりを捨てる。
   */
  start(): void;
  stop(): void;
  /** 試験と確認のために、中の host を返す。 */
  host: PeerChatHost;
};

/**
 * ほかの PC の会話の頼み（PeerChatHost、peer/chat/host.ts）を、この PC の DB、画面、run、同期の口につなぐ。
 * 呼び鈴（boot/mobile.ts）が chat の枠を渡し、答えを返す。
 * 頼みを受けてよいか（ほかの PC は設定 peerChatAcceptFromPeers、スマホは設定 phoneChatAccept）は、頼みのたびに設定を読み直す。
 * 預かりと答えた記録はメモリだけに持つ（再起動では残さない）。
 */
export function bootPeerChat(p: {
  home: Pick<HomeParts, 'db' | 'device' | 'settings' | 'home' | 'language'>;
  runs: { runs: Pick<RunManager, 'sendInput' | 'resumeWith' | 'switchAccount'>; mux: RunsParts['mux']; accounts?: Pick<RunsParts['accounts'], 'store' | 'auth'> };
  delivery: { live: Pick<LiveHub, 'current' | 'onChange'>; /** 現在の札の材料（サブエージェントと意図）。無ければ別の PC の画面は右の欄を出さない。 */ digester?: Pick<LiveDigester, 'digest'>; hub: { broadcast(ev: PeerChatHostEvent): void }; hookDecisions?: PeerChatHostDeps['hookDecisions'] };
  sync: Pick<SyncParts, 'peerLink'>;
  now?: () => number;
}): PeerChatParts {
  const { db } = p.home;
  const deviceId = p.home.device.id;
  const now = p.now ?? Date.now;
  const memo = new Map<string, { at: number; s: SessionDto | null }>();
  const sessionOf = (sessionId: string): SessionDto | null => {
    const t = now();
    const hit = memo.get(sessionId);
    if (hit && t - hit.at < SESSION_MEMO_MS) return hit.s;
    const s = getSession(db, p.delivery.live.current(), sessionId, { deviceId, now });
    memo.set(sessionId, { at: t, s });
    if (memo.size > 64) memo.delete(memo.keys().next().value!);
    return s;
  };
  const artifactCount = db.prepare('select count(distinct v.artifact_id) c from artifact_versions v join artifacts a on a.id = v.artifact_id where v.session_id = ? and v.deleted_at is null and a.deleted_at is null');
  const deviceName = db.prepare('select name from devices where id = ? and deleted_at is null');
  const link = () => p.sync.peerLink();

  const host = createPeerChatHost({
    deviceId,
    now,
    ring: async () => link()?.ring() ?? null,
    acceptFrom: (kind) => (kind === 'phone' ? phoneChatAcceptOf(p.home.settings.current) : peerChatAcceptOf(p.home.settings.current)),
    deviceName: (id) => (deviceName.get(id) as { name: string } | undefined)?.name ?? id.slice(0, 8),
    session: (sessionId): HostSession | null => {
      const s = sessionOf(sessionId);
      return s ? { provider: s.provider, live: s.live, aside: s.liveAside !== null, liveAside: s.liveAside, limit: s.limit, waitingFor: s.waitingFor, permission: s.permission, activity: s.activity, cwd: s.cwd, lock: s.lock !== null, newerElsewhere: s.newerElsewhere, remoteOnly: s.remoteOnly, takenOver: s.takenOver !== null } : null;
    },
    run: (sessionId) => {
      const run = aliveRunForSession(db, sessionId, deviceId, now());
      return run && run.deviceId === deviceId ? { tmuxName: run.tmuxName } : null;
    },
    pane: (tmuxName): HostPane | null => {
      const panes = panesOf(p.runs.mux());
      if (!panes) return null;
      return {
        capture: () => panes.capture(tmuxName),
        captureStyled: async () => (panes.captureStyled ? panes.captureStyled(tmuxName) : null),
        sendKey: (key) => panes.sendKey(tmuxName, key),
        sendText: (text) => panes.sendText(tmuxName, text),
      };
    },
    ...(p.delivery.digester ? { digest: (id: string) => p.delivery.digester!.digest(id) } : {}),
    turnEvents: turnEventsReader(db),
    artifactCount: (id) => (artifactCount.get(id) as { c: number }).c,
    liveHints: () => p.home.settings.current.liveHints !== false,
    readTranscript: dbTranscriptReader(db),
    cache: createTailCache(),
    // 貼る前に印を残す。
    // mcp/screenTools.ts の sendToSessionTool と同じで、wait_for_session が前のターンの idle を終わりと読まないためである。
    sendInput: async (sessionId, tmuxName, text) => {
      noteTurnStart(db, sessionId, { at: now() });
      await p.runs.runs.sendInput(tmuxName, sanitizeInput(text), true);
    },
    resume: (sessionId) => p.runs.runs.resumeWith(sessionId),
    ...(p.runs.accounts ? { switchAccount: switchAccountOf(p.runs.runs, p.runs.accounts) } : {}),
    ...(p.runs.accounts ? { accountName: accountNameOf(db, deviceId, (id) => sessionOf(id)?.provider ?? null, p.runs.accounts) } : {}),
    fetchBlob: (askId, from, n) => {
      const get = link()?.getBlob;
      return get ? get(askId, from, n) : Promise.reject(new Error('peer blobs are not available'));
    },
    dropsDir: path.join(p.home.home, 'drops'),
    files: (root, q) => listFilesIn(root, q),
    // 新しいセッションの欄（GET /api/prompt/commands）と同じ一覧。
    commands: (root) => listPromptCommands({ claudeDir: p.home.settings.current.claudeDir, projectPath: root, language: p.home.language() }),
    emit: (ev) => { p.delivery.hub.broadcast(ev); },
    ...(p.delivery.hookDecisions ? { hookDecisions: p.delivery.hookDecisions } : {}),
  });

  let offs: (() => void)[] = [];
  return {
    host,
    handle: (frame) => host.handle(frame),
    start() {
      if (offs.length > 0) return;
      // 実行中の一覧が変わったら、ターンの状態が変わったかもしれない。
      // 預かりが渡せるか確かめ、待っている tail を起こす。
      offs.push(p.delivery.live.onChange(() => { memo.clear(); host.turnChanged(); }));
      // 会話が消えた（ゴミ箱へ入れた）ら、その会話の預かりを捨てる。
      const gone = db.prepare('select 1 from sessions where id = ? and deleted_at is not null');
      offs.push(onRowChange((c) => {
        if (c.db !== db || (c.table !== 'sessions' && c.table !== 'runs')) return;
        memo.clear();
        if (c.table === 'sessions' && gone.get(c.rowId)) host.dropSession(c.rowId);
      }));
    },
    stop() {
      for (const off of offs.splice(0)) off();
      host.dispose();
    },
  };
}

/**
 * この PC で会話が動いているアカウントの名前（peer/chat/hostTypes.ts の accountName）。
 * 最後の run のアカウント（画面の対応と同じ accountOfSession）で、run に記録が無ければメイン。Claude でない会話は null。
 */
export function accountNameOf(db: Db, deviceId: string, provider: (sessionId: string) => string | null, accounts: Pick<RunsParts['accounts'], 'store'>): NonNullable<PeerChatHostDeps['accountName']> {
  return (sessionId) => {
    if (provider(sessionId) !== 'claude-code') return null;
    return accounts.store.get(accountOfSession(db, sessionId, deviceId) ?? PRIMARY_ACCOUNT_ID)?.name ?? null;
  };
}

/**
 * ほかの PC からの switch-account（peer/chat/hostTypes.ts の switchAccount）。
 * アカウントの ID は PC ごとに違うので、名前で引く（別の PC への起動の accountByName と同じ決め方、boot/peer.ts）。
 * 画面の切り替え（POST /api/sessions/:id/switch-account）と違い、この PC の既定のアカウントは変えない。
 */
export function switchAccountOf(runs: Pick<RunManager, 'switchAccount'>, accounts: Pick<RunsParts['accounts'], 'store' | 'auth'>): NonNullable<PeerChatHostDeps['switchAccount']> {
  return async (sessionId, name) => {
    const a = accounts.store.list().find((x) => x.name === name);
    if (!a) return 'account-unavailable';
    if (accounts.auth.get(a.id) === null) accounts.auth.ensureChecked(a);
    if (accounts.auth.get(a.id)?.loggedIn === false) return 'account-unavailable';
    try {
      await runs.switchAccount(sessionId, a.id);
      return 'ok';
    } catch (e) {
      console.error('[peer-chat] could not switch the account of a session', e instanceof Error ? e.constructor.name : typeof e);
      return 'resume-failed';
    }
  };
}
