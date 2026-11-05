import { readPeerStatuses } from '../config/deviceStatus.ts';
import { translatorOf } from '../i18n/message.ts';
import type { GetLanguage } from '../i18n/language.ts';
import type { Db } from '../db/open.ts';
import type { PeerEndpointDeps, PeerInbox } from '../peer/endpoint.ts';
import { sshPeerProbe } from '../peer/ssh/client.ts';
import { sshBinaries } from '../peer/ssh/command.ts';
import { PeerSshStore } from '../peer/ssh/config.ts';
import { SshPeerConnector, freeLocalPort, nodeSshRun, nodeSshSpawn, type SshPeerNotice } from '../peer/ssh/connector.ts';
import type { PeerTokenKeys } from '../peer/ssh/token.ts';

/** SSH の予備の経路の部品。 */
export type PeerSshParts = {
  /** 設定「ほかの PC」の登録。 */
  store: PeerSshStore;
  /** トンネルを張る口。経路の選び方と張り直し（T11）が使う。 */
  connector: SshPeerConnector;
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
  return n.kind === 'host-key-mismatch' ? tr('sync.peerSsh.hostKeyMismatch', { name: n.name }) : tr('sync.peerSsh.tunnelClosed', { name: n.name });
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
}): PeerSshParts {
  const store = new PeerSshStore(o.home);
  let inbox: PeerInbox | null = null;
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
    notify: (n) => { o.broadcast({ type: 'toast', level: 'error', message: peerSshNoticeText(o.language, n) }); },
  });
  return {
    store,
    connector,
    tokens: o.tokens,
    endpoint: { selfId: o.deviceId, tokens: o.tokens, inbox: () => inbox },
    bindInbox: (i) => { inbox = i; },
    stop: () => { connector.closeAll(); },
  };
}
