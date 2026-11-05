import type { PeerLaunchApi } from '@agent-hangar/shared';
import { sshPeerLaunchApi } from './client.ts';
import type { SshConnectFailure, SshConnectResult, SshPeerNotice, SshTunnel } from './connector.ts';
import type { PeerTokenKeys } from './token.ts';

/** 張り直しの最初の間隔。失敗するたびに 2 倍にする。 */
export const SSH_RETRY_FIRST_MS = 5_000;
/** 張り直しの間隔の上限。 */
export const SSH_RETRY_MAX_MS = 60_000;
/** つながらない状態がこの長さ続いたら、利用者に知らせて張り直しを止める。 */
export const SSH_GIVE_UP_MS = 15 * 60_000;

/** トンネルを張れなかった。reason は頼みの断りの理由にそのまま使える（ssh-host-key-mismatch、ssh-unreachable）。 */
export class PeerSshConnectError extends Error {
  constructor(readonly reason: SshConnectFailure, readonly detail?: string) {
    super(`ssh tunnel is not available: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'PeerSshConnectError';
  }
}

export type PeerSshLinkDeps = {
  connector: { connect(deviceId: string): Promise<SshConnectResult> };
  selfId: string;
  tokens: () => PeerTokenKeys | null;
  /** 相手の PC の名前（知らせの文に入れる）。 */
  nameOf: (deviceId: string) => string;
  /** 利用者への知らせ（張り直しを止めたとき）。 */
  notify: (n: SshPeerNotice) => void;
  now?: () => number;
  fetch?: typeof fetch;
};

type State = {
  tunnel: SshTunnel | null;
  pending: Promise<SshTunnel> | null;
  failures: number;
  firstFailAt: number;
  nextAt: number;
  last: { reason: SshConnectFailure; detail?: string } | null;
  gaveUp: boolean;
};

/**
 * 相手ごとの SSH のトンネルを 1 本ずつ持つ（D4）。
 * 呼び出し元がトンネルを張ったまま outbox と results を取り、切れたら次の取得で張り直す。
 * 張り直しは SSH_RETRY_FIRST_MS から 2 倍ずつ間隔をあけ、SSH_RETRY_MAX_MS を上限にする。
 * つながらない状態が SSH_GIVE_UP_MS 続けば、利用者に知らせて止める。止めたあとは、新しい頼み（force）だけが張り直しを試す。
 * ホスト鍵の食い違いは、自動では張り直さない（知らせはコネクタが出している）。
 * 張り直すと localPort が変わるので、口は呼ぶたびにいまのトンネルから作る。
 */
export class PeerSshLink {
  private readonly st = new Map<string, State>();
  private readonly now: () => number;
  private gaveUpListener: ((deviceId: string) => void) | null = null;

  /** 張り直しを諦めたときの聞き手（呼び出し元の会話への知らせ）。 */
  onGaveUp(cb: ((deviceId: string) => void) | null): void {
    this.gaveUpListener = cb;
  }

  constructor(private readonly d: PeerSshLinkDeps) {
    this.now = d.now ?? Date.now;
  }

  private state(id: string): State {
    let s = this.st.get(id);
    if (!s) {
      s = { tunnel: null, pending: null, failures: 0, firstFailAt: 0, nextAt: 0, last: null, gaveUp: false };
      this.st.set(id, s);
    }
    return s;
  }

  /** いま張れているトンネルがあるか。 */
  connected(deviceId: string): boolean {
    const t = this.st.get(deviceId)?.tunnel;
    return !!t && !t.closed;
  }

  /** 自動の張り直しを止めている（長く居ない、またはホスト鍵の食い違い）か。 */
  stopped(deviceId: string): boolean {
    return this.st.get(deviceId)?.gaveUp === true;
  }

  /**
   * トンネルを返す。張れていなければ張る。force は新しい頼みの送信で、間隔と中断を無視して試す。
   * 間隔の途中や中断中は、張らずに前の理由で投げる。
   */
  ensure(deviceId: string, force = false): Promise<SshTunnel> {
    const s = this.state(deviceId);
    if (s.tunnel && !s.tunnel.closed) return Promise.resolve(s.tunnel);
    if (s.pending) return s.pending;
    if (!force) {
      if (s.gaveUp) return Promise.reject(new PeerSshConnectError(s.last?.reason ?? 'ssh-unreachable', 'stopped'));
      if (this.now() < s.nextAt) return Promise.reject(new PeerSshConnectError(s.last?.reason ?? 'ssh-unreachable', 'backoff'));
    }
    if (force) { s.gaveUp = false; s.nextAt = 0; }
    const p = this.open(deviceId, s).finally(() => { s.pending = null; });
    s.pending = p;
    return p;
  }

  private async open(deviceId: string, s: State): Promise<SshTunnel> {
    const r = await this.d.connector.connect(deviceId).catch((): SshConnectResult => ({ ok: false, reason: 'ssh-unreachable', detail: 'error' }));
    if (r.ok) {
      s.tunnel = r.tunnel;
      s.failures = 0;
      s.firstFailAt = 0;
      s.nextAt = 0;
      s.last = null;
      s.gaveUp = false;
      // 切れたら、次の取得で張り直す。すぐ張れるよう、間隔は空けない。
      r.tunnel.onClose(() => { if (s.tunnel === r.tunnel) s.tunnel = null; });
      return r.tunnel;
    }
    const t = this.now();
    s.failures += 1;
    if (s.failures === 1) s.firstFailAt = t;
    s.nextAt = t + Math.min(SSH_RETRY_MAX_MS, SSH_RETRY_FIRST_MS * 2 ** (s.failures - 1));
    s.last = { reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) };
    if (r.reason === 'ssh-host-key-mismatch') {
      s.gaveUp = true;
    } else if (r.reason === 'ssh-not-registered' || r.reason === 'ssh-no-host-key') {
      s.gaveUp = true;
    } else if (!s.gaveUp && s.failures > 1 && t - s.firstFailAt >= SSH_GIVE_UP_MS) {
      s.gaveUp = true;
      try { this.d.notify({ kind: 'gave-up', deviceId, name: this.d.nameOf(deviceId) }); } catch { /* 知らせの失敗は広げない */ }
      try { this.gaveUpListener?.(deviceId); } catch { /* 聞き手の失敗は広げない */ }
    }
    throw new PeerSshConnectError(r.reason, r.detail);
  }

  /**
   * 相手ごとの PeerLaunchApi。呼ぶたびにトンネルを引く。
   * put は新しい頼みなので force で張る。outbox と results は定期の取得で、間隔と中断に従う。
   * claim、answer、postResult は SSH の経路には無い（PeerSshUnsupportedError）。
   */
  api(deviceId: string): PeerLaunchApi {
    const inner = async (force: boolean): Promise<PeerLaunchApi> => {
      const t = await this.ensure(deviceId, force);
      return sshPeerLaunchApi({ baseUrl: () => t.baseUrl, selfId: this.d.selfId, peerId: deviceId, tokens: this.d.tokens, ...(this.d.fetch ? { fetch: this.d.fetch } : {}) });
    };
    return {
      put: async (b) => (await inner(true)).put(b),
      outbox: async (since) => (await inner(false)).outbox(since),
      results: async (id, after) => (await inner(false)).results(id, after),
      claim: async (id) => (await inner(false)).claim(id),
      answer: async (id, ok, sealed) => (await inner(false)).answer(id, ok, sealed),
      postResult: async (id, body) => (await inner(false)).postResult(id, body),
    };
  }
}
