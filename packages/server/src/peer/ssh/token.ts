import { fromBase64Url, toBase64Url, utf8 } from '@agent-hangar/shared';

/**
 * SSH の予備の経路で、相手の hangar の `/peer` に見せる PC どうしの token。
 *
 * token は配らない。
 * 同期のグループの PC はどれも同じ世代鍵を持つので、そこから用途 peer-token の HMAC の鍵を導き（shared の e2e/keys.ts）、
 * 頼む PC（from）と頼まれる PC（to）と世代を HMAC に通したものを token にする。
 * 形は `hpeer1.<世代>.<base64url の 32 バイト>` で、利用者の token（16 進）とは形が違う。
 *
 * 受ける側は、自分の今の世代より古い世代の token を断る。
 * PC の解除で世代を回すと、解除された PC は新しい世代の鍵を持たないので、/peer を通れなくなる。
 * 受ける側より新しい世代は、手元に鍵があるときだけ通す（回しの途中で、頼む側が先に新しい世代へ進んだとき）。
 * from と to を HMAC に入れるので、ある PC 宛ての token を別の PC で使い回せない。
 * グループの中のどの PC が作ったかは鍵では区別できない（封と同じく、守りはグループの外に対するものである）。
 */

/** token の頭の印。形を変えるときは数字を上げる。 */
export const PEER_TOKEN_PREFIX = 'hpeer1';

/** token の鍵の引き口。サーバでは Keyring の今の世代と peerTokenKey を渡す（keyringPeerTokenKeys）。 */
export type PeerTokenKeys = {
  currentEpoch(): number;
  keyAt(epoch: number): Promise<CryptoKey | null>;
};

/** Keyring を token の鍵の引き口にする。 */
export function keyringPeerTokenKeys(ring: { current(): { epoch: number }; peerTokenKey(epoch: number): Promise<CryptoKey | null> }): PeerTokenKeys {
  return { currentEpoch: () => ring.current().epoch, keyAt: (epoch) => ring.peerTokenKey(epoch) };
}

const message = (epoch: number, from: string, to: string): Uint8Array<ArrayBuffer> => utf8.encode(JSON.stringify(['peer-token', epoch, from, to])) as Uint8Array<ArrayBuffer>;

/** 今の世代で、from から to への token を作る。鍵が無ければ null。 */
export async function issuePeerToken(keys: PeerTokenKeys, from: string, to: string): Promise<string | null> {
  const epoch = keys.currentEpoch();
  const key = await keys.keyAt(epoch);
  if (!key) return null;
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, message(epoch, from, to)));
  return `${PEER_TOKEN_PREFIX}.${epoch}.${toBase64Url(mac)}`;
}

/** token の世代。形が違えば null。 */
export function peerTokenEpoch(token: string): number | null {
  const m = /^hpeer1\.(0|[1-9]\d{0,8})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return m ? Number(m[1]) : null;
}

/**
 * from から to（自分）への token として正しいか。
 * 形が違う、今の世代より古い、手元に鍵の無い世代、HMAC が合わない、のどれでも false。
 * HMAC の比べは WebCrypto の verify で行い、比べにかかる時間から中身を漏らさない。
 */
export async function verifyPeerToken(keys: PeerTokenKeys, token: string | null | undefined, from: string, to: string): Promise<boolean> {
  if (typeof token !== 'string') return false;
  const epoch = peerTokenEpoch(token);
  if (epoch === null || epoch < keys.currentEpoch()) return false;
  const key = await keys.keyAt(epoch);
  if (!key) return false;
  const mac = fromBase64Url(token.slice(token.lastIndexOf('.') + 1));
  if (!mac || mac.length !== 32) return false;
  return globalThis.crypto.subtle.verify('HMAC', key, mac, message(epoch, from, to));
}
