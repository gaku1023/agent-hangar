import { PRIMARY_ACCOUNT_ID, type CompatDto, type ReadinessDto, type ShellHookDto } from '@agent-hangar/shared';
import { AccountAuth } from '../config/accountAuth.ts';
import { AccountStore } from '../config/accounts.ts';
import { claudeJsonPath } from '../config/claudeJson.ts';
import { DEVICE_TOUCH_MS, measureShellHook, touchDevice } from '../config/devicePresence.ts';
import type { Settings } from '../config/paths.ts';
import { createReadiness } from '../config/readiness.ts';
import { bundledHangarIn, createShellWrap } from '../config/shellWrap.ts';
import { createExternalApi } from '../external/api.ts';
import { announceAccountsOnRunStarted, buildAccountsDto, type AccountsDeps } from '../http/accounts.ts';
import type { ExternalApi } from '../http/deps.ts';
import { ClaudeDirWatch } from '../provider/claude-code/compat/claudeDir.ts';
import { claudeBinOf, LocalClaude } from '../provider/claude-code/compat/localClaude.ts';
import { readRegistry } from '../provider/claude-code/registry.ts';
import { RunAccounts } from '../runs/accounts.ts';
import { RunManager } from '../runs/manager.ts';
import { createLiveChangeHandler } from '../sessions/liveChange.ts';
import { ParkWatch, parkedSessionIds } from '../sessions/park.ts';
import { tmuxPaneOps, type PaneOps } from '../tmux/pane.ts';
import { Tmux } from '../tmux/tmux.ts';
import { accountOfProviderSession } from '../usage/accountOf.ts';
import { UsageTracker } from '../usage/statusline.ts';
import type { DeliveryParts } from './delivery.ts';
import type { HomeParts } from './home.ts';

/** tmux の一覧を見て run の終了を拾う間隔。 */
const RUN_POLL_MS = 2000;

/** 設定の tmux のパスから、tmux の口を作る。パスが無ければ null で、起動は使えない。 */
export function tmuxOf(s: Pick<Settings, 'tmuxPath'>): Tmux | null {
  return s.tmuxPath ? new Tmux({ tmuxPath: s.tmuxPath }) : null;
}
/** RunManager が画面に触る口。いまの裏は tmux である。 */
export function panesOf(t: Tmux | null): PaneOps | null {
  return t ? tmuxPaneOps(t) : null;
}

export type RunsParts = {
  runs: RunManager;
  usage: UsageTracker;
  /** アカウントの HTTP と、起動後の認証の読み直しが、同じ組み立てを使う。 */
  accounts: AccountsDeps;
  /** いまの claude の場所。 */
  claudeBin(): string | null;
  /** 手元の claude を裏で読む係。claude のパスが変わったら、呼び手が読み直させる。 */
  localClaude: LocalClaude;
  /** 包みの本体を書き直す。tmux のパスが変わったときに呼ぶ。 */
  writeShellScript(): void;
  /** 包み方のこの PC の状態を測る。前に刻んだ値と違えば devices を刻み直す。 */
  shellHook(): ShellHookDto;
  external: ExternalApi;
  readiness(): Promise<ReadinessDto>;
  compat(): Promise<CompatDto>;
  /** 実行中の一覧の最初の読み取りを覚える。最初の読み取りは onChange を通らない。 */
  primeLive(): void;
  /** 前回の終了時に生きていた run の回復と、run の終了の見張り、休みの見張りを始める。 */
  start(): void;
  /** 自端末の生存を devices に刻み、周期で刻み続ける。 */
  startPresence(): void;
  /** 休みの見張りの周期を止める。 */
  stopParkTimer(): void;
  /** 生存の刻みの周期を止める。 */
  stopPresence(): void;
};

/**
 * セッションを起こして見張る持ち場を組む。
 * 組むのは、tmux の口、手元の claude の読み取り、包みの本体、アカウント、RunManager、休みの見張り、使用量、外のターミナルとエディタである。
 * 実際のポート番号を包みの本体と run の起動が使うので、待ち受けの後に呼ぶ。
 * serverDir は、サーバの入口のファイルがある場所である。同梱の hangar をその隣から探す。
 */
