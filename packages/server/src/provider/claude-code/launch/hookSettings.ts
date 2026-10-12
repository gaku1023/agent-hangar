import { runSettingsPath, writePrivateFile } from './mcpConfig.ts';

/**
 * hangar が起こす claude に `--settings` で渡す hook の設定。
 *
 * 入力待ちの問いの文を、トランスクリプトに頼らずに受け取るためのものである（hooks/question.ts）。
 * 許可待ちの中身（道具と命令）も、ここで受け取る（hooks/permission.ts）。
 * Windows の実機で、AskUserQuestion だけを呼んだ回に、入力待ちの間はトランスクリプトから問いの文が取れなかった。
 * hook は呼び出しの入力をそのまま渡すので、問いを出す直前（PreToolUse）に問いの文を受け取り、答えた後（PostToolUse、取り消しは PostToolUseFailure）に消す。
 *
 * 起こすのは hangar の台本（launch/hookScript.ts）で、shell を通さず（`args` を持つ exec の形）に node で直に起こす。
 * Windows の PowerShell と Git Bash の引用の違いに左右されないためである。
 * 裏で（`async`）走らせるので、問いの表示を待たせず、hangar が止まっていても claude の画面に失敗を出さない。
 * 鍵は書かない。台本は、引数に渡した MCP の設定ファイル（0600）から宛先と鍵を読む。
 */
export type HookSettingsInput = {
  /** 台本を走らせる node。サーバ自身の node（process.execPath）を渡す。 */
  node: string;
  /** hangar-hook.mjs の絶対パス。 */
  script: string;
  /** この run の MCP の設定ファイル。 */
  mcpConfigPath: string;
};

/** hook を待つ秒数。裏で走るので claude は待たないが、残り続けないよう区切る。 */
const HOOK_TIMEOUT_SECONDS = 10;

/**
 * PermissionRequest は、道具の許可を求める画面が出るときに走る（hooks/permission.ts）。
 * 許可待ちの札と通知に、何の許可か（道具と命令）を出すために受け取る。全部の道具に当てる。
 * 裏で走るので許可の判断には加わらず、台本は何も出力しない。
 * PostToolUse を全部の道具に広げると、呼び出しのたびに台本が走るので広げない。許可待ちを抜けたことは登録でわかる。
 */
export function hookSettingsJson(o: HookSettingsInput): string {
  const hook = { type: 'command', command: o.node, args: [o.script, o.mcpConfigPath], async: true, timeout: HOOK_TIMEOUT_SECONDS };
  const entry = [{ matcher: 'AskUserQuestion', hooks: [hook] }];
  return JSON.stringify({ hooks: { PreToolUse: entry, PostToolUse: entry, PostToolUseFailure: entry, PermissionRequest: [{ matcher: '*', hooks: [hook] }] } });
}

/** 0600 で書いて、そのパスを返す。消すのは MCP の設定と同じ後始末（removeMcpConfig、pruneMcpConfigs）である。 */
export function writeHookSettings(home: string, sessionId: string, o: HookSettingsInput): string {
  return writePrivateFile(runSettingsPath(home, sessionId), hookSettingsJson(o));
}
