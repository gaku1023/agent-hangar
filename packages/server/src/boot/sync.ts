import { encodeJoinToken, type FileEntry } from '@agent-hangar/shared';
import { readCloudConfig } from '../config/cloud.ts';
import { defaultManagedDir, RetentionService } from '../provider/claude-code/config/retention.ts';
import type { ConfigSyncApi } from '../http/deps.ts';
import { ClaudeConfigSync } from '../sync/claudeConfig.ts';
import { ConfigSyncService } from '../sync/config/service.ts';
import { HttpCloudClient } from '../sync/client.ts';
import { configSyncApi } from '../sync/configSyncApi.ts';
import { deriveFileKey } from '../sync/crypto.ts';
import { SyncEngine } from '../sync/engine.ts';
import { configSyncActive, syncHalted } from '../sync/halt.ts';
import { memoLossHandlers, type Toast } from '../sync/notices.ts';
import { createOncePass } from '../sync/oncePass.ts';
import { backupPruner } from '../sync/pruneBackups.ts';
import { RemotePuller } from '../sync/puller.ts';
import { SyncStateStore } from '../sync/state.ts';
import { createSyncFeed, type SyncFeed } from '../sync/statusFeed.ts';
import { markTranscriptsFrom } from '../sync/transcriptsFrom.ts';
import { TranscriptUploader } from '../sync/uploader.ts';
import { CloudUsagePoller } from '../sync/usage.ts';
import type { DeliveryParts } from './delivery.ts';
import type { HomeParts } from './home.ts';
import { stopAfterIdle, stopUploader } from './stopping.ts';
import { t } from '@agent-hangar/shared';
import { touchRow } from '../db/notify.ts';

/**
 * Claude Code 設定の定期 push の間隔。
 * 監視が張れない置き場所や、取りこぼした編集があっても、次の周期で揃うようにする。
 * fs.watch の recursive は Node 22 では Linux でも効く（容器で確かめた）ので、
 * これは監視そのものが張れなかったときの備えであって、Linux のための穴埋めではない。
 */
const CONFIG_PUSH_MS = 60_000;
/**
 * 上がっていない本文を拾い直す走査の間隔。
 * 索引は「変化したファイル」しか知らせないので、これが無いと参加より前に索引が済んでいた本文は
 * ファイルが動くまで永久に上がらない。設定の定期 push と同じ役目なので、間隔も揃えてある。
 */
export const UPLOAD_SWEEP_MS = 60_000;
/** 作り直した設定の同期の、送受信の間隔。スイッチが切のあいだは何もしない。 */
export const CONFIG_BUNDLE_TICK_MS = 60_000;

export type SyncParts = {
  engine: SyncEngine;
  syncState: SyncStateStore;
  uploader: TranscriptUploader | null;
  cloudUsage: CloudUsagePoller;
  /** Claude Code の保持期間。値と使用量を持ち、変わったときだけ配る。書き込みは確認を経た PUT /api/retention からだけ来る。 */
  retention: RetentionService;
  /** 同期の状態に添える付録と、状態の配り。HTTP の応答と websocket の通知の両方がこれを通る。 */
  feed: SyncFeed;
  /** 利用者が押した「今すぐ同期」。 */
  syncNow(): Promise<void>;
  /** 本文とメモの控えの世代を刈る。 */
  pruneBackups(kind: 'transcripts' | 'memos'): void;
  /** Claude Code 設定の同期のうち HTTP が触る部分。同期を設定していない端末では null。 */
  configSync: ConfigSyncApi | null;
  /**
   * 作り直した設定の同期（sync/config/）。旧実装の configSync とは別で、既定は切（settings.json の configBundleSync）。
   * 同期を設定していない端末では null。
   */
  configBundle: ConfigSyncService | null;
  /** 設定の同期を切ったときに、取り込みの確認を降ろす。 */
  unconfirmConfigPull(): void;
  /** Claude Code 設定の同期の入り切りを、ヘッダと Settings の表示に載せ直す。 */
  publishConfigSync(): void;
  /** 参加トークン。全セッションの読み書き権を持つ。作るのはここだけで、ログにも例外にも出さない。 */
  joinToken(): string | null;
  /** 最初の同期、使用量、ファイルの取り込み、設定の監視、保持期間、定期の押し出しと走査を始める。 */
  start(): void;
  /** 定期の仕事（タイマー、保持期間、使用量）を止める。走っている通信は待たない。 */
  stopTimers(): void;
  /** 走っている通信を待ってから止める。left は締め切りまでの残りを返す。 */
  drain(left: () => number): Promise<void>;
};

