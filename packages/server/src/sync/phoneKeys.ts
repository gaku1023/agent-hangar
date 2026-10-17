import type { Keyring, PhoneKey } from './keyring.ts';
import type { RosterStore } from './roster.ts';

/**
 * スマホ用の鍵 M の引き口。受信箱の素、起動の依頼、問い合わせを封じて開く部品（mobile/）がこれを持つ。
 *
 * M は名簿の `phoneKey` にあり、PC は名簿を読むたびに Keyring と cloud.json へ写す（RosterStore）。
 * 手元に持つのはいちばん新しい世代の 1 つだけである（cloud.json の phoneKey も 1 つ）。
 */
export type PhoneKeySource = {
  /** 書くときに使う今のスマホ用の鍵。スマホをまだ接続していない（名簿に phoneKey が無い）なら null。 */
  current(): Promise<PhoneKey | null>;
  /**
   * 依頼や問い合わせが名乗る世代の鍵。
   * 手元より新しい世代なら、名簿を読み直してから探す（他の PC がスマホを解除して M を回した）。
   * 手元より古い世代と、読み直しても見つからない世代は null で、呼び手はその依頼を開かずに残す。
   */
  at(epoch: number): Promise<PhoneKey | null>;
};

/**
 * Keyring と名簿からスマホ用の鍵の引き口を作る。
 * roster が無い（名簿を読めない）ときは、手元の鍵だけを返す。
 * 名簿の読み直しは投げない（通信の失敗は null と同じに扱い、次の依頼でまた試す）。
 */
export function phoneKeysOf(keyring: Keyring | Promise<Keyring>, roster: Pick<RosterStore, 'invalidate' | 'read'> | null = null): PhoneKeySource {
  const ring = Promise.resolve(keyring);
  ring.catch(() => {});
  return {
    current: async () => (await ring).phoneKey(),
    async at(epoch) {
      const r = await ring;
      const have = r.phoneKey();
      if (have?.epoch === epoch) return have;
      if (!roster || (have && epoch < have.epoch)) return null;
      roster.invalidate();
      try {
        await roster.read();
      } catch (e) {
        console.warn('[mobile] could not re-read the roster for a phone key epoch', e instanceof Error ? e.constructor.name : typeof e);
        return null;
      }
      const now = r.phoneKey();
      return now?.epoch === epoch ? now : null;
    },
  };
}
