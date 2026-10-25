import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AgentDriver, LaunchPlan, LaunchSpec, LiveSource, SessionMode } from '../../agent/types.ts';
import { buildClaudeArgs } from './launch/args.ts';
import { writeHookSettings, type HookSettingsInput } from './launch/hookSettings.ts';
import { writeMcpConfig } from './launch/mcpConfig.ts';
import type { ProcOps } from './process/procs.ts';
import { RegistryWatcher, watchDir } from './registry.ts';
import type { CompatSink } from './compat/types.ts';
import type { LaunchMode, LiveSession } from './types.ts';

/**
 * Claude の driver に呼び手が渡すもの。
 * この置き場から hangar の層（launch/、runs/）を読まないよう、hook の台本の場所と外す変数の一覧は呼び手が渡す。
 * live は状態の面（claudeLiveSource で作る）。driver の live としてそのまま出し、止めるときにバックグラウンドの id を引くのにも使う。
 * report は、hook の設定を書けなかったときと、バックグラウンドのセッションを止められなかったときに呼ぶ（起動も停止も止めない）。
 * files は、設定のファイルを書く口。試験で差し替える。
 */
export type ClaudeDriverDeps = {
  home: string;
  /** hook の台本を走らせる node。 */
  nodeBin: () => string;
  /** hook の台本の絶対パス。呼ぶたびに台本を置き直してよい。 */
  hookScript: () => string;
  /** 起こすものへ持ち込まない変数（launch/env.ts の RUN_DROPPED_ENV）。 */
  droppedEnv: readonly string[];
  claudeBin: () => string | null;
  live: ClaudeLiveSource;
  procs: () => Pick<ProcOps, 'runClaude'>;
  report: (what: 'hook-settings' | 'stop', e: unknown) => void;
  files?: { mcpConfig?: typeof writeMcpConfig; hookSettings?: (home: string, sessionId: string, o: HookSettingsInput) => string | undefined };
};

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** フォークには新しい UUID が要る。空のまま組み立てると --session-id '' という壊れたコマンドになるので、ここで弾く。 */
function launchModeOf(mode: SessionMode): LaunchMode {
  if (mode.kind === 'start') return { kind: 'start', sessionUuid: mode.id };
  if (mode.kind === 'resume') return { kind: 'resume', sessionUuid: mode.id };
  if (!mode.newId?.trim()) throw new Error('フォークには新しいセッションの UUID が必要です');
  return { kind: 'fork', sessionUuid: mode.id, newSessionUuid: mode.newId.trim() };
}

/**
 * 置き場を足さない起動（最初のアカウント）は、tmux サーバが持っている CLAUDE_CONFIG_DIR も外す。
 * tmux サーバを別のアカウントのシェルから起こしていると、足さないだけではその置き場で動いてしまう。
 */
function unsetFor(droppedEnv: readonly string[], env: Record<string, string>): readonly string[] {
  return env.CLAUDE_CONFIG_DIR ? droppedEnv : [...droppedEnv, 'CLAUDE_CONFIG_DIR'];
}

/** Claude の状態の面。登録のずれを数え直す口（renoteDrifts）だけ、境界の型より多く持つ。 */
export type ClaudeLiveSource = LiveSource & {
  /** 最後に数えた登録を忘れ、次の読み直しで残っている登録のずれを 1 回だけ数え直す（RegistryWatcher.renoteDrifts）。 */
  renoteDrifts(): void;
};

/**
 * Claude の状態の面を作る。中身は登録（~/.claude/sessions/<pid>.json）の見張り（registry.ts の RegistryWatcher）で、振る舞いはそのままである。
 * pollMs は作業中があるか見張れない間の読み直しの間隔、idleMs は見張れていて作業中が無い間の間隔である。
 * isGone は消えたプロセスの残りと見る pid（省けば OS で決める）。enrich は読み直しのたびに通す足し付けで、LiveHub.enrich を渡す。
 * compat は形のずれを受け取る口。
 */
