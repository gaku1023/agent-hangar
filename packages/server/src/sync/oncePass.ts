import type { SyncStatusDto } from '@agent-hangar/shared';
import type { Toast } from './notices.ts';
import { PausedPass } from './pausedPass.ts';

/** 一時停止のまま頼まれた 1 巡の最中に、進み（未送信の件数）を画面へ配る間隔。手元の DB を数えるだけで、外とは話さない。 */
export const PASS_TICK_MS = 1_000;

export type OncePassDeps = {
  engine: {
    syncNow(o?: { evenIfPaused?: boolean }): Promise<void>;
    status(): SyncStatusDto;
    compatBlocked(): boolean;
    limitedUntil(): number | null;
    /** 利用者が止めた印（sync_state の paused）を読む。 */
    state: { get(key: 'paused'): string | null };
  };
  puller: { pullNow(): Promise<unknown> } | null;
  configSync: { pushChanged(): Promise<unknown> } | null;
  uploader: { sweep(limit?: number): unknown; idle(): Promise<void> } | null;
  cloudUsage: { refresh(): Promise<unknown> };
  /** 本文と設定の出し入れを止めるか（sync/halt.ts の syncHalted）。1 巡の最中でも、版と上限では真になる。 */
  isPaused: () => boolean;
  /** 取り残した本文の件数。数えられない端末では null。 */
  sweepPending: () => number | null;
  /** 同期の状態を、付録を添えて画面へ配る。 */
  broadcastSync: (s: SyncStatusDto) => void;
  toast: Toast;
  tickMs?: number;
  log?: (...a: unknown[]) => void;
};

/**
 * 利用者が押した「今すぐ同期」を組む。
 * 止まっていれば 1 巡だけ通し（PausedPass）、止まっていなければ今までどおりエンジンに頼む。
 *
 * 一時停止のまま押したときの 1 巡は、メタデータの送受信、他端末の本文と設定の受け取り、設定の押し出し、取り残した本文の全部、の順に回す。
 * 本文は走査の上限（1 回 20 件）を外して上げきる。次の走査は止まっていて来ないからである。
 * 上げ直しの間隔（10 分）は外さないので、続けて押しても同じ本文を運び直さない。
 * 終わりに使用量を取り直す。止まっている間は取りに行かないので、押した分の枠がここでしか見えない。
 */
export function createOncePass(deps: OncePassDeps): { pass: PausedPass; syncNow(): Promise<void>; stopTicker(): void } {
  const { engine } = deps;
  const log = deps.log ?? console.error;
  /** 1 段ずつ失敗を畳む。繋がらない段があっても、残りの段は試す。 */
  const passStep = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    try { await work(); } catch (e) { log(`[${label}]`, e instanceof Error ? e.message : e); }
  };
  /**
   * 1 巡の最中に、進みを画面へ配るタイマー。
   * そのあいだも状態は paused のままで、エンジンは送信中や受信中を名乗らない。
   * 始まったこと（oncePass）と、減っていく未送信の件数を、ここから配る。
   */
  let passTicker: ReturnType<typeof setInterval> | null = null;
  const stopTicker = (): void => { if (passTicker) { clearInterval(passTicker); passTicker = null; } };
  const pass = new PausedPass({
    metadata: () => engine.syncNow({ evenIfPaused: true }),
    rest: async () => {
      // 版で断られた後は本文の降ろしにも行かない（1 巡の最中でも isPaused は版の止まりで真になる）。
      await passStep('files', async () => { if (!deps.isPaused()) await deps.puller?.pullNow(); });
      await passStep('config', async () => { await deps.configSync?.pushChanged(); });
      await passStep('upload', async () => { if (deps.uploader) { deps.uploader.sweep(Infinity); await deps.uploader.idle(); } });
      await passStep('usage', () => deps.cloudUsage.refresh());
    },
    done: () => {
      // 件数は 1 巡で動いているが、状態は paused のままなのでエンジンは配り直さない。ここで配る。
      // 進みを配っていたタイマーも、ここで止める。
      stopTicker();
      const status = engine.status();
      const sweepPending = deps.sweepPending();
      deps.broadcastSync(status);
      // 版で断られた 1 巡は何も同期していない。成功や残りの件数の知らせは出さず、同期の状態と同じ版の文で知らせる。
      if (engine.compatBlocked()) {
        deps.toast('error', status.error ?? 'クラウドと互換の版が合わないので、同期できませんでした');
        return;
      }
      // 上限で退いた 1 巡は、エンジンが戻る時刻を知らせてある。成功や残りの件数の知らせを重ねない。
      if (engine.limitedUntil() !== null) return;
      // 一時停止の間は状態が paused に隠れて失敗が画面に出ないので、残りの件数で伝える。
      const left = [status.pending > 0 ? `未送信 ${status.pending} 件` : null, (sweepPending ?? 0) > 0 ? `未送信の本文 ${sweepPending} 件` : null].filter((t) => t !== null);
      if (left.length > 0) deps.toast('error', `1 回だけ同期しましたが、${left.join('、')}が残りました。同期は一時停止のままです`);
      else deps.toast('info', '1 回だけ同期しました。同期は一時停止のままです');
    },
  });
  /** 利用者が押した「今すぐ同期」。止まっていれば 1 巡だけ通し、止まっていなければ今までどおり。 */
  const syncNow = (): Promise<void> => {
    // 利用者が一時停止しているかは、止めた印で見る。
    // 状態の paused は上限で退いている間にも出るので、状態では見ない。版で止まっている間は状態が error になるので、なおさら印で見る。
    const paused = engine.state.get('paused') === '1';
    if (!paused) return engine.syncNow();
    const done = pass.run();
    if (pass.active() && !passTicker) {
      // 押した直後に 1 度配る。応答が返るのはメタデータの送受信の後なので、待たせるとボタンが効いていないように見える。
      deps.broadcastSync(engine.status());
      passTicker = setInterval(() => { deps.broadcastSync(engine.status()); }, deps.tickMs ?? PASS_TICK_MS);
      passTicker.unref();
    }
    return done;
  };
  return { pass, syncNow, stopTicker };
}
