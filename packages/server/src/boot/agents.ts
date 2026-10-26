import { agentsOf, type Agents } from '../agent/agents.ts';
import { localContextOf, opencodePermissionPresetOf, providerPrepsOf, type LiveSessionDto } from '@agent-hangar/shared';
import { RUN_DROPPED_ENV, AGENT_RUN_DROPPED_ENV } from '../launch/env.ts';
import { ensureHookScript } from '../launch/hookScript.ts';
import { remoteRoot } from '../config/cloud.ts';
import type { CompatLog } from '../provider/claude-code/compat/log.ts';
import { claudeBinOf } from '../provider/claude-code/compat/localClaude.ts';
import { VERIFIED_CLAUDE_VERSION } from '../provider/claude-code/compat/version.ts';
import { claudeLiveSource, createClaudeDriver, type ClaudeDriver, type ClaudeLiveSource } from '../provider/claude-code/driver.ts';
import { realProcOpsWith, type ProcOps } from '../provider/claude-code/process/procs.ts';
import { claudeTranscriptSource, type ClaudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import type { GetLanguage } from '../i18n/language.ts';
import { createCodexDriver, type CodexDriver } from '../provider/codex/driver.ts';
import { createCodexLive } from '../provider/codex/live.ts';
import { findCodex } from '../config/tools.ts';
import { createOpencodeDriver, type OpencodeDriver } from '../provider/opencode/driver.ts';
import type { OpencodeServes } from '../provider/opencode/launch.ts';
import { permissionPresetFor } from '../provider/opencode/permissionPreset.ts';
import { ProviderPreps } from '../provider/opencode/providerPrep.ts';
import { msg, render } from '../i18n/message.ts';
import { safeErrorText } from '../runs/manager.ts';
import type { HomeParts } from './home.ts';

/** 作業中があるか、登録のディレクトリを見張れない間の、登録の読み直しの間隔。 */
export const REGISTRY_POLL_MS = 500;
/**
 * 見張れていて作業中が 1 つも無い間の、登録の読み直しの間隔。
 * 変化は見張りの知らせで拾うので、この周期が拾うのは、Windows で止められた claude の pid が消えたこと（登録が残る）と、見張りの取りこぼしである。
 */
export const REGISTRY_IDLE_MS = 2000;

export type AgentParts = {
  /** sessions.provider の値から driver を引く口。 */
  agents: Agents;
  /** Claude の driver。attach や登録のずれの数え直しのような、Claude にしか無いものに直に使う。 */
  claude: ClaudeDriver;
  /** opencode（ベータ）の driver。起こすかどうかは設定（opencodeEnabled）で RunManager が決める。 */
  opencode: OpencodeDriver;
  /**
   * Codex（ベータ）の driver。起動の面だけを持ち（状態、許可・質問、トランスクリプトの面は空）、起こすかどうかは設定（codexEnabled）で RunManager が決める。
   * 配る層（LiveHub、索引）にはまだ載せない。載せるのは段 B の後続（B4、B5）である。
   */
  codex: CodexDriver;
  /**
   * opencode の serve の管理（boot/opencode.ts）を driver に渡す。
   * serve の管理は、前の hangar が残した serve の掃除を待ち受けの後に始めるので、配る層より後で組む。それまでの起動は断る。
   */
  bindOpencodeServes(serves: OpencodeServes): void;
};

/**
 * エージェントの driver を組む。Claude と、ベータの opencode と Codex である。
 *
 * driver は状態の面（実行中の一覧の写し）を持ち、写しは配る層より前から要る（publisher、索引、同期が読む）。
 * だから run の管理（runs/manager.ts）の中ではなく、配る層を組むときにここで組み、run の管理には出来たものを渡す。
 * enrich は実行中の一覧の足し付けの鎖（agent/liveHub.ts の LiveHub.enrich）で、写しが読み直しのたびに通す。
 * registryIsGone は、Claude の登録のうち消えたプロセスの残りと見る pid（省けば OS で決める）。
 */
export function bootAgents(
  home: Pick<HomeParts, 'home' | 'token' | 'claudeDir' | 'settings' | 'language'>,
  o: { compatLog: CompatLog; claudeVersion: { current: string | null }; enrich: (live: LiveSessionDto[]) => LiveSessionDto[]; registryIsGone?: (pid: number) => boolean },
): AgentParts {
  const procs = realProcOpsWith(o.compatLog);
  const claude = claudeDriverFor({
    home: home.home, token: home.token, language: home.language,
    // 設定は書き替わるので、呼ばれた時点の値を読む。
    claudeBin: () => claudeBinOf(home.settings.current),
    // 登録のディレクトリを見張り、見張れていて作業中が無い間は REGISTRY_IDLE_MS ごとにしか読まない（provider/claude-code/registry.ts）。
    live: claudeLiveSource({ claudeDir: home.claudeDir, pollMs: REGISTRY_POLL_MS, idleMs: REGISTRY_IDLE_MS, isGone: o.registryIsGone, enrich: o.enrich, compat: o.compatLog }),
    // 本文の置き場の発見と見張り。ほかの PC から降ろした本文（~/.agent-hangar/remote）も見る。見張りを付けるのは索引が始まるときである（boot/indexing.ts）。
    // 手元の本文の行を見張る。手元の claude の版より古い行は昔の形として見ない。版が読めるまでは確かめた版を床にする。
    transcript: claudeTranscriptSource({
      claudeDir: home.claudeDir, remoteRoot: remoteRoot(home.home),
      compat: { sink: o.compatLog, since: () => o.claudeVersion.current ?? VERIFIED_CLAUDE_VERSION },
    }),
    procs: () => procs,
  });
  let serves: OpencodeServes | null = null;
  const opencode = createOpencodeDriver({
    serves: () => serves,
    // TUI へは CLAUDE 系と hangar の変数を持ち込まない（serve の環境は serve/env.ts が別に空から組む）。
    droppedEnv: AGENT_RUN_DROPPED_ENV,
    // 状態の面が組み直すたびに、Claude と同じ足し付けの鎖を通す。
    enrich: o.enrich,
    // 許可のひな形は、起こすたびに今の設定と、利用者の opencode.json（会話のフォルダから上も）を読んで決める。
    permissions: (cwd) => permissionPresetFor({ enabled: opencodePermissionPresetOf(home.settings.current), home: home.home, cwd }),
    // 起動前に LM Studio のモデルを整える。長さは設定から、呼ばれた時点の値を読む。
    localModels: { home: home.home, context: () => localContextOf(home.settings.current) },
    // 接続先の準備のコマンド（この PC の設定）。呼ばれた時点の値を読む。
    providerPreps: new ProviderPreps({
      preps: () => providerPrepsOf(home.settings.current.opencodeProviderPrep),
      exitReason: (code) => render(home.language(), code === null ? msg('launchPrep.run.killed') : msg('launchPrep.run.exitCode', { code })),
      timeoutReason: (minutes) => render(home.language(), msg('launchPrep.run.timeout', { minutes })),
      report: (providerId, reason) => { console.warn(`[opencode] stop command for ${providerId} failed: ${reason}`); },
    }),
  });
  // Codex の状態と許可・質問の面（B4）。起こした会話は driver が track し、止めたら untrack する。足し付けの鎖は opencode と同じものを通す。
  const codexSurface = createCodexLive({ enrich: o.enrich, log: (line) => { console.warn(line); } });
  const codex = createCodexDriver({
    // 場所は起こすたびに探す（PATH）。ChatGPT.app の同梱は使わない。
    bin: () => findCodex(),
    home: home.home,
    // TUI へは CLAUDE 系と hangar の変数を持ち込まない（app-server の環境は provider/codex/env.ts が空から組む）。
    droppedEnv: AGENT_RUN_DROPPED_ENV,
    live: codexSurface.live,
    asks: codexSurface.asks,
  });
  return { agents: agentsOf([claude, opencode, codex]), claude, opencode, codex, bindOpencodeServes: (s) => { serves = s; } };
}

/**
 * hangar の決まり（hook の台本の場所、外す変数、失敗の知らせ方）で Claude の driver を組む。
 * 実物の口（claude の場所、状態の面、トランスクリプトの面、プロセスの口）は呼び手が渡す。run の管理の試験も、これで組む。
 */
export function claudeDriverFor(o: { home: string; token: string; language: GetLanguage; claudeBin: () => string | null; live: ClaudeLiveSource; transcript: ClaudeTranscriptSource; procs: () => Pick<ProcOps, 'runClaude'> }): ClaudeDriver {
  return createClaudeDriver({
    home: o.home,
    // hook の台本はサーバ自身の node で走らせる。
    nodeBin: () => process.execPath,
    hookScript: () => ensureHookScript(o.home),
    droppedEnv: RUN_DROPPED_ENV,
    claudeBin: o.claudeBin,
    live: o.live,
    transcript: o.transcript,
    procs: o.procs,
    report: (what, e) => {
      if (what === 'hook-settings') console.error('[runs] hook の設定を書けませんでした', e instanceof Error ? e.message : e);
      else console.error('[runs] バックグラウンドのセッションを止められませんでした', safeErrorText(o.language(), o.token, e));
    },
  });
}
