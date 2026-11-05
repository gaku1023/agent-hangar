import { readPeerStatuses } from '../config/deviceStatus.ts';
import { translatorOf } from '../i18n/message.ts';
import type { GetLanguage } from '../i18n/language.ts';
import type { Db } from '../db/open.ts';
import type { PeerEndpointDeps, PeerInbox } from '../peer/endpoint.ts';
import { sshPeerProbe } from '../peer/ssh/client.ts';
import { sshBinaries } from '../peer/ssh/command.ts';
import { PeerSshStore } from '../peer/ssh/config.ts';
import { SshPeerConnector, freeLocalPort, nodeSshRun, nodeSshSpawn, type SshPeerNotice } from '../peer/ssh/connector.ts';
import { SshPeerInbox } from '../peer/ssh/inbox.ts';
import { PeerSshLink } from '../peer/ssh/link.ts';
import type { PeerTokenKeys } from '../peer/ssh/token.ts';

/** SSH の予備の経路の部品。 */
export type PeerSshParts = {
  /** 設定「ほかの PC」の登録。 */
  store: PeerSshStore;
  /** トンネルを張る口。 */
  connector: SshPeerConnector;
  /** 相手ごとのトンネルと、その上の PeerLaunchApi（呼ぶ側。張り直しと間隔と中断を持つ）。 */
  link: PeerSshLink;
  /** 受ける側の置き場。/peer の PeerInbox で、手元の PeerLaunchApi（local.api）も持つ。 */
  local: SshPeerInbox;
  /** token の鍵。同期を設定していなければ null。 */
  tokens: () => PeerTokenKeys | null;
  /** `/peer` の入口の依存（app.ts が載せる）。 */
  endpoint: PeerEndpointDeps;
  /** 受ける側の受け口（T4）を差し込む。差し込むまで `/peer` の頼みの口は 503 を返す。 */
  bindInbox(inbox: PeerInbox): void;
  /** 張ったトンネルを全部閉じる（終了のとき）。 */
  stop(): void;
};

/** 知らせを画面の toast の文にする。 */
export function peerSshNoticeText(language: GetLanguage, n: SshPeerNotice): string {
  const tr = translatorOf(language);
  if (n.kind === 'host-key-mismatch') return tr('sync.peerSsh.hostKeyMismatch', { name: n.name });
  return tr(n.kind === 'gave-up' ? 'sync.peerSsh.gaveUp' : 'sync.peerSsh.tunnelClosed', { name: n.name });
}

/**
 * SSH の予備の経路を組む。
 * 登録は hangar のデータの置き場の peer-ssh.json、専用の known_hosts は peer-ssh/ の下に置く。
 * ホスト鍵の食い違いと切れは、画面の toast で利用者に知らせる。
 */
export function bootPeerSsh(o: {
  home: string;
  db: Db;
  deviceId: string;
  language: GetLanguage;
  tokens: () => PeerTokenKeys | null;
  broadcast(ev: { type: 'toast'; level: 'info' | 'error'; message: string }): void;
  now?: () => number;
}): PeerSshParts {
  const store = new PeerSshStore(o.home);
  let inbox: PeerInbox | null = null;
  const notify = (n: SshPeerNotice): void => { o.broadcast({ type: 'toast', level: 'error', message: peerSshNoticeText(o.language, n) }); };
  const connector = new SshPeerConnector({
    home: o.home,
    platform: process.platform,
    binaries: sshBinaries(process.platform, process.env),
    store,
    peers: () => readPeerStatuses(o.db, o.deviceId),
    run: nodeSshRun,
    spawn: nodeSshSpawn,
    freePort: freeLocalPort,
    probe: sshPeerProbe({ selfId: o.deviceId, tokens: o.tokens }),
    notify,
  });
  const link = new PeerSshLink({
    connector,
    selfId: o.deviceId,
    tokens: o.tokens,
    nameOf: (id) => readPeerStatuses(o.db, o.deviceId).find((p) => p.device_id === id)?.name ?? id,
    notify,
    ...(o.now ? { now: o.now } : {}),
  });
  const local = new SshPeerInbox(o.db, o.deviceId, o.now ?? Date.now);
  return {
    store,
    connector,
    link,
    local,
    tokens: o.tokens,
    endpoint: { selfId: o.deviceId, tokens: o.tokens, inbox: () => inbox },
    bindInbox: (i) => { inbox = i; },
    stop: () => { connector.closeAll(); },
  };
}
