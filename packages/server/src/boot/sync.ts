import fs from 'node:fs';
import path from 'node:path';
import { codexEnabledOf, MOBILE_MIN_WORKER_COMPAT, TAKEOVER_MIN_WORKER_COMPAT, type CloudDevicesDto, type DeviceOut } from '@agent-hangar/shared';
import { defaultCodexHome } from '../provider/codex/transcript/discover.ts';
import { cloudConfigPath, readCloudConfig, saveCloudConfig, type CloudConfig } from '../config/cloud.ts';
import { defaultManagedDir, RetentionService } from '../provider/claude-code/config/retention.ts';
import { ConfigSyncService } from '../sync/config/service.ts';
import { HttpCloudClient, type CloudClient } from '../sync/client.ts';
import { leftPhoneSweeper, loadCloudDevices, sharedDeviceOf } from '../sync/devices.ts';
import { Keyring } from '../sync/keyring.ts';
import { SealedCloudClient } from '../sync/sealedClient.ts';
import { SyncEngine } from '../sync/engine.ts';
import { syncHalted } from '../sync/halt.ts';
import { memoLossHandlers, type Toast } from '../sync/notices.ts';
import { createOncePass } from '../sync/oncePass.ts';
import { backupPruner } from '../sync/pruneBackups.ts';
import { RemotePuller } from '../sync/puller.ts';
import { JoinApprover, joinNotifier } from '../sync/joinApprover.ts';
import { RecoveryKeyReissuer } from '../sync/recoveryReissue.ts';
import { RosterStore, rosterRefresh, type ConfigWriter } from '../sync/roster.ts';
import { phoneKeysOf, type PhoneKeySource } from '../sync/phoneKeys.ts';
import { PhonePairer, type MobileLink } from '../mobile/pairer.ts';
import { SyncStateStore } from '../sync/state.ts';
import { createSyncFeed, type SyncFeed } from '../sync/statusFeed.ts';
import { markTranscriptsFrom } from '../sync/transcriptsFrom.ts';
import { resumeRotation, revokeMember, rotationPending, rotationRetrier, type RotateDeps } from '../sync/rotate.ts';
import { sweepSupersededBlobs, sweepTrashBlobs, TRASH_SWEEP_EVERY_MS } from '../sync/trashSweep.ts';
import { TranscriptUploader, type OpencodeExportSource } from '../sync/uploader.ts';
import { CloudUsagePoller } from '../sync/usage.ts';
import type { DeliveryParts } from './delivery.ts';
import type { HomeParts } from './home.ts';
import { stopAfterIdle, stopUploader } from './stopping.ts';
import { t } from '@agent-hangar/shared';
import { touchRow } from '../db/notify.ts';
import { followRemoteScratch } from '../projects/scratch.ts';

/**
 * 上がっていない本文を拾い直す走査の間隔。
 * 索引は「変化したファイル」しか知らせないので、これが無いと参加より前に索引が済んでいた本文は
 * ファイルが動くまで永久に上がらない。設定の定期 push と同じ役目なので、間隔も揃えてある。
 */