/**
 * クラウド同期を組む。cloud.json が無ければ client は null で、同期の状態は off になる。
 * 組むのは、同期のエンジン、使用量、本文の上げ手、設定の同期、保持期間、本文の降ろし手、頼まれた 1 巡、状態の配りである。
 * 保持期間は同期ではないが、起動と停止の順がこの並びの中にあるので、ここで持つ。
 * memoPath は、プロジェクトのメモのファイルの場所である。競合で負けた手元の内容を、その隣に残す。
 */
export function bootSync(
  home: Pick<HomeParts, 'home' | 'db' | 'device' | 'claudeDir' | 'settings' | 'language'>,
  delivery: Pick<DeliveryParts, 'hub'> & Partial<Pick<DeliveryParts, 'publisher'>> & { toast: Toast },
  o: { memoPath: (projectId: string) => string },
): SyncParts {
  const { db, claudeDir, settings } = home;
  const { hub, toast } = delivery;
  const deviceId = home.device.id;
  const cloudRead = readCloudConfig(home.home);
  const cloud = cloudRead.config;
  if (cloudRead.state === 'broken') {
    // 「壊れている」を「未参加」と同じに扱わない。
    // 参加し直すと別の joinSecret が入り、R2 にある既存の暗号化ファイルを誰も復号できなくなる。
    console.error('[sync] ~/.agent-hangar/cloud.json を読めませんでした。同期は止めたままにします。hangar cloud status で確かめてください（参加し直すと既存の本文を復号できなくなります）');
  }
  const syncState = new SyncStateStore(db);
  // 本文をどこから上げるかの床が無ければ、ここで刻む。
  // 本筋は CLI の側で、setup cloud と join が cloud.json を書くのと同じ時点で刻んでいる。
  // ここは、cloud.json はあるのに DB に床の行が無い端末のための保険で、古い版のための分岐ではない。
  // 古い版の CLI で参加した端末のほか、DB を作り直した端末や、cloud.json だけを写した試しの HANGAR_HOME もこれに当たる。
  // 床の行が無いまま走ると 0（床なし）と読み、手元の本文を全部上げてしまう。
  // 床には cloud.json の joinedAt を使い、読めないときは今の時刻にする（0 を刻むと床なしになる）。
  // joinedAt は参加し直しと秘密の作り直しで今の時刻へ書き換わるが、床が無いときにしか読まないので、書き換わった値が使われるのは床の行が無い端末に限られる。
  // 以後、本文の取り残しの走査はこの時刻より後に動いた転記だけを拾う（sync/transcriptsFrom.ts）。
  // メタデータの同期はこの刻みを見ないので、今までどおり全部が揃う。
  if (cloud) markTranscriptsFrom(syncState, cloud.joinedAt > 0 ? cloud.joinedAt : Date.now());
  /**
   * 同期が止まっているか。利用者が押した一時停止も、Cloudflare の上限で退いている間もここに出る。
   * 止まっていても、利用者が「今すぐ同期」で頼んだ 1 巡の最中だけは止まっていないと答える。
   * 互換の版が合わずに止まっているときも止まっていると答える（1 巡の最中でも）。
   * 本文と設定の出し入れはどれもここを見るので、その 1 巡だけ通る。
   */
  const isPaused = (): boolean => syncHalted({ paused: engine.status().state === 'paused', oncePass: once.pass.active(), compatBlocked: engine.compatBlocked(), limited: engine.limitedUntil() !== null });
  const pruneBackups = backupPruner(home.home);
  const client = cloud ? new HttpCloudClient({ url: cloud.url, token: cloud.deviceToken }) : null;
  const fileKey = cloud ? deriveFileKey(cloud.joinSecret) : Buffer.alloc(32);
  const engine = new SyncEngine({
    db, deviceId, client, url: cloud?.url ?? null, home: home.home,
    ...memoLossHandlers({ memoPath: o.memoPath, toast, pruneMemos: () => pruneBackups('memos'), language: home.language }),
  });
  // 設定の「使用量と費用」。
  const cloudUsage = new CloudUsagePoller({ client, isPaused, broadcast: (usage) => hub.broadcast({ type: 'sync.usage', usage }) });
  const uploader = client
    ? new TranscriptUploader({
        db, deviceId, claudeDir, client, key: fileKey, state: syncState,
        isPaused,
        onError: (p, m) => console.error('[upload]', p, m),
      })
    : null;
  const configSync = client
    ? new ClaudeConfigSync({
        db, deviceId, deviceName: home.device.name, claudeDir, home: home.home, client, key: fileKey, state: syncState,
        // 切っているときと一時停止のあいだは押し出さない。fs.watch からの push もここを通る。
        enabled: () => configSyncActive({ syncClaudeConfig: settings.current.syncClaudeConfig, paused: isPaused() }), onToast: toast,
      })
    : null;
  // 作り直した設定の同期。旧実装（configSync）の設定のスイッチ（syncClaudeConfig）とは別のスイッチで、既定は切。
  // 新旧が同じ表やクラウドの鍵を取り合わない（表は config_*、鍵は config/<端末>/.hangar/）。
  const configBundle = client
    ? new ConfigSyncService({
        db, deviceId, deviceName: home.device.name, claudeDir, home: home.home, cloud: client, key: fileKey,
        enabled: () => settings.current.configBundleSync === true && !isPaused(),
        switchedOn: () => settings.current.configBundleSync === true,
        approval: () => (settings.current.configApproval === 'auto' ? 'auto' : 'each'),
        onError: (m) => console.error('[config-sync]', m),
      })
    : null;
  // 画面へ配る層に、状態の組み方を教える。表の変化（束の行が降りた、基準を書いた）のたびに config.update が出る。
  delivery.publisher?.setConfigSync(() => configBundle?.dto() ?? null);
  const retention = new RetentionService({ claudeDir, home: home.home, managedDir: defaultManagedDir(), broadcast: (r) => hub.broadcast({ type: 'retention.changed', retention: r }), language: home.language });
  const puller = client
    ? new RemotePuller({
        db, deviceId, home: home.home, client, key: fileKey, state: syncState,
        onConfigEntries: async (entries: FileEntry[]) => { await configSync?.applyPull(entries); },
        // 鳴るのは 1 回目と諦めたときだけなので、そのままトーストに出してよい。
        // 見逃した利用者のために、諦めた項目は同期の状態（syncSkipped）にも残る。
        onError: (k, m) => { console.error('[pull]', k, m); toast('error', t(home.language(), 'sync.pull.failed', { kind: k, reason: m })); },
      })
    : null;
  const feed = createSyncFeed({ hub, puller, uploader, oncePass: () => once.pass.active(), isPaused, cloudUsage, toast });
  const once = createOncePass({ engine, puller, configSync, uploader, cloudUsage, isPaused, sweepPending: feed.sweep, broadcastSync: feed.broadcastSync, toast, language: home.language });
  engine.on(feed.listener());

  const publishConfigSync = (): void => {
    engine.setClaudeConfigStatus({ enabled: settings.current.syncClaudeConfig, confirmed: syncState.get('configPullConfirmed') === '1' });
    // 承諾の仕方とスイッチは新しい実装の状態にも載るので、配り直す。
    touchRow(db, 'config_state', 'self');
  };
  /**
   * 索引が済んでいるのにまだ上がっていない本文を拾い直す。
   * 起動で 1 度と、そのあとは一定間隔で回す。
   * 1 回に積む数は uploader が抑えるので、初回の一括でも少しずつ流れる。
   */
  const sweepUploads = (): void => {
    if (!uploader) return;
    try { uploader.sweep(); } catch (e) { console.error('[upload]', e instanceof Error ? e.message : e); }
  };
  let configTimer: ReturnType<typeof setInterval> | null = null;
  let bundleTimer: ReturnType<typeof setInterval> | null = null;
  let uploadTimer: ReturnType<typeof setInterval> | null = null;

  return {
    engine, syncState, uploader, cloudUsage, retention, feed, pruneBackups, configBundle,
    syncNow: once.syncNow,
    configSync: configSyncApi(configSync),
    unconfirmConfigPull: () => configSync?.unconfirm(),
    publishConfigSync,
    joinToken: () => (cloud ? encodeJoinToken({ url: cloud.url, secret: cloud.joinSecret }) : null),
    start() {
      publishConfigSync();
      // 最初の同期の完了を待たない。
      // クラウドが応答しないと push と pull がそれぞれ 30 秒待つので、待つと startServer の解決が 90 秒遅れる。
      // その間 /health は 200 を返しているので、準備完了だと見た相手からの SIGTERM が受け口の無い時刻に届く。
      // 走り出した push と pull は engine.idle() が掴んでいるので、close() は取りこぼさない。
      void engine.start().catch((e: unknown) => console.error('[sync]', e instanceof Error ? e.message : e));
      cloudUsage.start();
      feed.pullFiles();
      configSync?.start();
      retention.start();
      // 監視だけに頼らず、定期の push も足しておく。
      // 監視が張れない置き場所や、取りこぼした編集があっても、次の周期で揃う。
      // ここには以前「fs.watch の recursive は Linux では効かない」と書いてあったが、
      // Node 22 では Linux でも効くことを容器で確かめたので直した。
      // 一時停止のあいだは押し出さない（pushChanged 自身も enabled() で同じ判定を通る）。
      configTimer = configSync
        ? setInterval(() => {
            if (isPaused()) return;
            void configSync.pushChanged().catch((e: unknown) => console.error('[config]', e instanceof Error ? e.message : e));
          }, CONFIG_PUSH_MS)
        : null;
      configTimer?.unref();
      // 作り直した設定の同期。切のあいだは tick が何もしない。
      bundleTimer = configBundle ? setInterval(() => { void configBundle.tick(); }, CONFIG_BUNDLE_TICK_MS) : null;
      bundleTimer?.unref();
      sweepUploads();
      // 起動のときにも 1 度刈る。
      // 控えを作る経路を通らないまま動かし続けた端末や、この刈り込みが入る前から溜めていた端末も、ここで揃う。
      pruneBackups('transcripts');
      pruneBackups('memos');
      uploadTimer = uploader ? setInterval(sweepUploads, UPLOAD_SWEEP_MS) : null;
      uploadTimer?.unref();
    },
    stopTimers() {
      if (configTimer) clearInterval(configTimer);
      if (bundleTimer) clearInterval(bundleTimer);
      retention.stop();
      cloudUsage.stop();
      if (uploadTimer) clearInterval(uploadTimer);
      once.stopTicker();
    },
    async drain(left) {
      // 頼まれた 1 巡が走っていれば先に待つ。各段はこの後の stop で空振りになるので、待ち切れなくても害は無い。
      await Promise.race([once.pass.idle(), new Promise<void>((r) => { setTimeout(r, left()).unref(); })]);
      // 走っている押し出しを待ってから止める。待たずに止めると putFile と pushChanges が途中で切れる。
      await stopAfterIdle(configSync, 'config', left());
      await stopAfterIdle(configBundle, 'config-bundle', left());
      await stopUploader(uploader, left());
      await stopAfterIdle(engine, 'sync', left());
      // 降ろしも同じ作法で、走っているものを待ってから止める。
      // engine を先に止めてあるので、pulled の合図で新しい降ろしが積まれることはもう無い。
      // 待ち切れなくても必ず止める。降ろしは一時ファイルに書いてから置き換えるので、切れても半端は残らない。
      await stopAfterIdle(puller, 'files', left());
    },
  };
}
