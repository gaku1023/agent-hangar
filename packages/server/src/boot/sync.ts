import fs from 'node:fs';
import path from 'node:path';
import { encodeJoinToken, type CloudDevicesDto } from '@agent-hangar/shared';
import { cloudConfigPath, readCloudConfig, type CloudConfig } from '../config/cloud.ts';
import { defaultManagedDir, RetentionService } from '../provider/claude-code/config/retention.ts';
import { ConfigSyncService } from '../sync/config/service.ts';
import { HttpCloudClient } from '../sync/client.ts';
import { deriveFileKey } from '../sync/crypto.ts';
import { loadCloudDevices } from '../sync/devices.ts';
import { SyncEngine } from '../sync/engine.ts';
import { syncHalted } from '../sync/halt.ts';
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
 * 上がっていない本文を拾い直す走査の間隔。
 * 索引は「変化したファイル」しか知らせないので、これが無いと参加より前に索引が済んでいた本文は
 * ファイルが動くまで永久に上がらない。設定の定期 push と同じ役目なので、間隔も揃えてある。
 */
export const UPLOAD_SWEEP_MS = 60_000;
/** 設定の同期の、送受信の間隔。スイッチが切のあいだは何もしない。 */
export const CONFIG_BUNDLE_TICK_MS = 60_000;
/** fs.watch が使えないときだけ、cloud.json が現れたかを読み直す間隔。 */
export const CLOUD_JSON_POLL_MS = 30_000;
/** cloud.json の変化を拾ってから読むまでの間。書き込みの連続を 1 回にまとめる。 */
const CLOUD_JSON_SETTLE_MS = 100;

/** cloud.json の見張りの差し替え口。試験が fs.watch を壊したり、読み直しの間隔を縮めたりする。 */
export type CloudWatchOptions = { watch?: typeof fs.watch; pollMs?: number };

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
  /**
   * 設定の同期（sync/config/）。既定は切（settings.json の configBundleSync）。
   * 同期を設定していない端末では null。
   */
  configBundle: ConfigSyncService | null;
  /** 設定の同期の入り切りを、設定の表示に載せ直し、入った直後に 1 回回す。 */
  publishConfigSync(): void;
  /** 参加トークン。全セッションの読み書き権を持つ。作るのはここだけで、ログにも例外にも出さない。 */
  joinToken(): string | null;
  /** 設定のクラウド同期の節の PC の一覧（Worker の devices）。 */
  cloudDevices(): Promise<CloudDevicesDto>;
  /**
   * 他の PC から、索引の選び方に関わるものが届いたときの受け手を足す。
   * sessions の行を当てたときと、本文の写しを置いたときに呼ぶ。索引が全件走査を 1 回予約する（boot/indexing.ts）。
   */
  onRemoteChange(cb: () => void): () => void;
  /** 最初の同期、使用量、ファイルの取り込み、保持期間、定期の押し出しと走査を始める。 */
  start(): void;
  /** 定期の仕事（タイマー、保持期間、使用量）を止める。走っている通信は待たない。 */
  stopTimers(): void;
  /** 走っている通信を待ってから止める。left は締め切りまでの残りを返す。 */
  drain(left: () => number): Promise<void>;
};

/** クラウドの設定に依る部品の束。cloud.json が無ければ client は null で、各部品は「off」の形になる。 */
type Core = {
  cloud: CloudConfig | null;
  client: HttpCloudClient | null;
  engine: SyncEngine;
  cloudUsage: CloudUsagePoller;
  uploader: TranscriptUploader | null;
  configBundle: ConfigSyncService | null;
  puller: RemotePuller | null;
  feed: SyncFeed;
  once: ReturnType<typeof createOncePass>;
  bundleTimer: ReturnType<typeof setInterval> | null;
  uploadTimer: ReturnType<typeof setInterval> | null;
};

