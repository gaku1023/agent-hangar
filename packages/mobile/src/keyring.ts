/**
 * スマホ用の鍵 M（世代つき）を keybox から受け取る。
 *
 * QR を表示した PC は、スマホの接続を見て M[m] をスマホの公開鍵に封じ、`PUT /phone-keyboxes` で置く。
 * スマホは `GET /m/keybox` で自分宛てのいちばん新しい世代を読み、自分の秘密鍵で開いて、取り出せない AES-GCM の鍵として IndexedDB に置く。
 * PC がスマホを解除すると M は次の世代になる。受信箱の素の世代が手元より新しくなったら、読み直す（inbox.ts の readInbox）。
 */

import type { KeyboxOut } from '@agent-hangar/shared/src/cloud.ts';
import { openPhoneKeybox } from '@agent-hangar/shared/src/e2e/phone.ts';
import { importMobileKey, MobilePairingError } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { JoinError, mobileHeaders, originOf, unpairedOf, UnpairedError } from './api.ts';
import { loadPhoneKeys, savePhoneKey, type Keyring, type Pairing, type PhonePair } from './store.ts';

/** 接続の後に keybox を読む間隔。 */
export const KEYBOX_POLL_MS = 2000;
/** 接続の後に keybox を待つ長さ。 */
export const KEYBOX_GIVE_UP_MS = 60_000;

type Got = { kind: 'box'; box: KeyboxOut } | { kind: 'none' } | { kind: 'retry' };

/** `GET /m/keybox` を 1 回読む。401 は UnpairedError を投げる。置かれていない（404）なら none、通信の失敗と 5xx は retry。 */
async function fetchKeybox(p: Pairing): Promise<Got> {
  let res: Response;
  try {
    res = await fetch(`${originOf(p.url)}/m/keybox`, { headers: mobileHeaders(p), cache: 'no-store' });
  } catch (e) {
    if (e instanceof MobilePairingError) throw new UnpairedError();
    return { kind: 'retry' };
  }
  if (res.status === 401) throw await unpairedOf(res);
  if (res.status === 404) return { kind: 'none' };
  if (!res.ok) return { kind: 'retry' };
  try {
    const v = (await res.json()) as Partial<KeyboxOut> | null;
    if (!v || !Number.isSafeInteger(v.epoch) || (v.epoch as number) < 1 || typeof v.sealed !== 'string') return { kind: 'retry' };
    return { kind: 'box', box: { epoch: v.epoch as number, sealed: v.sealed } };
  } catch {
    return { kind: 'retry' };
  }
}

/** keybox を開いて M を手元に置き、置いた後の手元の鍵を返す。開けなければ null。 */
async function keep(p: Pairing, pair: PhonePair, box: KeyboxOut): Promise<Keyring | null> {
  let raw: Uint8Array;
  try {
    raw = await openPhoneKeybox(pair.key, pair.pub, p.deviceId, box);
  } catch {
    return null;
  }
  const key = await importMobileKey(raw, false);
  raw.fill(0);
  return savePhoneKey(box.epoch, key);
}

/**
 * keybox を 1 回読み直し、新しい世代があれば手元に足す。
 * 置かれていない、読めない、開けないときは手元の鍵のまま返す。401 は UnpairedError を投げる。
 */
export async function refreshPhoneKeys(p: Pairing, pair: PhonePair): Promise<Keyring> {
  const got = await fetchKeybox(p);
  if (got.kind === 'box') {
    const ring = await keep(p, pair, got.box).catch(() => null);
    if (ring) return ring;
  }
  return loadPhoneKeys();
}

/**
 * 接続の後、QR を表示した PC が keybox を置くまで待つ。
 * KEYBOX_POLL_MS ごとに読み、KEYBOX_GIVE_UP_MS を過ぎたら JoinError（keybox）を投げる。
 * 通信の失敗、5xx、開けない keybox は待ち続ける。401 は UnpairedError を投げる。
 * sleep と now は試験で差し替える。
 */
export async function waitPhoneKeys(
  p: Pairing,
  pair: PhonePair,
  o: { everyMs?: number; giveUpMs?: number; signal?: AbortSignal; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Keyring> {
  const every = o.everyMs ?? KEYBOX_POLL_MS;
  const giveUp = o.giveUpMs ?? KEYBOX_GIVE_UP_MS;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();
  for (;;) {
    if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const got = await fetchKeybox(p);
    if (got.kind === 'box') {
      const ring = await keep(p, pair, got.box).catch(() => null);
      if (ring) return ring;
    }
    if (now() - start + every > giveUp) throw new JoinError('keybox');
    await sleep(every);
  }
}
