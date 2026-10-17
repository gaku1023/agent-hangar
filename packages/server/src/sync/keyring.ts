import { deriveEpochKeys, fromBase64UrlLen, importMobileKey, type EpochKeys, type EpochList } from '@agent-hangar/shared';
import type { CloudConfig } from '../config/cloud.ts';

/** スマホ用の鍵。key は AES-256-GCM の取り出せない鍵である。 */
export type PhoneKey = { epoch: number; key: CryptoKey };

type PhoneEntry = PhoneKey & { raw: string };

/**
 * この PC が持つ鍵の束。
 * cloud.json の世代鍵から用途の鍵（row、index、fp、roster、本文）を導いて持ち、世代の番号で引けるようにする。
 * 書くときは今の世代（current）を使い、読むときは行が名乗る世代（at）を使う。
 * keybox から読んだ一覧は addEpochs で足し、toConfigPatch で cloud.json に書き戻す形を返す。
 * 鍵そのものはログにも例外のメッセージにも出さない。
 */
export class Keyring {
  private constructor(
    private readonly keys: Map<number, EpochKeys>,
    private readonly raw: Map<number, string>,
    private cur: number,
    private phone: PhoneEntry | null,
  ) {}

  static async fromConfig(c: CloudConfig): Promise<Keyring> {
    const keys = new Map<number, EpochKeys>();
    const raw = new Map<number, string>();
    for (const [n, key] of Object.entries(c.epochs)) {
      const epoch = Number(n);
      keys.set(epoch, await deriveEpochKeys(epoch, key));
      raw.set(epoch, key);
    }
    if (!keys.has(c.currentEpoch)) throw new Error('the current epoch key is missing from cloud.json');
    const ring = new Keyring(keys, raw, c.currentEpoch, null);
    await ring.setPhoneKey(c.phoneKey);
    return ring;
  }

  /** 書くときに使う、今の世代の鍵。 */
  current(): EpochKeys {
    return this.keys.get(this.cur)!;
  }

  /** その世代の鍵。手元に無い世代なら null で、呼び手は keybox を読み直す。 */
  at(epoch: number): EpochKeys | null {
    return this.keys.get(epoch) ?? null;
  }

  /**
   * keybox から読んだ世代鍵の一覧を足し、今の世代を一番新しいものへ進める。
   * keybox は署名を持たないので、手元にある世代の鍵を別の値で差し替える一覧は信じず、その世代は手元の値を残す。
   */
  async addEpochs(list: EpochList): Promise<void> {
    for (const [n, key] of Object.entries(list.epochs)) {
      const epoch = Number(n);
      if (this.raw.has(epoch)) continue;
      this.keys.set(epoch, await deriveEpochKeys(epoch, key));
      this.raw.set(epoch, key);
      if (epoch > this.cur) this.cur = epoch;
    }
  }

  /** スマホ用の鍵。スマホをまだ接続していなければ null。 */
  phoneKey(): PhoneKey | null {
    return this.phone ? { epoch: this.phone.epoch, key: this.phone.key } : null;
  }

  /** スマホ用の鍵を差し替える。null で手放す。 */
  async setPhoneKey(p: { epoch: number; key: string } | null): Promise<void> {
    if (!p) {
      this.phone = null;
      return;
    }
    const key = await importMobileKey(fromBase64UrlLen(p.key, 32, 'phone key'));
    this.phone = { epoch: p.epoch, key, raw: p.key };
  }

  /** cloud.json に書き戻す分。 */
  toConfigPatch(): Pick<CloudConfig, 'epochs' | 'currentEpoch' | 'phoneKey'> {
    const epochs: Record<string, string> = {};
    for (const n of [...this.raw.keys()].sort((a, b) => a - b)) epochs[String(n)] = this.raw.get(n)!;
    return { epochs, currentEpoch: this.cur, phoneKey: this.phone ? { epoch: this.phone.epoch, key: this.phone.raw } : null };
  }
}