/**
 * クラウド同期を組む。cloud.json が無ければ client は null で、同期の状態は off になる。
 * 組むのは、同期のエンジン、使用量、本文の上げ手、設定の同期、保持期間、本文の降ろし手、頼まれた 1 巡、状態の配りである。
 * 保持期間は同期ではないが、起動と停止の順がこの並びの中にあるので、ここで持つ。
 * memoPath は、プロジェクトのメモのファイルの場所である。競合で負けた手元の内容を、その隣に残す。
 *
 * cloud.json に依る部品は Core にまとめてあり、返す SyncParts はその時点の Core を引く。
 * 起動のときに cloud.json が無かった端末では、置き場を見張り、設定が現れたら起動と同じ組み立てで Core を組み直して始める。
 * 見張るのは「無い（または壊れている）状態から現れる」ときだけである。
 * 動いている同期の cloud.json の書き換え（別のクラウドへの付け替え、削除）は拾わず、今までどおり開き直しで効く。
 */
export function bootSync(
  home: Pick<HomeParts, 'home' | 'db' | 'device' | 'claudeDir' | 'settings' | 'language'>,
  delivery: Pick<DeliveryParts, 'hub'> & Partial<Pick<DeliveryParts, 'publisher'>> & { toast: Toast },
  o: { memoPath: (projectId: string) => string; cloudWatch?: CloudWatchOptions },
): SyncParts {
  const { db, claudeDir, settings } = home;
  const { hub, toast } = delivery;
  const deviceId = home.device.id;
  const cloudRead = readCloudConfig(home.home);
  if (cloudRead.state === 'broken') {
    // 「壊れている」を「未参加」と同じに扱わない。
    // 参加し直すと別の joinSecret が入り、R2 にある既存の暗号化ファイルを誰も復号できなくなる。
    console.error('[sync] ~/.agent-hangar/cloud.json を読めませんでした。同期は止めたままにします。hangar cloud status で確かめてください（参加し直すと既存の本文を復号できなくなります）');
  }
  const syncState = new SyncStateStore(db);
  const remoteChangeListeners = new Set<() => void>();
  const remoteChanged = (): void => { for (const cb of remoteChangeListeners) cb(); };
  const pruneBackups = backupPruner(home.home);
  const retention = new RetentionService({ claudeDir, home: home.home, managedDir: defaultManagedDir(), broadcast: (r) => hub.broadcast({ type: 'retention.changed', retention: r }), language: home.language });

  const assemble = (cloud: CloudConfig | null): Core => {
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
    const isPaused = (): boolean => syncHalted({ paused: engine.status().state === 'paused', oncePass: once.pass.active(), compatBlocked: engine.compatBlocked(), limited: engine.limitedUntil() !== null, revoked: engine.revoked() });
    const client = cloud ? new HttpCloudClient({ url: cloud.url, token: cloud.deviceToken }) : null;
    const fileKey = cloud ? deriveFileKey(cloud.joinSecret) : Buffer.alloc(32);
    const engine = new SyncEngine({
      db, deviceId, client, url: cloud?.url ?? null, home: home.home, language: home.language,
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
    // 設定の同期。スイッチは settings.json の configBundleSync で、既定は切。
    const configBundle = client
      ? new ConfigSyncService({
          db, deviceId, deviceName: home.device.name, claudeDir, home: home.home, cloud: client, key: fileKey,
          enabled: () => settings.current.configBundleSync === true && !isPaused(),
          switchedOn: () => settings.current.configBundleSync === true,
          approval: () => (settings.current.configApproval === 'auto' ? 'auto' : 'each'),
          onError: (m) => console.error('[config-sync]', m),
        })
      : null;
    const puller = client
      ? new RemotePuller({
          db, deviceId, home: home.home, client, key: fileKey, state: syncState, language: home.language,
          // 画面へは toast を流さない（トーストは操作の結果だけにした）。
          // 諦めた項目は同期の状態（skipped）に残り、画面のベルの一覧が事実からその行を組む。
          onError: (k, m) => { console.error('[pull]', k, m); },
          onDownloaded: () => remoteChanged(),
        })
      : null;
    const feed = createSyncFeed({ hub, puller, uploader, oncePass: () => once.pass.active(), isPaused, cloudUsage, toast });
    const once = createOncePass({ engine, puller, configBundle, uploader, cloudUsage, isPaused, sweepPending: feed.sweep, broadcastSync: feed.broadcastSync, toast, language: home.language });
    engine.on(feed.listener());
    // 他の PC の sessions の行は、索引がどの本文を採るか（写しの行が届いたか、消されたか）に関わる。
    engine.on({ applied: (c) => { if (c.tableName === 'sessions') remoteChanged(); } });
    return { cloud, client, engine, cloudUsage, uploader, configBundle, puller, feed, once, bundleTimer: null, uploadTimer: null };
  };

  let core = assemble(cloudRead.config);
  // 画面へ配る層に、状態の組み方を教える。表の変化（束の行が降りた、基準を書いた）のたびに config.update が出る。
  // 組み直しても同じ口で足りるよう、そのときの core を引く。
  delivery.publisher?.setConfigSync(() => core.configBundle?.dto() ?? null);

  // 設定の同期のスイッチが切から入に変わった瞬間に、次の周期を待たず 1 回回す。
  // 送る一覧を承諾した人が、承諾したあとの 1 分近くを黙って待たないようにする。
  let bundleWasOn = settings.current.configBundleSync === true;
  const publishConfigSync = (): void => {
    const bundleOn = settings.current.configBundleSync === true;
    if (bundleOn && !bundleWasOn) void core.configBundle?.tick();
    bundleWasOn = bundleOn;
    // 承諾の仕方とスイッチは新しい実装の状態にも載るので、配り直す。
    touchRow(db, 'config_state', 'self');
  };
  /**
   * 索引が済んでいるのにまだ上がっていない本文を拾い直す。
   * 起動で 1 度と、そのあとは一定間隔で回す。
   * 1 回に積む数は uploader が抑えるので、初回の一括でも少しずつ流れる。
   */
  const sweepUploads = (c: Core): void => {
    if (!c.uploader) return;
    try { c.uploader.sweep(); } catch (e) { console.error('[upload]', e instanceof Error ? e.message : e); }
  };
  /** 最初の同期、使用量、ファイルの取り込み、定期の押し出しと走査を始める。 */
  const startCore = (c: Core): void => {
    publishConfigSync();
    // 最初の同期の完了を待たない。
    // クラウドが応答しないと push と pull がそれぞれ 30 秒待つので、待つと startServer の解決が 90 秒遅れる。
    // その間 /health は 200 を返しているので、準備完了だと見た相手からの SIGTERM が受け口の無い時刻に届く。
    // 走り出した push と pull は engine.idle() が掴んでいるので、close() は取りこぼさない。
    void c.engine.start().catch((e: unknown) => console.error('[sync]', e instanceof Error ? e.message : e));
    c.cloudUsage.start();
    c.feed.pullFiles();
    // 設定の同期。切のあいだは tick が何もしない。
    c.bundleTimer = c.configBundle ? setInterval(() => { void c.configBundle?.tick(); }, CONFIG_BUNDLE_TICK_MS) : null;
    c.bundleTimer?.unref();
    sweepUploads(c);
    c.uploadTimer = c.uploader ? setInterval(() => sweepUploads(c), UPLOAD_SWEEP_MS) : null;
    c.uploadTimer?.unref();
  };
  const stopCoreTimers = (c: Core): void => {
    if (c.bundleTimer) clearInterval(c.bundleTimer);
    c.cloudUsage.stop();
    if (c.uploadTimer) clearInterval(c.uploadTimer);
    c.once.stopTicker();
  };

  // 起動のとき cloud.json が無かった（壊れていた）端末で、設定が現れるのを待つ。
  let stopped = false;
  let unwatch: (() => void) | null = null;
  const adopt = (cloud: CloudConfig): void => {
    const old = core;
    core = assemble(cloud);
    // 前の core は参加していない形で、通信も周期の仕事も持たない。購読と書き込みの見張りだけを外す。
    stopCoreTimers(old);
    old.engine.stop();
    unwatch?.();
    startCore(core);
  };
  const watchForCloud = (): void => {
    const dir = home.home;
    const name = path.basename(cloudConfigPath(dir));
    let settle: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let watcher: fs.FSWatcher | null = null;
    const close = (): void => {
      if (settle) clearTimeout(settle);
      if (poll) clearInterval(poll);
      watcher?.close();
      settle = poll = null; watcher = null;
      unwatch = null;
    };
    unwatch = close;
    const check = (): void => {
      if (stopped || core.cloud) { close(); return; }
      const r = readCloudConfig(dir);
      // 壊れている間は何もしない。直った書き込みでもう一度来る。
      if (r.state === 'ok' && r.config) adopt(r.config);
    };
    const kick = (): void => {
      if (settle) return;
      settle = setTimeout(() => { settle = null; check(); }, CLOUD_JSON_SETTLE_MS);
      settle.unref();
    };
    const fallbackToPoll = (): void => {
      watcher?.close(); watcher = null;
      if (poll) return;
      poll = setInterval(check, o.cloudWatch?.pollMs ?? CLOUD_JSON_POLL_MS);
      poll.unref();
    };
    try {
      // 置き場のディレクトリを見る。cloud.json は一時ファイルから置き換えで現れるので、ファイルそのものを見ると取り逃がす。
      // 置き場は DB なども動くので、名前で絞る。名前が分からない通知（null）は念のため読みに行く。
      watcher = (o.cloudWatch?.watch ?? fs.watch)(dir, { persistent: false }, (_ev, f) => { if (f == null || String(f) === name) kick(); });
      watcher.on('error', fallbackToPoll);
    } catch {
      fallbackToPoll();
    }
  };

  return {
    get engine() { return core.engine; },
    syncState,
    get uploader() { return core.uploader; },
    get cloudUsage() { return core.cloudUsage; },
    retention,
    get feed() { return core.feed; },
    pruneBackups,
    get configBundle() { return core.configBundle; },
    syncNow: () => core.once.syncNow(),
    publishConfigSync,
    onRemoteChange: (cb) => { remoteChangeListeners.add(cb); return () => { remoteChangeListeners.delete(cb); }; },
    joinToken: () => (core.cloud ? encodeJoinToken({ url: core.cloud.url, secret: core.cloud.joinSecret }) : null),
    cloudDevices: () => loadCloudDevices({ client: core.client, deviceId, creator: core.cloud?.workerName != null, language: home.language }),
    start() {
      startCore(core);
      retention.start();
      // 起動のときにも 1 度刈る。
      // 控えを作る経路を通らないまま動かし続けた端末や、この刈り込みが入る前から溜めていた端末も、ここで揃う。
      pruneBackups('transcripts');
      pruneBackups('memos');
      if (!core.cloud && !stopped) watchForCloud();
    },
    stopTimers() {
      stopped = true;
      unwatch?.();
      stopCoreTimers(core);
      retention.stop();
    },
    async drain(left) {
      const c = core;
      // 頼まれた 1 巡が走っていれば先に待つ。各段はこの後の stop で空振りになるので、待ち切れなくても害は無い。
      await Promise.race([c.once.pass.idle(), new Promise<void>((r) => { setTimeout(r, left()).unref(); })]);
      // 走っている押し出しを待ってから止める。待たずに止めると putFile と pushChanges が途中で切れる。
      await stopAfterIdle(c.configBundle, 'config-bundle', left());
      await stopUploader(c.uploader, left());
      await stopAfterIdle(c.engine, 'sync', left());
      // 降ろしも同じ作法で、走っているものを待ってから止める。
      // engine を先に止めてあるので、pulled の合図で新しい降ろしが積まれることはもう無い。
      // 待ち切れなくても必ず止める。降ろしは一時ファイルに書いてから置き換えるので、切れても半端は残らない。
      await stopAfterIdle(c.puller, 'files', left());
    },
  };
}
