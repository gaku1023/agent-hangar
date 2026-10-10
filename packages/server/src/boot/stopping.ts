import { CLOSE_DEADLINE_MS } from './budget.ts';

/** idle() が返るまで待つ。上限までに空になれば真、諦めたら偽を返す。 */
export function waitForIdle(job: { idle(): Promise<void> }, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    job.idle().then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * 走っている本文の上げを待ってから止める。上限までに終われば真を返す。
 * 待たずに stop すると、デバウンスのタイマーが始めた putFile が途中で切れる。
 * 上限を超えたときも必ず止める。終了が転送に引きずられる方が困る。
 */
export async function stopUploader(up: { idle(): Promise<void>; stop(): void } | null, ms: number = CLOSE_DEADLINE_MS): Promise<boolean> {
  if (!up) return true;
  const done = await waitForIdle(up, ms);
  if (!done) console.warn(`[upload] 本文の送信を ${ms} ミリ秒待ちましたが終わらないので、待たずに閉じます`);
  up.stop();
  return done;
}

/**
 * 走っている仕事が終わるのを待ってから止める。上限までに終われば真を返す。
 *
 * タイマーから始まった push は誰も約束を持たないので、待たずに stop すると途中で切れる。
 * 設定の同期（ConfigSyncService）とメタデータの同期（SyncEngine）が、どちらもこの形である。
 * 上限を超えたときも必ず止める。終了が通信に引きずられる方が困る。
 */
export async function stopAfterIdle(job: { idle(): Promise<void>; stop(): void } | null, label: string, ms: number = CLOSE_DEADLINE_MS): Promise<boolean> {
  if (!job) return true;
  const done = await waitForIdle(job, ms);
  if (!done) console.warn(`[${label}] 走っている同期を ${ms} ミリ秒待ちましたが終わらないので、待たずに閉じます`);
  job.stop();
  return done;
}

/** 要約のジョブが空になるまで待つ。上限までに空になれば真、諦めたら偽を返す。 */
export function waitForSummaryIdle(job: { idle(): Promise<void> }, ms: number = CLOSE_DEADLINE_MS): Promise<boolean> {
  return waitForIdle(job, ms);
}
