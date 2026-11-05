/**
 * SSH の予備の経路を有効にするか。
 * 今回のリリースでは止めている（作りは残す）。
 * 理由は、D3 の「どちらかが未参加のときだけ」と D5 の「同期で IP と指紋を知る」が噛み合わず、実際には選ばれないからである。
 * false のあいだは次のとおり。
 * - 経路の選び方（choosePeerRoute、peerVias）は ssh を選ばず、出さない。
 * - `/peer` と `/api/peer-ssh` を載せない。
 * - トンネルの connector、link、取得、受ける側の SshPeerInbox の結線を起こさない。ssh の子プロセスも起こさない。
 * 試験は、このモジュールを vi.mock で差し替えて有効にした状態で回す。
 */
export const PEER_SSH_ENABLED = false;

/** 有効なときだけ make を呼んで部品を組む。止めているあいだは何も起こさず null を返す。 */
export function whenPeerSshEnabled<T>(make: () => T): T | null {
  return PEER_SSH_ENABLED ? make() : null;
}
