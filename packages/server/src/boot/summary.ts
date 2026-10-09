import type { SummaryApi } from '../http/deps.ts';
import { runAnnouncer } from '../runs/announce.ts';
import { SummaryJob } from '../summary/job.ts';
import { RUN_ENDED_SUMMARY_OPTS, SummarizerSet } from '../summary/summarizers.ts';
import { flushOnRunEnded } from '../sync/flushOnRunEnd.ts';
import type { DeliveryParts } from './delivery.ts';
import type { HomeParts } from './home.ts';
import type { RunsParts } from './runs.ts';
import { waitForSummaryIdle } from './stopping.ts';
import type { SyncParts } from './sync.ts';

export type SummaryParts = {
  /** SummaryJob のうち HTTP が触る部分。 */
  api: SummaryApi;
  /** Claude の要約器を作り直す。claude の場所か 1 時間の上限が変わったときに呼ぶ。 */
  rebuildClaude(): void;
  /**
   * 走っている要約を待つ。要約は DB に書き込むので、閉じた DB に触れさせないよう、DB を閉じる前に呼ぶ。
   * 新しい受け付けは HTTP も run の終了も止まった後なので、待ち行列はもう増えない。
   */
  stop(ms: number): Promise<void>;
};

/**
 * 要約の job と、run の出来事の受け手を組む。
 * run の出来事は画面へ配り、終わった run は事後要約の契機にし、そのセッションの本文を待たずに上げる。
 * 受け手は足した順に呼ばれる。アカウントの配り（boot/runs.ts）、ここの配りと要約、本文の上げ、の順である。
 */
export function bootSummary(
  home: Pick<HomeParts, 'db' | 'device' | 'settings'>,
  delivery: Pick<DeliveryParts, 'hub' | 'registry' | 'compatLog'>,
  runs: Pick<RunsParts, 'runs' | 'usage' | 'claudeBin'>,
  sync: Pick<SyncParts, 'uploader'>,
): SummaryParts {
  const { db } = home;
  const summarizers = new SummarizerSet({ settings: () => home.settings.current, claudeBin: runs.claudeBin, usage: () => runs.usage.current(), compat: delivery.compatLog });
  const summary = new SummaryJob({ db, deviceId: home.device.id, summarizers: summarizers.list, live: () => delivery.registry.current(), hub: delivery.hub });
  runs.runs.on(runAnnouncer({ db, hub: delivery.hub, onEnded: (run) => { summary.enqueue(run.sessionId, RUN_ENDED_SUMMARY_OPTS); } }));
  // RunManager.on は listener を足せるので、上の登録はそのまま残して 2 つ目として足す。
  runs.runs.on({ runEnded: flushOnRunEnded({ db, uploader: sync.uploader }) });
  return {
    api: {
      enqueue: (id, opts) => summary.enqueue(id, opts),
      pending: () => summary.pending(),
      test: () => summary.test(),
      listModels: summarizers.listModels,
    },
    rebuildClaude: () => summarizers.rebuildClaude(),
    async stop(ms) {
      if (!(await waitForSummaryIdle(summary, ms))) {
        console.warn(`[summary] 要約の終了を ${ms} ミリ秒待ちましたが終わらないので、待たずに閉じます`);
      }
    },
  };
}
