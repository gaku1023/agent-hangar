import os from 'node:os';
import path from 'node:path';
import { codexInjectionOf, opencodeInjectionOf, PRIMARY_ACCOUNT_ID, type CompatDto, type ReadinessDto, type ShellHookDto, type WorkspaceTrustDto } from '@agent-hangar/shared';
import { AccountAuth } from '../provider/claude-code/config/accountAuth.ts';
import { AccountStore } from '../config/accounts.ts';
import { claudeJsonFor, claudeJsonPath } from '../provider/claude-code/config/claudeJson.ts';
import { trustBeforeLaunch, trustedWorkspaceOf, trustWorkspaceFolders } from '../projects/folderTrust.ts';
import { DEVICE_TOUCH_MS, measureShellHook, touchDevice } from '../config/devicePresence.ts';
import type { Settings } from '../config/paths.ts';
import { createReadiness } from '../config/readiness.ts';
import { bundledHangarIn, createShellWrap } from '../config/shellWrap.ts';
import { createExternalApi } from '../external/api.ts';
import { folderCandidates } from '../projects/candidates.ts';
import { currentEditor, defaultEditorHost } from '../external/editors.ts';
import { announceAccountsOnRunStarted, buildAccountsDto, type AccountsDeps } from '../http/accounts.ts';
import type { ExternalApi } from '../http/deps.ts';
import { ClaudeDirWatch } from '../provider/claude-code/compat/claudeDir.ts';
import { remoteControlRefusal } from '../provider/claude-code/launch/remoteControl.ts';
import { claudeBinOf, LocalClaude } from '../provider/claude-code/compat/localClaude.ts';
import { readRegistry } from '../provider/claude-code/registry.ts';
import { RunAccounts } from '../runs/accounts.ts';
import { LaunchPreps } from '../runs/launchPrep.ts';
import { RunManager } from '../runs/manager.ts';
import { createLiveChangeHandler } from '../sessions/liveChange.ts';
import { OVERLAP_TICK_MS, OverlapWatch } from '../sessions/overlap.ts';
import { hasMarkedIdle, ParkWatch, parkedSessionIds } from '../sessions/park.ts';
import { setParkingSwitch } from '../db/queries.ts';
import { paceNotices, StopNoticeWatch } from '../sessions/stopNotices.ts';
import { paneOpsFor, type PaneOps } from '../tmux/pane.ts';
import { HANGAR_SOCKET, hangarMux, type MuxServers } from '../tmux/servers.ts';
import { accountOfProviderSession } from '../usage/accountOf.ts';
import { AgentUsageTracker } from '../usage/agentUsage.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { createCodexUsage, type CodexUsage } from '../provider/codex/usage.ts';
import { touchRow } from '../db/notify.ts';
import type { DeliveryParts } from './delivery.ts';
import type { HomeParts } from './home.ts';
import { AGENT_ENTRY } from '../agent/entry.ts';

/** run の出入りや登録の変化の後（RunManager.stir）に、tmux の一覧を見て run の終了を拾う間隔。 */
const RUN_POLL_MS = 2000;
/**
 * 何も出入りしない間の、tmux の一覧を見る間隔（2026-10-14、0.6.1）。
 * claude の終わりは登録の変化で stir されるので、この周期が拾うのは見ていないシェルタブの exit と、tmux のサーバごと落ちたことだけである。
 */
const RUN_IDLE_POLL_MS = 10_000;
/** 休みの見張りの間隔。 */
const PARK_POLL_MS = 2000;

/**
 * 設定の tmux のパスから、tmux の口を作る。パスが無ければ null で、起動は使えない。
 * 新しい画面は hangar の専用のサーバ（-L hangar）に作り、前の版が既定のサーバに作った画面は終わるまでそこで扱う（tmux/servers.ts）。
 */
export function tmuxOf(s: Pick<Settings, 'tmuxPath'>): MuxServers | null {
  return s.tmuxPath ? hangarMux(s.tmuxPath) : null;
}
/** RunManager が画面に触る口。裏は macOS と Linux では tmux、Windows では psmux である。 */
export function panesOf(t: MuxServers | null): PaneOps | null {
  return t ? paneOpsFor(t) : null;
}