export const UPLOAD_SWEEP_MS = 60_000;
/** 設定の同期の、送受信の間隔。スイッチが切のあいだは何もしない。 */
export const CONFIG_BUNDLE_TICK_MS = 60_000;
/** 起動から最初のゴミ箱の掃除までの間。最初の同期と取り残しの走査を先に通す。 */
const TRASH_SWEEP_FIRST_MS = 5 * 60_000;
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
  /**
   * 参加コードを発行した PC の承認（sync/joinApprover.ts）。同期を設定していない端末では null。
   * cloud.json が現れて部品を組み直すと、新しいものに替わる（前のものは止める）。
   */
  joinApprover(): JoinApprover | null;
  /**
   * 他の端末の解除（sync/rotate.ts の revokeMember）。PC なら世代を回す。同期を設定していない端末では null。
   * 解除と、起動のときの回しの続きは 1 本ずつ順に走らせる（2 つの回しを重ねない）。
   */
  cloudRevoke(): ((id: string) => Promise<DeviceOut>) | null;
  /**
   * リカバリーキーの再発行（sync/recoveryReissue.ts）。同期を設定していない端末では null。
   * cloud.json が現れて部品を組み直すと、新しいものに替わり、前の下書きは使えなくなる。
   */
  recoveryKey(): RecoveryKeyReissuer | null;
  /** 設定のクラウド同期の節の PC の一覧（Worker の devices）。読めた一覧は onCloudDevices の受け手にも渡す。 */
  cloudDevices(): Promise<CloudDevicesDto>;
  /**
   * cloudDevices が一覧を読むたびに呼ぶ受け手を足す。設定の画面の読み込み（QR を出している間の 3 秒ごとを含む）と、受信箱の書き手の見回り（boot/mobile.ts）の両方で届く。
   * 受信箱の書き手は、これでスマホがつながっているかを知る。
   */
  onCloudDevices(cb: (d: CloudDevicesDto) => void): () => void;
  /**
   * 他の PC から、索引の選び方に関わるものが届いたときの受け手を足す。
   * sessions の行を当てたときと、本文の写しを置いたときに呼ぶ。索引が全件走査を 1 回予約する（boot/indexing.ts）。
   */
  onRemoteChange(cb: () => void): () => void;
  /** 他の PC から session_states の行（削除の印を含む）が届いたときの受け手を足す。削除の受け持ちが次の回を回す（boot/trash.ts）。 */
  onStatesApplied(cb: () => void): () => void;
  /** 削除したセッションがほかの PC で戻されたとき、消した写しを降ろし直す（sync/puller.ts の refetchSession）。同期していなければ何もしない。 */
  refetchSession(providerSessionId: string): void;
  /** 手元の変更を今すぐクラウドへ押し出す。同期していなければ何もしない。 */
  pushNow(): Promise<void>;
  /** そのセッションの本文を今すぐ上げる（run の終わりと同じ上げ方）。同期していなければ何もしない。 */
  flushSession(uuid: string): Promise<void>;
  /** 他の PC から引き継ぎの頼みか応答（takeovers、takeover_answers）の行が届いたときの受け手を足す。 */
  onTakeoversApplied(cb: () => void): () => void;
  /**
   * 引き継ぎの応答を待つ間に取りに行く。行の pull と本文の写しの pull を 1 回ずつ回す。
   * 同期していない、または止まっているときは何もしない。
   */
  pullForTakeover(): Promise<void>;
  /**
   * 引き継ぎの頼みの行を書いてよいか。同期が設定済みで、一時停止でも、版や解除や上限で止まってもおらず、
   * Worker が名乗る版が TAKEOVER_MIN_WORKER_COMPAT に届いているとき真。
   * 版 5 までの Worker は 2 表の行を含む push を丸ごと断るので、満たさないあいだは行を書かない。まだ話していない（版が分からない）あいだも偽である。
   */
  canCarryTakeover(): boolean;
  /**
   * スマホ向けの口（/m/）に書いてよいか。canCarryTakeover と同じ形で、Worker が名乗る版が MOBILE_MIN_WORKER_COMPAT に届いているとき真。
   * 版 6 の Worker は /m/ を知らないので、満たさないあいだは受信箱の素を書かず、依頼も扱わない。まだ話していないあいだも偽である。
   */
  canCarryMobile(): boolean;
  /**
   * スマホ向けの部品が使う、今の client、Worker の URL、スマホ用の鍵の引き口、スマホの接続の PC 側。同期を設定していなければ null。
   * cloud.json が後から現れて組み直すと、別のものを返す。書き手は client か鍵の引き口が変わったら組み直す（boot/mobile.ts）。
   * スマホ用の鍵 M は名簿の phoneKey にあり、名簿を読むたびに Keyring と cloud.json へ写る（sync/roster.ts）。
   */
  mobileLink(): MobileLink | null;
  /** 最初の同期、使用量、ファイルの取り込み、保持期間、定期の押し出しと走査を始める。 */
  start(): void;
  /** 定期の仕事（タイマー、保持期間、使用量）を止める。走っている通信は待たない。 */
  stopTimers(): void;
  /** 走っている通信を待ってから止める。left は締め切りまでの残りを返す。 */
  drain(left: () => number): Promise<void>;
};