export function claudeLiveSource(o: { claudeDir: string; pollMs: number; idleMs: number; isGone?: (pid: number) => boolean; enrich: (live: LiveSession[]) => LiveSession[]; compat: CompatSink }): ClaudeLiveSource {
  const w = new RegistryWatcher(o.claudeDir, o.pollMs, o.isGone, o.enrich, o.compat, { idleMs: o.idleMs, watch: watchDir });
  return {
    start: () => w.start(),
    stop: () => w.stop(),
    current: () => w.current(),
    onChange: (cb) => w.onChange(cb),
    kick: (ms) => w.kick(ms),
    isRunning: (providerSessionId, pid) => w.current().some((l) => l.sessionId === providerSessionId && l.pid === pid),
    renoteDrifts: () => w.renoteDrifts(),
  };
}

export type ClaudeDriver = AgentDriver & {
  readonly live: ClaudeLiveSource;
  /** バックグラウンドのサービスが持つセッションに `claude attach` でつなぐ。Claude にしか無い起こし方なので、境界の型には無い。 */
  attachPlan(bin: string, jobId: string, env: Record<string, string>): LaunchPlan;
};

/** Claude Code の driver。いまは起動と状態の面を持つ。 */
export function createClaudeDriver(deps: ClaudeDriverDeps): ClaudeDriver {
  const files = { mcpConfig: deps.files?.mcpConfig ?? writeMcpConfig, hookSettings: deps.files?.hookSettings ?? writeHookSettings };

  /**
   * AskUserQuestion の問いの文を本文より先に受け取る hook の設定を書く（launch/hookSettings.ts）。
   * 書けなくても起動は止めない。問いの文は今までどおり本文から取る。
   */
  const hookSettings = (sessionId: string, mcpConfigPath: string): string | undefined => {
    try {
      return files.hookSettings(deps.home, sessionId, { node: deps.nodeBin(), script: deps.hookScript(), mcpConfigPath });
    } catch (e) {
      deps.report('hook-settings', e);
      return undefined;
    }
  };

  return {
    kind: 'claude-code',
    caps: { accounts: true, effort: true, permissionMode: true, remoteControl: true, fork: true, attachExternal: true },
    launch: {
      newSessionId: () => crypto.randomUUID(),
      /**
       * claude の引数を組み立てる。実行ファイルは呼び手が決める。設定や環境変数で差し替えられるので、ここに `claude` を書かない。
       * MCP の秘密を argv に載せないため、設定は 0600 のファイルに置き、パスだけを claude に渡す。
       */
      plan(bin: string, mode: SessionMode, spec: LaunchSpec): LaunchPlan {
        const launchMode = launchModeOf(mode);
        const mcpConfigPath = files.mcpConfig(deps.home, spec.hangarSessionId, spec.mcp.url, spec.mcp.secret);
        const argv = [bin, ...buildClaudeArgs({
          mode: launchMode,
          systemPrompt: spec.instructions.map((e) => e.text).join(''),
          mcpConfigPath,
          settingsPath: hookSettings(spec.hangarSessionId, mcpConfigPath),
          name: spec.name,
          prompt: spec.prompt,
          model: spec.model,
          effort: spec.effort,
          permissionMode: spec.mode,
          worktree: spec.worktree,
          addDirs: spec.addDirs,
          remoteControl: spec.remoteControl,
        })];
        return { argv, env: {}, unset: unsetFor(deps.droppedEnv, spec.env), watchRemoteUrl: spec.remoteControl != null };
      },
      /**
       * バックグラウンドのサービスが持つセッションなら、その本体も止める。止めにいったら true を返す。
       * attach の run の tmux を落としても画面の口が閉じるだけで、claude は動き続けるからである。
       * 止め終わるのは待たない。失敗しても run は閉じ、report にだけ渡す。
       * 画面が閉じた（tui-gone）ときは、claude も一緒に終わっているので何もしない。
       */
      release(target, cause) {
        if (cause === 'tui-gone') return false;
        const jobId = deps.live.current().find((l) => l.sessionId === target.providerSessionId)?.background?.jobId;
        const bin = deps.claudeBin();
        if (!jobId || !bin) return false;
        const cwd = isDirectory(target.cwd) ? target.cwd : deps.home;
        deps.procs().runClaude(bin, ['stop', jobId], cwd).catch((e) => deps.report('stop', e));
        return true;
      },
    },
    live: deps.live,
    attachPlan(bin, jobId, env) {
      return { argv: [bin, 'attach', jobId], env: {}, unset: unsetFor(deps.droppedEnv, env) };
    },
  };
}
