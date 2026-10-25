import { agentsOf, type Agents } from '../agent/agents.ts';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { RUN_DROPPED_ENV } from '../launch/env.ts';
import { ensureHookScript } from '../launch/hookScript.ts';
import type { CompatLog } from '../provider/claude-code/compat/log.ts';
import { claudeBinOf } from '../provider/claude-code/compat/localClaude.ts';
import { claudeLiveSource, createClaudeDriver, type ClaudeDriver, type ClaudeLiveSource } from '../provider/claude-code/driver.ts';
import { realProcOpsWith, type ProcOps } from '../provider/claude-code/process/procs.ts';
import type { GetLanguage } from '../i18n/language.ts';
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
};

/**
 * エージェントの driver を組む。いまは Claude だけである。
 *
 * driver は状態の面（実行中の一覧の写し）を持ち、写しは配る層より前から要る（publisher、索引、同期が読む）。
 * だから run の管理（runs/manager.ts）の中ではなく、配る層を組むときにここで組み、run の管理には出来たものを渡す。
 * enrich は実行中の一覧の足し付けの鎖（agent/liveHub.ts の LiveHub.enrich）で、写しが読み直しのたびに通す。
 * registryIsGone は、Claude の登録のうち消えたプロセスの残りと見る pid（省けば OS で決める）。
 */
export function bootAgents(
  home: Pick<HomeParts, 'home' | 'token' | 'claudeDir' | 'settings' | 'language'>,
  o: { compatLog: CompatLog; enrich: (live: LiveSessionDto[]) => LiveSessionDto[]; registryIsGone?: (pid: number) => boolean },
): AgentParts {
  const procs = realProcOpsWith(o.compatLog);
  const claude = claudeDriverFor({
    home: home.home, token: home.token, language: home.language,
    // 設定は書き替わるので、呼ばれた時点の値を読む。
    claudeBin: () => claudeBinOf(home.settings.current),
    // 登録のディレクトリを見張り、見張れていて作業中が無い間は REGISTRY_IDLE_MS ごとにしか読まない（provider/claude-code/registry.ts）。
    live: claudeLiveSource({ claudeDir: home.claudeDir, pollMs: REGISTRY_POLL_MS, idleMs: REGISTRY_IDLE_MS, isGone: o.registryIsGone, enrich: o.enrich, compat: o.compatLog }),
    procs: () => procs,
  });
  return { agents: agentsOf([claude]), claude };
}

/**
 * hangar の決まり（hook の台本の場所、外す変数、失敗の知らせ方）で Claude の driver を組む。
 * 実物の口（claude の場所、状態の面、プロセスの口）は呼び手が渡す。run の管理の試験も、これで組む。
 */
export function claudeDriverFor(o: { home: string; token: string; language: GetLanguage; claudeBin: () => string | null; live: ClaudeLiveSource; procs: () => Pick<ProcOps, 'runClaude'> }): ClaudeDriver {
  return createClaudeDriver({
    home: o.home,
    // hook の台本はサーバ自身の node で走らせる。
    nodeBin: () => process.execPath,
    hookScript: () => ensureHookScript(o.home),
    droppedEnv: RUN_DROPPED_ENV,
    claudeBin: o.claudeBin,
    live: o.live,
    procs: o.procs,
    report: (what, e) => {
      if (what === 'hook-settings') console.error('[runs] hook の設定を書けませんでした', e instanceof Error ? e.message : e);
      else console.error('[runs] バックグラウンドのセッションを止められませんでした', safeErrorText(o.language(), o.token, e));
    },
  });
}