/**
 * 名簿の読み書き（RosterStore）が cloud.json を読み書きする口。
 * 読むのは組み上がった Core の写しで、書くときはファイルを読み直して分だけ当て、Core の写しにも同じ分を当てる。
 * ファイルが別のクラウドか鍵ペアを指していれば（動いている間に setup をやり直した）、世代鍵を混ぜないよう書かない。
 */
function cloudWriter(home: string, cloud: CloudConfig, built: () => { cloud: CloudConfig | null } | null): ConfigWriter {
  const current = (): CloudConfig => built()?.cloud ?? cloud;
  return {
    read: current,
    write: (patch) => {
      const now = current();
      const r = readCloudConfig(home);
      const disk = r.state === 'ok' && r.config ? r.config : null;
      if (disk && (disk.url !== now.url || disk.cloudId !== now.cloudId || disk.keyPair.pub !== now.keyPair.pub)) {
        console.error('[sync] cloud.json now points to a different Worker, cloud or key pair; the new epoch keys were kept in memory only. Restart hangar.');
        return;
      }
      saveCloudConfig(home, { ...(disk ?? now), ...patch });
      const b = built();
      if (b?.cloud) b.cloud = { ...b.cloud, ...patch };
    },
  };
}

/** クラウドの設定に依る部品の束。cloud.json が無ければ client は null で、各部品は「off」の形になる。 */
type Core = {
  cloud: CloudConfig | null;
  /** 行を封じて開く client（線の HttpCloudClient を包んだもの）。部品はみなこれを持つ。 */
  client: SealedCloudClient | null;
  /** 封じた名簿と keybox の読み書き。PC の一覧の名前と OS もここから読む。 */
  roster: RosterStore | null;
  /** スマホ用の鍵の引き口と、スマホの接続の PC 側。同期を設定していなければ null。 */
  phone: { keys: PhoneKeySource; pairer: PhonePairer } | null;
  /** 参加コードの発行と承認。同期を設定していなければ null。 */
  joinApprover: JoinApprover | null;
  /** リカバリーキーの再発行。同期を設定していなければ null。 */
  recoveryKey: RecoveryKeyReissuer | null;
  engine: SyncEngine;
  cloudUsage: CloudUsagePoller;
  uploader: TranscriptUploader | null;
  configBundle: ConfigSyncService | null;
  puller: RemotePuller | null;
  feed: SyncFeed;
  once: ReturnType<typeof createOncePass>;
  bundleTimer: ReturnType<typeof setInterval> | null;
  uploadTimer: ReturnType<typeof setInterval> | null;
  /** ゴミ箱の掃除の 1 回（sync/trashSweep.ts）。同期を設定していなければ null。 */
  sweepTrash: (() => Promise<void>) | null;
  trashTimers: { first: ReturnType<typeof setTimeout>; every: ReturnType<typeof setInterval> } | null;
  /** 他の端末の解除。同期を設定していなければ null。 */
  revoke: ((id: string) => Promise<DeviceOut>) | null;
  /**
   * 回しの途中の記録の続きと、その試し直し（sync/rotate.ts の rotationRetrier）。同期を設定していなければ null。
   * 起動のときと、動いている間の解除が失敗して記録が残ったときに、5 分おきに試し直す。
   */
  rotationRetry: ReturnType<typeof rotationRetrier> | null;
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
 * 参加し直して端末トークンだけが変わったときは、見張らずに、Worker に 401 の unauthorized で断られた時点で cloud.json を読み直して差し替える（下の reloadCredentials）。
 * 動いている同期の cloud.json のそれ以外の書き換え（別のクラウドへの付け替え、鍵の作り直し、削除）は拾わず、今までどおり開き直しで効く。
 */
export function bootSync(
  home: Pick<HomeParts, 'home' | 'db' | 'device' | 'claudeDir' | 'settings' | 'language'>,
  delivery: Pick<DeliveryParts, 'hub'> & Partial<Pick<DeliveryParts, 'publisher' | 'osNotices'>> & { toast: Toast },
  o: {
    memoPath: (projectId: string) => string;
    cloudWatch?: CloudWatchOptions;
    /** opencode の本文の書き出しの口（boot/opencode.ts）。serve の管理は同期より後に組むので、呼ばれた時点で引く。 */
    opencodeExport?: () => OpencodeExportSource | null;
  },
): SyncParts {
  const { db, claudeDir, settings } = home;
  const { hub, toast } = delivery;
  const deviceId = home.device.id;
  const cloudRead = readCloudConfig(home.home);
  if (cloudRead.state === 'broken') {
    // 「壊れている」を「未参加」と同じに扱わない。
    // 参加し直すと別の鍵ペアが入り、この PC 宛ての keybox を開けなくなる。
    console.error('[sync] ~/.agent-hangar/cloud.json を読めませんでした。同期は止めたままにします。hangar cloud status で確かめてください（参加し直すと既存の本文を復号できなくなります）');
  }
  if (cloudRead.state === 'legacy') {
    // 版 1（参加用の秘密を持つ形）は、E2E の Worker とは話せない。
    // 同期もスマホの機能も始めず、作り直しを待つ。版 2 の cloud.json が現れたら、下の見張りが拾って始める。
    console.error('[sync] ~/.agent-hangar/cloud.json is in the old format (before end-to-end encryption). Sync stays off until the cloud is rebuilt.');
  }
  const syncState = new SyncStateStore(db);
  const remoteChangeListeners = new Set<() => void>();
  const remoteChanged = (): void => { for (const cb of remoteChangeListeners) cb(); };
  const statesListeners = new Set<() => void>();
  const statesApplied = (): void => { for (const cb of statesListeners) cb(); };
  const takeoverListeners = new Set<() => void>();
  const cloudDeviceListeners = new Set<(d: CloudDevicesDto) => void>();
  const takeoversApplied = (): void => { for (const cb of takeoverListeners) cb(); };
  /**
   * スマホが自分で外した後の後始末。名簿にあるのに Worker で解除済みのスマホを、PC からの解除と同じ口（core.revoke）へ渡す。
   * 見つけるのは下の一覧の読み（設定を開いたとき、スマホの有無の読み直し）で、新しい問い合わせは足さない。
   * core.revoke は解除と回しの鎖に並ぶので、ほかの解除と重ならない。
   */
  const sweepLeftPhones = leftPhoneSweeper((id) => core.revoke?.(id) ?? Promise.resolve());
  /** 端末の一覧を読み、受け手（onCloudDevices）に配る。読むのは呼んだときの core である。 */
  const readCloudDevices = async (): Promise<CloudDevicesDto> => {
    const d = await loadCloudDevices({ client: core.client, roster: core.roster, deviceId, creator: core.cloud?.workerName != null, language: home.language, sharedDevice: sharedDeviceOf(db), ...(core.revoke ? { onLeftPhones: sweepLeftPhones } : {}) });
    for (const cb of [...cloudDeviceListeners]) {
      try { cb(d); } catch (e) { console.error('[sync] a cloud devices listener failed', e instanceof Error ? e.constructor.name : typeof e); }
    }
    return d;
  };
  /** スマホを接続し終えた。受信箱の書き手がスマホの有無を見直すよう、一覧を 1 回だけ読む（QR の 3 秒ごとの問い合わせでは読まない）。 */
  const onPhonePaired = (): void => {
    void readCloudDevices().catch((e: unknown) => console.error('[sync] could not read the device list after connecting a phone', e instanceof Error ? e.constructor.name : typeof e));
  };
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
    const isPaused = (): boolean => syncHalted({ paused: engine.status().state === 'paused', oncePass: once.pass.active(), compatBlocked: engine.compatBlocked() || engine.rebuildBlocked(), limited: engine.limitedUntil() !== null, revoked: engine.revoked() });
    // 参加し直すと（hangar setup cloud をやり直す、hangar join し直す）、Worker は同じ端末 ID の token_hash を入れ替え、新しいトークンは cloud.json にだけ書かれる。
    // 古いトークンの要求は 401 の unauthorized で断られるので、そのときに cloud.json を読み直し、トークンだけが変わっていれば client が差し替えて試し直す。
    // 部品（エンジン、本文の上げ手と降ろし手、使用量、設定の同期、PC の一覧）はみな同じ client を持つので、差し替えは全部に一度に効く。
    // 宛先かクラウドか鍵ペアが変わっていたら差し替えない。宛先は区切り（lastSeq）と状態の表示に、クラウドと鍵ペアは世代鍵と本文の鍵に結び付いているので、組み直しの要る変化であり、今までどおり開き直しで効かせる。
    // 差し替えるのはトークンだけで、世代鍵の書き換え（keybox の読み直し）はこの道では拾わない。
    // 書き込みの前には Worker の版を確かめる（checkWorkerBeforeWrite）。版の下限に届かない Worker に、未送信の行や本文を書き込まない。
    let warnedReload = false;
    // 組み上がった Core。読み直しは通信の応答を受けてから呼ばれるので、そのときには入っている。
    let built: Core | null = null;
    const reloadCredentials = (): { url: string; token: string } | null => {
      if (!built) return null;
      const now = built.cloud;
      const r = readCloudConfig(home.home);
      if (!now || r.state !== 'ok' || !r.config) return null;
      const next = r.config;
      if (next.deviceToken === now.deviceToken) return null;
      if (next.url !== now.url || next.cloudId !== now.cloudId || next.keyPair.pub !== now.keyPair.pub) {
        if (!warnedReload) console.error('[sync] cloud.json now points to a different Worker, cloud or key pair. Restart hangar to sync with the new settings.');
        warnedReload = true;
        return null;
      }
      built.cloud = { ...now, deviceToken: next.deviceToken };
      return { url: next.url, token: next.deviceToken };
    };
    const wire = cloud ? new HttpCloudClient({ url: cloud.url, token: cloud.deviceToken, reloadCredentials, checkWorkerBeforeWrite: true }) : null;
    // 行は SealedCloudClient が今の世代の鍵で封じ、行が名乗る世代の鍵で開く。
    // 鍵の束は待たずに渡す（この組み立ては同期で走る）。cloud.json の鍵は readCloudConfig が形を確かめてある。
    // 本文も同じ鍵の束を使う。uploader と設定の同期は今の世代の `/index` の鍵で R2 の鍵名を求め、client が同じ世代で封じる。
    const keyring = cloud ? Keyring.fromConfig(cloud) : null;
    // 名簿の印の行と知らない世代の行を受けたら、keybox と名簿を読み直す（sync/roster.ts）。
    // 新しい世代の鍵が届いたら、飛ばした行と本文の区切りを巻き戻す（どちらも走っている pull の終わりを待つので、ここでは待たない）。
    let onKeysGained = (): void => {};
    // 名簿と世代の回しは、同じ cloud.json の口で世代鍵と名簿の版を書く。
    const writer = cloud ? cloudWriter(home.home, cloud, () => built) : null;
    const roster = keyring && wire && writer ? new RosterStore(wire, keyring, writer, deviceId) : null;
    const client = keyring && wire ? new SealedCloudClient(wire, keyring, deviceId, roster ? { onRoster: rosterRefresh(roster, () => onKeysGained()) } : {}) : null;
    const engine = new SyncEngine({
      db, deviceId, client, url: cloud?.url ?? null, home: home.home, cloudId: cloud?.cloudId ?? null, language: home.language,
      // 起動のときの cloud.json が古い形式なら、同期の状態にその印を載せる（設定の画面が再構築を案内する）。
      // 版 2 の cloud.json が現れて組み直した Core では cloud があるので立たない。
      legacyConfig: cloud === null && cloudRead.state === 'legacy',
      ...memoLossHandlers({ memoPath: o.memoPath, toast, pruneMemos: () => pruneBackups('memos'), language: home.language }),
    });
    // 設定の「使用量と費用」。
    const cloudUsage = new CloudUsagePoller({ client, isPaused, broadcast: (usage) => hub.broadcast({ type: 'sync.usage', usage }) });
    const uploader = client && keyring
      ? new TranscriptUploader({
          db, deviceId, claudeDir, home: home.home, client, keyring, state: syncState, roster: roster ?? undefined,
          isPaused,
          ...(o.opencodeExport ? { opencode: o.opencodeExport } : {}),
          // Codex（ベータ）の本文は、設定の codexEnabled が入のときだけ上げる。置き場は索引と同じ $CODEX_HOME（無ければ ~/.codex）。
          codex: () => (codexEnabledOf(settings.current) ? { home: defaultCodexHome() } : null),
          onError: (p, m) => console.error('[upload]', p, m),
        })
      : null;
    // 設定の同期。スイッチは settings.json の configBundleSync で、既定は切。
    const configBundle = client && keyring
      ? new ConfigSyncService({
          db, deviceId, deviceName: home.device.name, claudeDir, home: home.home, cloud: client, keyring,
          enabled: () => settings.current.configBundleSync === true && !isPaused(),
          switchedOn: () => settings.current.configBundleSync === true,
          approval: () => (settings.current.configApproval === 'auto' ? 'auto' : 'each'),
          targetSwitches: () => settings.current.configTargets ?? {},
          onError: (m) => console.error('[config-sync]', m),
        })
      : null;
    const puller = client
      ? new RemotePuller({
          db, deviceId, home: home.home, client, state: syncState, language: home.language,
          // ほかの PC の Codex の本文は、この PC で Codex を有効にしているときだけ降ろす。
          codexEnabled: () => codexEnabledOf(settings.current),
          // 画面へは toast を流さない（トーストは操作の結果だけにした）。
          // 諦めた項目は同期の状態（skipped）に残り、画面のベルの一覧が事実からその行を組む。
          onError: (k, m) => { console.error('[pull]', k, m); },
          onDownloaded: () => remoteChanged(),
          // 空きが足りずに止めたときと解けたときは、同期の状態を配り直す。画面が札を出し、注意の一覧に行を足す（presenters/notices.ts）。
          // feed は下で組むが、降ろしは起動の後にしか走らないので、呼ばれる時には組み終わっている。
          onDiskShortChanged: () => feed.broadcastSync(engine.status()),
        })
      : null;
    const feed = createSyncFeed({ hub, puller, uploader, oncePass: () => once.pass.active(), isPaused, cloudUsage, toast });
    const once = createOncePass({ engine, puller, configBundle, uploader, cloudUsage, isPaused, sweepPending: feed.sweep, broadcastSync: feed.broadcastSync, toast, language: home.language });
    engine.on(feed.listener());
    // 他の PC の sessions の行は、索引がどの本文を採るか（写しの行が届いたか、消されたか）に関わる。
    engine.on({ applied: (c) => { if (c.tableName === 'sessions') remoteChanged(); } });
    // 削除の印（session_states.trashed_at）は、受け取った PC が本文をゴミ箱へ移す合図である（sessions/trash.ts）。
    engine.on({ applied: (c) => { if (c.tableName === 'session_states') statesApplied(); } });
    // 引き継ぎの頼みか応答が届いたら、頼まれた側が止めに行き、頼んだ側が応答を読みに行く（sync/takeoverResponder.ts）。
    engine.on({ applied: (c) => { if (c.tableName === 'takeovers' || c.tableName === 'takeover_answers') takeoversApplied(); } });
    // ほかの PC のクイックセッションのプロジェクトや場所の行が届いたら、次の起動を待たずに 1 つにまとめ直す（projects/scratch.ts）。
    engine.on({ applied: followRemoteScratch(db, deviceId, home.home, { onError: (e) => console.error('[sync] 届いたクイックセッションの行をまとめ直せませんでした', e instanceof Error ? e.message : e) }) });
    onKeysGained = () => {
      void engine.rewindSkippedRows();
      void puller?.rewindSkipped().catch((e: unknown) => console.error('[pull] could not rewind skipped files', e instanceof Error ? e.message : e));
    };
    // ゴミ箱の掃除。止まっている間（一時停止、版、解除、上限）は Worker に触らない。走っている回があれば重ねない。
    let trashRunning = false;
    const sweepTrash = client && keyring
      ? async (): Promise<void> => {
          if (trashRunning || isPaused()) return;
          trashRunning = true;
          try {
            await sweepTrashBlobs({ db, client, keyring, deviceId, now: Date.now() });
            // 世代を回した後に上げ直した本文の、古い世代の鍵名。上げた直後に断られた（置いてから 1 時間たっていない）ものをここで拾う。
            await sweepSupersededBlobs({ db, client, keyring, deviceId });
          } catch (e) {
            console.error('[trash-sweep] could not delete old trashed transcripts from the cloud', e instanceof Error ? e.message : e);
          } finally {
            trashRunning = false;
          }
        }
      : null;
    // 参加コードの発行と承認。状態は設定の画面へ、新しいリクエストは右下の通知と OS の通知へ渡す。
    const joinApprover = cloud && wire && roster && keyring
      ? new JoinApprover({ wire, roster, keyring, cloudId: cloud.cloudId, language: home.language, onGained: () => onKeysGained(), ...joinNotifier({ broadcast: (ev) => hub.broadcast(ev), ...(delivery.osNotices ? { osNotices: delivery.osNotices } : {}), language: home.language }) })
      : null;
    // 他の端末の解除と世代の回し。一時停止の間も行う（利用者が頼んだ操作である）。
    // 解除と回しの続きは 1 本の鎖に並べ、2 つの回しを重ねない。
    const rotateDeps: RotateDeps | null = wire && roster && keyring && writer
      ? { client: wire, roster, keyring, state: syncState, cfg: writer, deviceId, onGained: () => onKeysGained() }
      : null;
    let rotating: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = rotating.then(fn, fn);
      rotating = next.catch(() => {});
      return next;
    };
    const retry = rotateDeps
      ? rotationRetrier({
          resume: () => serial(() => resumeRotation(rotateDeps)),
          pending: () => rotationPending(rotateDeps.state, rotateDeps.cfg.read().cloudId),
          timers: { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
        })
      : null;
    // 動いている間の解除が途中で失敗して記録が残ったら、起動のときと同じく 5 分おきに続きを試す（画面は「自動で再試行します」と出す）。
    const revoke = rotateDeps && retry
      ? (id: string): Promise<DeviceOut> =>
          serial(() => revokeMember({ ...rotateDeps, id })).catch((e: unknown) => {
            retry.failed(e);
            throw e;
          })
      : null;
    // スマホの接続（QR を出している間の GET /m/pairings/mine）と、スマホ用の鍵の引き口。
    // 接続し終えたら、受信箱の書き手（boot/mobile.ts）がスマホの有無を知るよう、端末の一覧を 1 回だけ読み直す。
    const phone = wire && roster && keyring
      ? { keys: phoneKeysOf(keyring, roster), pairer: new PhonePairer({ wire, roster, onPaired: () => onPhonePaired() }) }
      : null;
    // リカバリーキーの再発行。新しい鍵ペアは確認までこの中のメモリにだけ置く。
    const recoveryKey = wire && roster && keyring && cloud ? new RecoveryKeyReissuer({ roster, keyring, wire, url: () => cloud.url, state: syncState }) : null;
    // 名簿を書いた後に recovery 宛ての keybox を置けなかった印があれば、pull の度に置き直す（印が無ければ何も送らない）。
    if (recoveryKey) engine.on({ pulled: () => { void recoveryKey.resumePending(); } });
    const c: Core = { cloud, client, roster, phone, joinApprover, recoveryKey, engine, cloudUsage, uploader, configBundle, puller, feed, once, bundleTimer: null, uploadTimer: null, sweepTrash, trashTimers: null, revoke, rotationRetry: retry };
    built = c;
    return c;
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
    // ゴミ箱の掃除は、最初の同期が落ち着いた頃に 1 回、その後は 6 時間に 1 回。
    const sweep = c.sweepTrash;
    if (sweep) {
      c.trashTimers = { first: setTimeout(() => { void sweep(); }, TRASH_SWEEP_FIRST_MS), every: setInterval(() => { void sweep(); }, TRASH_SWEEP_EVERY_MS) };
      c.trashTimers.first.unref();
      c.trashTimers.every.unref();
    }
    // 前の起動で世代の回しが途中で止まっていれば、続きから終わらせる（sync/rotate.ts）。
    // 届かなければ、間を置いて試し直す（解除済みの自分では試し直さない）。記録が無ければ Worker には何も送らない。
    // 接続先の作り直しに失敗して同期が止まっていても（engine の rebuildBlock）、ここは止めない。
    // 記録は書いたときの cloudId を持ち、cloud.json の cloudId と違えば読むときに捨てる（readRotation）ので、前のクラウドへ回しを続けることは無い。
    // 回しが読むのは名簿と keybox と cloud.json の世代鍵で、作り直しが戻す同期の記録（区切りや台帳）には頼らない。
    c.rotationRetry?.start();
  };
  const stopCoreTimers = (c: Core): void => {
    c.joinApprover?.stop();
    c.phone?.pairer.stop();
    if (c.bundleTimer) clearInterval(c.bundleTimer);
    c.cloudUsage.stop();
    if (c.uploadTimer) clearInterval(c.uploadTimer);
    if (c.trashTimers) { clearTimeout(c.trashTimers.first); clearInterval(c.trashTimers.every); }
    c.rotationRetry?.stop();
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

  /** 同期が設定済みで、一時停止でも、版や解除や上限で止まってもおらず、Worker が名乗る版が min に届いているか。 */
  const canCarry = (min: number): boolean => {
    const { client, engine } = core;
    if (!client) return false;
    if (engine.status().paused || engine.compatBlocked() || engine.rebuildBlocked() || engine.revoked() || engine.limitedUntil() !== null) return false;
    return (client.lastWorkerCompat?.() ?? 0) >= min;
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
    onStatesApplied: (cb) => { statesListeners.add(cb); return () => { statesListeners.delete(cb); }; },
    pushNow: async () => { await core.engine.pushNow(); },
    flushSession: async (uuid) => { await core.uploader?.flushSession(uuid); },
    onTakeoversApplied: (cb) => { takeoverListeners.add(cb); return () => { takeoverListeners.delete(cb); }; },
    pullForTakeover: async () => {
      await core.engine.pullNow();
      await core.puller?.pullNow();
    },
    canCarryTakeover: () => canCarry(TAKEOVER_MIN_WORKER_COMPAT),
    canCarryMobile: () => canCarry(MOBILE_MIN_WORKER_COMPAT),
    mobileLink: () => {
      const { cloud, client, phone } = core;
      return cloud && client && phone ? { client, url: cloud.url, phoneKeys: phone.keys, pairer: phone.pairer } : null;
    },
    refetchSession: (uuid) => {
      void core.puller?.refetchSession(uuid).catch((e: unknown) => console.error('[pull]', uuid, e instanceof Error ? e.message : e));
    },
    joinApprover: () => core.joinApprover,
    cloudRevoke: () => core.revoke,
    recoveryKey: () => core.recoveryKey,
    cloudDevices: readCloudDevices,
    onCloudDevices: (cb) => { cloudDeviceListeners.add(cb); return () => { cloudDeviceListeners.delete(cb); }; },
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