export function bootRuns(
  home: Pick<HomeParts, 'home' | 'token' | 'db' | 'device' | 'claudeDir' | 'settings' | 'language' | 'life'>,
  delivery: Pick<DeliveryParts, 'hub' | 'registry' | 'compatLog' | 'claudeVersion'>,
  listening: { host: string; port: number },
  o: { serverDir: string },
): RunsParts {
  const { db, claudeDir, settings, life, device } = home;
  const { hub, registry, compatLog } = delivery;
  const claudeBin = (): string | null => claudeBinOf(settings.current);
  const localClaude: LocalClaude = new LocalClaude({
    bin: claudeBin, closed: () => life.closed, version: delivery.claudeVersion, log: compatLog,
    // 呼ばれるのは版の読み取りを待った後なので、下で作る claudeDirWatch はもうできている。
    renote: () => { registry.renoteDrifts(); claudeDirWatch.reset(); claudeDirWatch.check(); },
    onSubcommands: () => shell.write(),
    beforeList: () => claudeDirWatch.check(),
  });
  const bundledHangar = bundledHangarIn(o.serverDir);
  const shell = createShellWrap({ home: home.home, host: listening.host, port: listening.port, tmuxPath: () => settings.current.tmuxPath, subcommands: () => localClaude.subcommands, bundledHangar });
  // 起動のたびと claude のパスを変えたときに、claude --help と --version を裏で読み直す。
  shell.write();
  void localClaude.refreshSubcommands();
  void localClaude.refreshVersion();
  // Claude Code のアカウント。置き場ごとのログインを切り替えるだけで、認証の中身は持たない。
  const accountStore = new AccountStore({ home: home.home, primaryDir: claudeDir });
  const accountAuth = new AccountAuth({ claudeBin, compat: compatLog });
  // 2 つ目以降のアカウントの置き場に、Claude Code が新しい項目を足していないかを見る。起動のときと、準備の確かめ（GET /api/readiness）か GET /api/compat を読むたびに見る。
  const claudeDirWatch = new ClaudeDirWatch({ dirs: () => accountStore.list().filter((a) => a.id !== PRIMARY_ACCOUNT_ID).map((a) => a.dir), sink: compatLog });
  claudeDirWatch.check();
  const runs = new RunManager({
    db, deviceId: device.id, home: home.home, panes: panesOf(tmuxOf(settings.current)), port: listening.port, token: home.token,
    claudeBin: claudeBin(),
    // 起動に失敗した run の後始末で、本文の jsonl があるかを実体で確かめるために要る。
    claudeDir,
    // hangar の外で動いている Claude を再開すると二重起動になるので、レジストリを見て弾く。
    isLive: (providerSessionId) => registry.current().some((l) => l.sessionId === providerSessionId),
    // 引き取りと attach が、外で動く claude の pid とバックグラウンドの id を引く。
    live: () => registry.current(),
    accounts: new RunAccounts({ db, claudeDir, store: accountStore }),
    compat: compatLog,
    // Claude に渡す指示とシェルタブの名前を、設定の言語で出す。
    language: home.language,
  });
  // 区切り（Paused、Done、Archived）を付けたセッションが休みになったら、Claude を止める。
  // 登録は 500 ミリ秒ごとの写しではなく、その場で読み直す。打ったばかりの発言で作業中に変わった会話を、古い写しのまま止めないためである。
  // 読めなかったときは、何も止めない。
  const parkWatch = new ParkWatch({
    parkedIds: () => { try { return parkedSessionIds(db, readRegistry(claudeDir), device.id); } catch { return []; } },
    stop: (id) => runs.park(id),
  });
  const usage = new UsageTracker(db, {
    accountOf: (providerSessionId) => accountOfProviderSession({ db, hasAccount: (id) => !!accountStore.get(id) }, providerSessionId),
    compat: compatLog,
  });
  const accounts: AccountsDeps = {
    db, store: accountStore, auth: accountAuth, usage, runs, primaryDir: claudeDir,
    broadcast: (dto) => hub.broadcast({ type: 'accounts.update', accounts: dto }),
  };
  // 認証を読み終えたとき、ログインが始まって終わったときに、画面へ配る。
  accountAuth.setOnChange(() => accounts.broadcast(buildAccountsDto(accounts)));
  // 起動のたびに、セッションとアカウントの対応を配る。
  announceAccountsOnRunStarted(runs, accounts);
  const liveChange = createLiveChangeHandler({ db, deviceId: device.id, hub, resetPark: (id) => parkWatch.reset(id), linkRegistry: (live) => runs.linkRegistry(live) });
  registry.onChange(liveChange.onChange);
  const touch = (): void => touchDevice({ db, device, shellHook: shell.hook });
  let parkTimer: ReturnType<typeof setInterval> | null = null;
  let deviceTimer: ReturnType<typeof setInterval> | null = null;
  return {
    runs, usage, accounts, claudeBin, localClaude,
    writeShellScript: shell.write,
    shellHook: () => measureShellHook({ db, deviceId: device.id, shellHook: shell.hook, touch }),
    // 設定は書き替わるので、外部連携は呼ばれた時点の settings を読む。
    external: createExternalApi({ home: home.home, settings: () => settings.current }),
    // 準備の確かめ。設定画面と空のホームが読む。版を読む子プロセスは 3 秒で切る。
    readiness: createReadiness({
      settings: () => settings.current, claudeDir, claudeJson: claudeJsonPath(), db, deviceId: device.id,
      shellCommand: shell.installCommand,
      compatDriftCount: () => { claudeDirWatch.check(); return compatLog.count(); },
      // /api/compat と同じ引き方で読み、同じ版の覚えを使う。
      // 道具の claude の行は準備の確かめが自分の覚えで読むので、同じ claude でもそれぞれ 1 度は起こす。
      compatLocalVersion: localClaude.refreshVersion,
    }),
    compat: localClaude.compat,
    primeLive: () => liveChange.prime(registry.current()),
    start() {
      // 前回の終了時に生きていた run のうち、tmux セッションが残っていないものを lost で閉じる。
      const lost = runs.recoverAtStartup();
      if (lost.length) console.log(`[runs] tmux セッションの無い run を ${lost.length} 件 lost で閉じました`);
      runs.startPolling(RUN_POLL_MS);
      parkTimer = setInterval(() => {
        try {
          const stopped = parkWatch.tick();
          if (stopped.length) console.log(`[park] 区切りを付けて休みになったセッションを ${stopped.length} 件止めました`);
        } catch (e) {
          console.error('[park]', e instanceof Error ? e.message : e);
        }
      }, RUN_POLL_MS);
      parkTimer.unref();
    },
    startPresence() {
      touch();
      deviceTimer = setInterval(touch, DEVICE_TOUCH_MS);
      deviceTimer.unref();
    },
    stopParkTimer() { if (parkTimer) clearInterval(parkTimer); },
    stopPresence() { if (deviceTimer) clearInterval(deviceTimer); },
  };
}
