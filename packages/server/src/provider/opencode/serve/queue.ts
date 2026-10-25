import { ServeStartError } from './spawn.ts';

/**
 * serve の起動の待ち行列。
 *
 * opencode 2.1.4 の serve は、同時に起こすと起動の途中で `SQLiteError: database is locked` を出して落ちる
 * （5 本を同時に起こして 4 本が落ちた。1 本ずつ、前の 1 本の応答を待ってから起こせば 5 本とも約 1 秒で立った）。
 * そこで起動を 1 本ずつ並べる。1 つの仕事は「起こして、認証つきの GET が 200 を返すまで待つ」までで、それが済むまで次を始めない。
 * 起動の後の同時の読み書きは、30 往復でロックの失敗が 0 件だったので並べない。
 */
export class LaunchQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** job を前の仕事が終わってから走らせる。前の仕事の成否は問わない。 */
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** ロックで落ちたときの起こし直しの間（ミリ秒）。数がそのまま起こし直しの回数（3 回）になる。 */
export const LOCK_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000];

/**
 * `database is locked` で落ちたら、間をあけて起こし直す。
 * hangar の中は待ち行列で並べてあるので、ここに来るのは、利用者がふだん使う opencode が同じ時に起きた場合である。
 * ほかの理由の失敗は起こし直さずにそのまま投げる。
 */
export async function retryOnLock<T>(
  job: () => Promise<T>,
  o: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const delays = o.delaysMs ?? LOCK_RETRY_DELAYS_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await job();
    } catch (e) {
      const delay = delays[attempt];
      if (!(e instanceof ServeStartError) || e.reason !== 'locked' || delay === undefined) throw e;
      await sleep(delay);
    }
  }
}
