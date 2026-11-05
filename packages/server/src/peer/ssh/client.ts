import type { PeerLaunchApi, PeerLaunchStatus, PeerOutboxResponse, PeerResultsResponse } from '@agent-hangar/shared';
import { PEER_FROM_HEADER } from '../endpoint.ts';
import { issuePeerToken, type PeerTokenKeys } from './token.ts';
import type { SshProbe } from './connector.ts';

/**
 * SSH の経路の PeerLaunchApi（呼ぶ側）。
 * トンネル越しに相手の hangar の `/peer` を叩く。封はそのまま送り、そのまま受け取る。
 *
 * クラウドの経路と同じ口の束だが、SSH の経路で呼ぶ側が使うのは put、outbox、results の 3 つである。
 * claim、answer、postResult は頼まれた PC が自分の手元で行うもので、トンネルの向こうへは送らない（呼ぶと PeerSshUnsupportedError）。
 */

/** `/peer` が 2xx 以外を返した。 */
export class PeerSshHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`peer endpoint returned ${status}: ${body.slice(0, 200)}`);
    this.name = 'PeerSshHttpError';
  }
}

/** SSH の経路に無い口を呼んだ。 */
export class PeerSshUnsupportedError extends Error {
  constructor(op: string) {
    super(`${op} is not available over the SSH route`);
    this.name = 'PeerSshUnsupportedError';
  }
}

export type SshPeerClientDeps = {
  /** トンネルの手元の入口（SshTunnel.baseUrl）。張り直すと変わるので、呼ぶたびに引く。 */
  baseUrl: () => string;
  /** この PC の device_id。 */
  selfId: string;
  /** 相手の PC の device_id。 */
  peerId: string;
  tokens: () => PeerTokenKeys | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

async function headersOf(d: SshPeerClientDeps): Promise<Record<string, string>> {
  const keys = d.tokens();
  const token = keys ? await issuePeerToken(keys, d.selfId, d.peerId) : null;
  if (!token) throw new PeerSshHttpError(401, 'no peer token (cloud sync is not set up)');
  return { authorization: `Bearer ${token}`, [PEER_FROM_HEADER]: d.selfId };
}

async function call<T>(d: SshPeerClientDeps, pathname: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const f = d.fetch ?? fetch;
  const headers = await headersOf(d);
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await f(`${d.baseUrl()}/peer${pathname}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(d.timeoutMs ?? 10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new PeerSshHttpError(res.status, text);
  return JSON.parse(text) as T;
}

/** トンネル越しの PeerLaunchApi を作る。 */
export function sshPeerLaunchApi(d: SshPeerClientDeps): PeerLaunchApi {
  return {
    put: (body) => call<PeerLaunchStatus>(d, '/launches', { method: 'POST', body: { ...body, from: d.selfId } }),
    outbox: (since) => call<PeerOutboxResponse>(d, `/launches/mine?since=${Math.max(0, Math.floor(since))}`),
    results: (id, after) => call<PeerResultsResponse>(d, `/launches/${encodeURIComponent(id)}/results?after=${Math.max(0, Math.floor(after))}`),
    claim: () => Promise.reject(new PeerSshUnsupportedError('claim')),
    answer: () => Promise.reject(new PeerSshUnsupportedError('answer')),
    postResult: () => Promise.reject(new PeerSshUnsupportedError('postResult')),
  };
}

/**
 * トンネルが張れたかの確かめ（SshPeerConnector の probe）。
 * 相手の `/peer/health` が正しい token で応え、名乗る device_id が宛先と同じなら ok。
 * 応えたが断った、または別の PC だったら refused、応えなければ down。
 */
export function sshPeerProbe(o: { selfId: string; tokens: () => PeerTokenKeys | null; fetch?: typeof fetch }): SshProbe {
  return async (baseUrl, deviceId) => {
    let res: Response;
    try {
      const headers = await headersOf({ baseUrl: () => baseUrl, selfId: o.selfId, peerId: deviceId, tokens: o.tokens });
      res = await (o.fetch ?? fetch)(`${baseUrl}/peer/health`, { headers, signal: AbortSignal.timeout(2_000) });
    } catch (e) {
      return e instanceof PeerSshHttpError ? 'refused' : 'down';
    }
    if (!res.ok) return 'refused';
    const body = (await res.json().catch(() => null)) as { device?: unknown } | null;
    return body?.device === deviceId ? 'ok' : 'refused';
  };
}
