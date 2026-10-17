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

  /** 手元にある世代の番号。新しい順。 */
  epochs(): number[] {
    return [...this.keys.keys()].sort((a, b) => b - a);
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

  /**
   * 世代を回す途中で作った世代鍵を足す（sync/rotate.ts）。今の世代は進めない。
   * 残りの PC に keybox を配り終えるまで、その世代で書くと他の PC が開けない行が残るからである。
   * 同じ世代に同じ値なら何もせず、別の値では差し替えずに投げる。
   */
  async addPending(epoch: number, key: string): Promise<void> {
    const have = this.raw.get(epoch);
    if (have !== undefined) {
      if (have !== key) throw new Error(`epoch ${epoch} already has a different key`);
      return;
    }
    this.keys.set(epoch, await deriveEpochKeys(epoch, key));
    this.raw.set(epoch, key);
  }

  /** 書くときの世代を切り替える。手元に鍵の無い世代には切り替えない。 */
  useEpoch(epoch: number): void {
    if (!this.keys.has(epoch)) throw new Error(`no key for epoch ${epoch}`);
    this.cur = epoch;
  }

  /**
   * 世代鍵を手放す。世代を回す途中で、同じ番号の世代を他の PC が先に配っていたときに、まだ配っていない自分の鍵を捨てるのに使う。
   * 今の世代は手放さない（それで封じた行とファイルがあるため）。
   */
  dropEpoch(epoch: number): void {
    if (epoch === this.cur) throw new Error('the current epoch key cannot be dropped');
    this.keys.delete(epoch);
    this.raw.delete(epoch);
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
