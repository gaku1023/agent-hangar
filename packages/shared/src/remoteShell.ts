/**
 * ほかの PC の会話の画面から開く SSH のシェルタブの型（docs/design.md「SSH のシェルタブ」）。
 * 手元のサーバが ssh を起こして relay に流す。つなげなかった理由は RemoteShellFailure で分け、画面の文言と診断の入口になる。
 */

/** 相手の PC のシェルの種類。引用の仕方を決める（cmd は powershell -NoProfile -Command で包んで動かす）。 */
export type RemoteShellKind = 'posix' | 'powershell' | 'pwsh' | 'cmd';

/** 相手の PC の端末の多重化（tmux または psmux）。無ければ null。 */
export type RemoteMux = { kind: 'tmux' | 'psmux'; path: string };

/** devices.status の ssh の欄。 */
export type DeviceSshStatus = { user: string; host_pubkey: string | null; mux: RemoteMux | null; shell: RemoteShellKind };

/** つなげなかった理由。detail は ssh の stderr の最後の 1 行。 */
export type RemoteShellFailure = 'no-sshd' | 'unreachable' | 'auth' | 'host-key' | 'no-mux' | 'no-client' | 'outdated' | 'dropped' | 'bad-cwd';

export const REMOTE_SHELL_FAILURES: readonly RemoteShellFailure[] = ['no-sshd', 'unreachable', 'auth', 'host-key', 'no-mux', 'no-client', 'outdated', 'dropped', 'bad-cwd'];

/** 手元だけの表 remote_tabs の行。同期しない。 */
export type RemoteTabDto = { id: string; sessionId: string; deviceId: string; title: string; createdAt: number };

/** WS /ws/pty?tab= の、サーバから画面への札。 */
export type RemoteShellStatusMsg = {
  t: 'remote';
  phase: 'connecting' | 'ready' | 'retrying' | 'failed';
  attempt?: number;
  retryAt?: number;
  reason?: RemoteShellFailure;
  address?: string;
  detail?: string;
};

/** 画面からサーバへの札。failed のあと、つなぎ直しを求める。 */
export type RemoteShellClientMsg = { t: 'retry' };
