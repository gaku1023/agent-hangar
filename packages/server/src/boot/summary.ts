import { CANDIDATE_EXPIRE_DAYS, PRIMARY_ACCOUNT_ID } from '@agent-hangar/shared';
import type { SummaryApi } from '../http/deps.ts';
import { RunAccounts } from '../runs/accounts.ts';
import type { SummaryAccount } from '../provider/claude-code/summary/claude.ts';
import { runAnnouncer } from '../runs/announce.ts';
import { AUTO_DONE_POLL_MS, AutoDoneWatch, autoDoneCandidates, summaryCandidates } from '../sessions/autoDone.ts';
import { translatorOf } from '../i18n/message.ts';
import { CandidateExpiryWatch, expiryAnnounced, markExpiryAnnounced } from '../sessions/candidateExpiry.ts';
import { expireCandidates, markAutoDone } from '../sessions/states.ts';
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
  /** 止まったセッションを自動で Done にする見回りを始める。実行中の一覧と run の後始末が済んでから呼ぶ。 */
  startAutoDone(): void;
  /** 自動の Done の見回りを止める。 */
  stopAutoDone(): void;
};

/**
 * claude -p の要約を走らせるアカウント。そのセッションを最後に動かした run のアカウントで、その置き場の枠と使用率で数える。
 * 本文は置き場の間で共有なので、どの置き場で読んでも同じである。
 * run の記録が無いもの（hangar の外で起こしたもの）と、消したアカウントのものは、最初のアカウントで走らせる（RunAccounts.accountFor）。
 */
export function summaryAccountOf(accounts: Pick<RunAccounts, 'lastUsed'>): (sessionId: string) => SummaryAccount {
  return (sessionId) => {
    const a = accounts.lastUsed(sessionId);
    return a && a.id !== PRIMARY_ACCOUNT_ID ? { id: a.id, configDir: a.dir } : { id: PRIMARY_ACCOUNT_ID, configDir: null };
  };
}

/**
 * 要約の job と、run の出来事の受け手を組む。
 * run の出来事は画面へ配り、終わった run は事後要約の契機にし、そのセッションの本文を待たずに上げる。
 * 受け手は足した順に呼ばれる。アカウントの配り（boot/runs.ts）、ここの配りと要約、本文の上げ、の順である。
 */
export function bootSummary(
  home: Pick<HomeParts, 'db' | 'device' | 'settings' | 'language'>,
  delivery: Pick<DeliveryParts, 'hub' | 'sockets' | 'registry' | 'compatLog'>,
  runs: Pick<RunsParts, 'runs' | 'usage' | 'claudeBin' | 'accounts'>,
  sync: Pick<SyncParts, 'uploader'>,
): SummaryParts {
  const { db } = home;
  const accountOf = summaryAccountOf(new RunAccounts({ db, claudeDir: runs.accounts.primaryDir, store: runs.accounts.store, deviceId: home.device.id }));
  const summarizers = new SummarizerSet({ settings: () => home.settings.current, claudeBin: runs.claudeBin, usage: (accountId) => runs.usage.of(accountId), accountOf, compat: delivery.compatLog });
  const summary = new SummaryJob({ db, deviceId: home.device.id, summarizers: summarizers.list, live: () => delivery.registry.current(), hub: delivery.hub, language: home.language });
  runs.runs.on(runAnnouncer({ db, hub: delivery.hub, onEnded: (run) => { summary.enqueue(run.sessionId, RUN_ENDED_SUMMARY_OPTS); } }));
  // RunManager.on は listener を足せるので、上の登録はそのまま残して 2 つ目として足す。
  runs.runs.on({ runEnded: flushOnRunEnded({ db, uploader: sync.uploader }) });
  // 止まったセッションを自動で Done にする（sessions/autoDone.ts）。
  // 外で起こした長いものの事後要約は、このサーバが起きてから止まったものだけに回す。
  const bootedAt = Date.now();
  const liveProviderIds = () => new Set(delivery.registry.current().map((l) => l.sessionId));
  const autoDone = new AutoDoneWatch({
    candidates: () => autoDoneCandidates(db, home.device.id, { liveProviderIds: liveProviderIds(), pending: new Set(summary.pending()), now: Date.now() }),
    mark: (id) => markAutoDone(db, home.device.id, id),
    toSummarize: () => summaryCandidates(db, home.device.id, { liveProviderIds: liveProviderIds(), since: bootedAt }),
    enqueue: (id) => { summary.enqueue(id); },
    // 設定の「止まった会話を自動で Done にする」。
    enabled: () => home.settings.current.autoDone !== false,
  });
  // 放っておかれた提案の片付け（sessions/candidateExpiry.ts）。自動の Done と同じ見回りで回す。
  const tr = translatorOf(home.language);
  const expiry = new CandidateExpiryWatch({
    expire: (now) => expireCandidates(db, home.device.id, now),
    announced: () => expiryAnnounced(db),
    markAnnounced: () => markExpiryAnnounced(db),
    clients: () => delivery.sockets.clientCount(),
    announce: (n) => delivery.hub.broadcast({ type: 'toast', level: 'info', message: tr('session.status.autoConfirmed', { n, days: CANDIDATE_EXPIRE_DAYS }) }),
  });
  let autoDoneTimer: ReturnType<typeof setInterval> | null = null;
  return {
    api: {
      enqueue: (id, opts) => summary.enqueue(id, opts),
      pending: () => summary.pending(),
      test: () => summary.test(),
      listModels: summarizers.listModels,
    },
    rebuildClaude: () => summarizers.rebuildClaude(),
    startAutoDone() {
      autoDoneTimer = setInterval(() => {
        try {
          const marked = autoDone.tick();
          if (marked.length) console.log(`[auto-done] 止まったセッションを ${marked.length} 件 Done にしました`);
        } catch (e) {
          console.error('[auto-done]', e instanceof Error ? e.message : e);
        }
        expiry.tick();
      }, AUTO_DONE_POLL_MS);
      autoDoneTimer.unref();
    },
    stopAutoDone() { if (autoDoneTimer) clearInterval(autoDoneTimer); },
    async stop(ms) {
      if (!(await waitForSummaryIdle(summary, ms))) {
        console.warn(`[summary] 要約の終了を ${ms} ミリ秒待ちましたが終わらないので、待たずに閉じます`);
      }
    },
  };
}