export type RunsParts = {
  runs: RunManager;
  usage: UsageTracker;
  /** Claude 以外のエージェント（Codex）の枠。設定で切の間は何も持たない。AccountsDto.agents に載る。 */
  agentUsage: AgentUsageTracker;
  /** Codex の使用量の読み手。hangar が起こした会話の app-server の接続を track し、外の会話の rollout の枠を noteRolloutRateLimits で受ける（配線は B3a と B5 が入ってから）。 */
  codexUsage: CodexUsage;
  /** アカウントの HTTP と、起動後の認証の読み直しが、同じ組み立てを使う。 */
  accounts: AccountsDeps;
  /** 作業フォルダのフォルダの信頼を、登録したアカウントの全部の .claude.json に書く（POST /api/workspace/trust）。 */
  trustWorkspace(root: string, dryRun: boolean): WorkspaceTrustDto;
  /** いまの claude の場所。 */
  claudeBin(): string | null;
  /** 手元の claude を裏で読む係。claude のパスが変わったら、呼び手が読み直させる。 */
  localClaude: LocalClaude;
  /** 包みの本体を書き直す。tmux のパスが変わったときに呼ぶ。 */
  writeShellScript(): void;
  /** いまの tmux の口。run の起動と見張り、外のターミナル、端末の中継が同じものを使う。 */
  mux(): MuxServers | null;
  /** 設定の tmux のパスが変わったときに、口を作り直して RunManager に渡す。作り直した口を返す（端末の中継にも渡す）。 */
  applyTmux(s: Pick<Settings, 'tmuxPath'>): MuxServers | null;
  /** 包み方のこの PC の状態を測る。前に刻んだ値と違えば devices を刻み直す。 */
  shellHook(): ShellHookDto;
  external: ExternalApi;
  readiness(): Promise<ReadinessDto>;
  compat(): Promise<CompatDto>;
  /** 実行中の一覧の最初の読み取りを覚える。最初の読み取りは onChange を通らない。通知の見張りも、このときの入力待ちと使用制限を知らせ終えたものとして覚える。 */
  primeLive(): void;
  /** 前回の終了時に生きていた run の回復と、run の終了の見張り、休みの見張りを始める。 */
  start(): void;
  /** 自端末の生存を devices に刻み、周期で刻み続ける。 */
  startPresence(): void;
  /** 同じファイルの編集の見張り。「このファイルでは表示しない」の後に、すぐ読み直させる。 */
  overlaps: OverlapWatch;
  /** 休みの見張り、デスクトップ通知の見張り、同じファイルの編集の見張りの周期を止める。 */
  stopParkTimer(): void;
  /** 生存の刻みの周期を止める。 */
  stopPresence(): void;
};

/**
 * セッションを起こして見張る持ち場を組む。
 * 組むのは、tmux の口、手元の claude の読み取り、包みの本体、アカウント、RunManager、休みの見張り、使用量、外のターミナルとエディタである。
 * 実際のポート番号を包みの本体と run の起動が使うので、待ち受けの後に呼ぶ。
 * serverDir は、サーバの入口のファイルがある場所である。同梱の hangar をその隣から探す。
 * launcher は Windows の殻の実行ファイルで、外のターミナルとエディタとブラウザを Hangar のジョブの外で起こすのに使う。
 */
export function bootRuns(
  home: Pick<HomeParts, 'home' | 'token' | 'db' | 'device' | 'claudeDir' | 'settings' | 'language' | 'life'>,
  delivery: Pick<DeliveryParts, 'hub' | 'live' | 'agents' | 'claude' | 'bindCodexUsage' | 'compatLog' | 'claudeVersion' | 'osNotices'>,
  listening: { host: string; port: number },
  o: { serverDir: string; launcher?: string },
): RunsParts {
  const { db, claudeDir, settings, life, device } = home;
  const { hub, live, compatLog } = delivery;
  const claudeBin = (): string | null => claudeBinOf(settings.current);
  const localClaude: LocalClaude = new LocalClaude({
    bin: claudeBin, closed: () => life.closed, version: delivery.claudeVersion, log: compatLog,
    // 呼ばれるのは版の読み取りを待った後なので、下で作る claudeDirWatch はもうできている。
    renote: () => { delivery.claude.live.renoteDrifts(); claudeDirWatch.reset(); claudeDirWatch.check(); },
    onSubcommands: () => shell.write(),
    beforeList: () => claudeDirWatch.check(),
  });
  const bundledHangar = bundledHangarIn(o.serverDir);
  const shell = createShellWrap({ home: home.home, host: listening.host, port: listening.port, tmuxPath: () => settings.current.tmuxPath, subcommands: () => localClaude.subcommands, bundledHangar,
    // opencode の包みは組み込みの一覧で書く（opencode --help はまだ読まない）。知らないサブコマンドはディレクトリでない位置引数として素通しになる。
    opencode: () => (AGENT_ENTRY.opencode.enabled(settings.current) && AGENT_ENTRY.opencode.intercept(settings.current) ? {} : null),
    // codex の包みも組み込みの一覧で書く。知らないサブコマンドは 2 つ目のプロンプトか、hangar が断って素通しになる。
    codex: () => (AGENT_ENTRY.codex.enabled(settings.current) && AGENT_ENTRY.codex.intercept(settings.current) ? {} : null) });
  // 起動のたびと claude のパスを変えたときに、claude --help と --version を裏で読み直す。
  shell.write();
  void localClaude.refreshSubcommands();
  void localClaude.refreshVersion();
  // Claude Code のアカウント。置き場ごとのログインを切り替えるだけで、認証の中身は持たない。
  const accountStore = new AccountStore({ home: home.home, primaryDir: claudeDir });
  const accountAuth = new AccountAuth({ claudeBin, compat: compatLog });
  // 認証は、画面がアカウントを読むとき（GET /api/accounts）にも読むが、組んだときにも裏で 1 回読んでおく。
  // 画面を開かずに起こした会話（スマホからの起動など）でも、--remote-control を付けてよいかを判定できるようにするためである。
  for (const a of accountStore.list()) accountAuth.ensureChecked(a);
  // 2 つ目以降のアカウントの置き場に、Claude Code が新しい項目を足していないかを見る。起動のときと、準備の確かめ（GET /api/readiness）か GET /api/compat を読むたびに見る。
  const claudeDirWatch = new ClaudeDirWatch({ dirs: () => accountStore.list().filter((a) => a.id !== PRIMARY_ACCOUNT_ID).map((a) => a.dir), sink: compatLog });
  claudeDirWatch.check();
  // どの画面が前の版の既定のサーバに居るかを、この口が覚える。起動の見張り、外のターミナル、端末の中継で同じ口を使う。
  let mux = tmuxOf(settings.current);
  const runs = new RunManager({
    db, deviceId: device.id, home: home.home, panes: panesOf(mux), muxPath: () => settings.current.tmuxPath, port: listening.port, token: home.token,
    claudeBin: claudeBin(),
    // 起動に失敗した run の後始末で、本文の jsonl があるかを実体で確かめるために要る。
    claudeDir,
    // hangar の外で動いている Claude を再開すると二重起動になるので、実行中の一覧を見て弾く。
    // 引き取りと attach も、ここから外で動く claude の pid とバックグラウンドの id を引く。
    live,
    // driver は配る層と一緒に組んである（boot/agents.ts）。
    agents: delivery.agents, claude: delivery.claude,
    accounts: new RunAccounts({ db, claudeDir, store: accountStore, deviceId: device.id }),
    compat: compatLog,
    // Claude に渡す指示とシェルタブの名前を、設定の言語で出す。
    language: home.language,
    // 足す段の入り切り（設定の askStatusAtEnd と liveHints）と、opencode と Codex に足す量（opencodeInjection、codexInjection）。起動のたびに今の設定を読む。
    injection: () => ({ askStatusAtEnd: settings.current.askStatusAtEnd !== false, liveHints: settings.current.liveHints !== false, opencode: opencodeInjectionOf(settings.current), codex: codexInjectionOf(settings.current) }),
    // opencode（ベータ）は設定で有効にしたときだけ起こす。場所は起こすたびに探す（PATH、~/.opencode/bin、既知の置き場）。
    agentEnabled: (kind) => AGENT_ENTRY[kind].enabled(settings.current),
    // 外のターミナルの opencode（シェルの包み）を受けるか。包みの本体を書き直す前に開いていたターミナルからの頼みも、ここで断る。
    terminalIntercept: (kind) => AGENT_ENTRY[kind].intercept(settings.current),
    agentBin: (kind) => AGENT_ENTRY[kind].bin(),
    // 設定の「Remote Control を付けて起動する」（remoteControl）で足す --remote-control。足してよいかは、起こすアカウントの認証と、claude を起こす環境で決める。
    // 環境は、このサーバの環境に、アカウントの置き場を足した後のもの（runs/manager.ts）を重ねる。
    // accountAuth.get は最初の読み取りが済むまで null を返す。そのときは意図して --remote-control を付けずに起こす（安全な側）。
    // 手元の claude の --help に --remote-control が無い（古い claude）か、まだ読めていないときも付けない。
    // 付けないときは、どの条件で落ちたかを 1 行だけ残す（秘密は含まない）。認証をまだ読めていなければ、次の起動に間に合うよう裏で読ませる。
    remoteControl: ({ account, env }) => {
      const id = account?.id ?? PRIMARY_ACCOUNT_ID;
      const why = remoteControlRefusal({ enabled: settings.current.remoteControl !== false, supported: localClaude.remoteControlSupported(), auth: accountAuth.get(id), env: { ...process.env, ...env } });
      if (why === null) return true;
      if (why === 'auth-unknown') { const a = accountStore.get(id); if (a) accountAuth.ensureChecked(a); }
      console.log(`[runs] launching without --remote-control (${why}, account ${id})`);
      return false;
    },
    // クイックセッションの置き場と、同意を得た作業フォルダでは、起こすアカウントの .claude.json へ前もってフォルダの信頼を書く。
    // 起動前の準備（LM Studio のモデル）の進みを、起動の鍵ごとに画面へ配る。
    preps: new LaunchPreps({ broadcast: (ev) => { hub.broadcast(ev); } }),
    trustFolder: (configDir, cwd) => { trustBeforeLaunch({ hangarHome: home.home, homeDir: os.homedir(), trustedWorkspace: () => trustedWorkspaceOf(settings.current) }, configDir, cwd); },
  });
  // 区切り（Done、Archived）を付けたセッションが休みになったら、Claude を止める。Paused は戻ってくる会話なので止めない。
  // 止める候補があれば、登録は写しではなく、その場で読み直す。打ったばかりの発言で作業中に変わった会話を、古い写しのまま止めないためである。
  // 読めなかったときは、何も止めない。
  const parkWatch = new ParkWatch({
    // 写しに候補（Done か Archived の付いた休みの会話）が無ければ、登録を読み直さない。待機中に 2 秒ごとに読まないためである。
    // Claude は登録を読み直し、opencode は状態の面の写し（serve の出来事の流れで持つので、読み直すものが無い）を足す。
    parkedIds: () => { try { return hasMarkedIdle(db, live.current()) ? parkedSessionIds(db, [...readRegistry(claudeDir), ...delivery.agents.of('opencode').live.current()], device.id) : []; } catch { return []; } },
    stop: (id) => runs.park(id),
    // 設定の「Done と Archived にした会話を止める」。切っている間は止めず、一覧でも実行中として見せる（setParkingSwitch）。
    enabled: () => settings.current.autoPark !== false,
  });
  setParkingSwitch(db, () => settings.current.autoPark !== false);
  const usage = new UsageTracker(db, {
    accountOf: (providerSessionId) => accountOfProviderSession({ db, hasAccount: (id) => !!accountStore.get(id), deviceId: device.id }, providerSessionId),
    compat: compatLog,
  });
  const codexOn = (): boolean => AGENT_ENTRY.codex.enabled(settings.current);
  const agentUsage = new AgentUsageTracker({ enabled: codexOn });
  const codexUsage = createCodexUsage({
    db, tracker: agentUsage, enabled: codexOn, log: (l) => console.error(l),
    // 会話の文脈とモデルが変わった。行は変わらないが中身が変わるので、名指しして配り直してもらう。
    onStats: (providerSessionId) => {
      const s = db.prepare("select id from sessions where provider = 'codex' and provider_session_id = ? and deleted_at is null").get(providerSessionId) as { id: string } | undefined;
      if (s) touchRow(db, 'sessions', s.id);
    },
  });
  // 起こした Codex の会話の接続から、枠と文脈を読ませる（driver が track と untrack を呼ぶ）。
  delivery.bindCodexUsage(codexUsage);
  const accounts: AccountsDeps = {
    db, store: accountStore, auth: accountAuth, usage, agentUsage, runs, primaryDir: claudeDir, deviceId: device.id,
    broadcast: (dto) => hub.broadcast({ type: 'accounts.update', accounts: dto }),
  };
  // 認証を読み終えたとき、ログインが始まって終わったときに、画面へ配る。
  accountAuth.setOnChange(() => accounts.broadcast(buildAccountsDto(accounts)));
  // Codex の枠が変わったときも、同じ道（accounts.update）で配る。
  agentUsage.onChange(() => accounts.broadcast(buildAccountsDto(accounts)));
  // 起動のたびに、セッションとアカウントの対応を配る。
  announceAccountsOnRunStarted(runs, accounts);
  const liveChange = createLiveChangeHandler({ db, deviceId: device.id, hub, resetPark: (id) => parkWatch.reset(id), linkRegistry: (live) => runs.linkRegistry(live) });
  live.onChange(liveChange.onChange);
  // 同じファイルの編集の見張り。作業中だったかを、登録の状態の移り変わりから覚える。
  const overlaps = new OverlapWatch({ db, live: () => live.current() });
  live.onChange((l) => overlaps.noteLive(l));
  // デスクトップ通知のきっかけ（入力待ち、許可待ち、使用制限、リセット済み）。殻が GET /api/notify/feed で読む。
  const stopNotices = new StopNoticeWatch({
    db, deviceId: device.id, live: () => live.current(), language: home.language, feed: delivery.osNotices,
    accountOf: (providerSessionId) => accountOfProviderSession({ db, hasAccount: (id) => !!accountStore.get(id), deviceId: device.id }, providerSessionId),
  });
  // 待っているもの（問いの文、許可の中身）がある間だけ短い周期で見る。登録が変わったときはその場で見る（paceNotices）。
  const notices = paceNotices(stopNotices);
  live.onChange(() => notices.onLiveChange());
  const touch = (): void => touchDevice({ db, device, shellHook: shell.hook });
  let parkTimer: ReturnType<typeof setInterval> | null = null;
  let overlapTimer: ReturnType<typeof setInterval> | null = null;
  let deviceTimer: ReturnType<typeof setInterval> | null = null;
  return {
    runs, usage, agentUsage, codexUsage, accounts, claudeBin, localClaude, overlaps,
    // 最初のアカウントは CLAUDE_CONFIG_DIR を付けずに起こすので、ホームの直下の .claude.json を読む（RunAccounts.envFor）。
    trustWorkspace: (root, dryRun) => trustWorkspaceFolders({
      root, dryRun, backupDir: path.join(home.home, 'backups'),
      files: accountStore.list().map((a) => claudeJsonFor(a.id === PRIMARY_ACCOUNT_ID ? null : a.dir, os.homedir())),
    }),
    writeShellScript: shell.write,
    mux: () => mux,
    applyTmux: (s) => {
      mux = tmuxOf(s);
      runs.setPanes(panesOf(mux));
      return mux;
    },
    shellHook: () => measureShellHook({ db, deviceId: device.id, shellHook: shell.hook, touch }),
    // 設定は書き替わるので、外部連携は呼ばれた時点の settings を読む。
    external: createExternalApi({
      home: home.home, settings: () => settings.current, launcher: o.launcher, language: home.language,
      // 外のターミナルも、そのセッションが居るサーバへつなぐ。
      socketArgs: (tmuxName) => mux?.serverOf(tmuxName).args() ?? ['-L', HANGAR_SOCKET],
      // ターミナルの中のエディタは、そのセッションの実行中の run のシェルタブで開く。run が無ければ外部ターミナルで開く。
      openShellTab: ({ sessionId, argv, title }) => {
        const run = runs.listAlive().runs.find((r) => r.sessionId === sessionId && r.endedAt === null && r.deviceId === device.id);
        if (!run) return false;
        runs.openTab(run.id, { then: argv, title });
        return true;
      },
    }),
    // 準備の確かめ。設定画面とホームの帯の始める前の確認が読む。版を読む子プロセスは 3 秒で切る。
    readiness: createReadiness({
      settings: () => settings.current, claudeDir, claudeJson: claudeJsonPath(), db, deviceId: device.id,
      shellCommand: shell.installCommand,
      compatDriftCount: () => { claudeDirWatch.check(); return compatLog.count(); },
      // /api/compat と同じ引き方で読み、同じ版の覚えを使う。
      // 道具の claude の行は準備の確かめが自分の覚えで読むので、同じ claude でもそれぞれ 1 度は起こす。
      compatLocalVersion: localClaude.refreshVersion,
      // 選んだエディタで開けるか（始める前の確認のエディタの行）。版は読まない。
      editor: async () => currentEditor(settings.current.editor, defaultEditorHost()),
      // 始める前の確認の「プロジェクト」の行。プロジェクトが 1 件も無いときだけ、会話したフォルダの候補を数える。
      candidateCount: () => folderCandidates(db, device.id, { hangarHome: home.home, workspaceRoot: settings.current.workspaceRoot }).candidates.length,
    }),
    compat: localClaude.compat,
    primeLive: () => {
      liveChange.prime(live.current());
      // 最初の読み取りは onChange を通らないので、生きた run の最後の状態と、状態の移り変わりもここで覚える。
      runs.noteLastLive(live.current());
      overlaps.noteLive(live.current());
      notices.onLiveChange();
    },
    start() {
      // 前回の終了時に生きていた run のうち、tmux セッションが残っていないものを lost で閉じる。
      const lost = runs.recoverAtStartup();
      if (lost.length) console.log(`[runs] tmux セッションの無い run を ${lost.length} 件 lost で閉じました`);
      runs.startPolling(RUN_POLL_MS, RUN_IDLE_POLL_MS);
      parkTimer = setInterval(() => {
        try {
          const stopped = parkWatch.tick();
          if (stopped.length) console.log(`[park] 区切りを付けて休みになったセッションを ${stopped.length} 件止めました`);
        } catch (e) {
          console.error('[park]', e instanceof Error ? e.message : e);
        }
      }, PARK_POLL_MS);
      parkTimer.unref();
      overlapTimer = setInterval(() => {
        try {
          overlaps.tick();
        } catch (e) {
          console.error('[overlap]', e instanceof Error ? e.message : e);
        }
      }, OVERLAP_TICK_MS);
      overlapTimer.unref();
      notices.start();
    },
    startPresence() {
      touch();
      deviceTimer = setInterval(touch, DEVICE_TOUCH_MS);
      deviceTimer.unref();
    },
    stopParkTimer() {
      if (parkTimer) clearInterval(parkTimer);
      if (overlapTimer) clearInterval(overlapTimer);
      notices.stop();
    },
    stopPresence() { if (deviceTimer) clearInterval(deviceTimer); },
  };
}
