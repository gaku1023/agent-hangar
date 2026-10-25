import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../../config/jsonTextEdit.ts';
import { opencodeConfigPath } from './configFile.ts';

/**
 * hangar が起こす opencode に重ねる、安全寄りの許可のひな形（docs/design.md「opencode の許可のひな形」）。
 *
 * opencode 2.1.4 の既定の agent は、`* allow`（.env を読むときだけ ask）で、shell も聞かずに打つ。
 * そこで shell を ask にし、読むだけのよくあるコマンドだけを allow に戻す。ほかの道具（read、glob、grep、edit など）は opencode の既定のままにする。
 * read などの allow をここで書き直すと、規則は後に書いたものが勝つので、既定の「.env は ask」を上書きしてしまうからである。
 *
 * 照らし方（2.1.4 のソースと実物で確かめた）：
 * - shell の道具は、打つ文をシェルの文法で割り、つないだコマンド（`&&`、`;`、`|`、`$(…)` の中）を 1 つずつ照らす。1 つでも ask なら全体が ask になる。
 *   `git status && rm -rf x` は `rm -rf x` が ask に当たるので、つなぎで allow をすり抜けない。
 * - 1 つのコマンドの照らす文には、そのコマンドに付いた書き出し（`> file`）が含まれる。`cat a > b` は `cat *` に当たってしまうので、
 *   `>` を含むものは最後に ask へ戻す。
 * - 型の `*` は何にでも当たり、末尾の ` *` は無しにも当たる（`git status *` は `git status` にも当たる）。Windows では大文字小文字を区別しない。
 */

/** 規則 1 つ（opencode 2.x の `permissions` の要素）。後に書いたものが勝つ。 */
export type OpencodePermissionRule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' };

/**
 * 読むだけのよくあるコマンド。どれも、引数だけではファイルを書き換えず、ほかのコマンドを起こさないものに絞った。
 * `find`（-exec、-delete）、`rg`（--pre）、`sort`（-o）、`tree`（-o）、`git branch`（-D）のように、引数で書き換えや実行ができるものは入れない。
 */
export const READ_ONLY_COMMANDS: readonly string[] = [
  'git status', 'git diff', 'git log', 'git show', 'git blame', 'git rev-parse', 'git ls-files',
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'which', 'echo',
  // Windows の PowerShell の読むだけのもの。
  'Get-ChildItem', 'Get-Content', 'Get-Location',
];

/** allow に戻した後で、もう一度 ask にするもの。書き出し（`>`、`>>`）と、git の `--output`（差分をファイルに書く）。 */
const ASK_AGAIN: readonly string[] = ['*>*', 'git * --output*'];

/** ひな形の規則。shell をまず ask にし、読むだけのものを allow に戻し、書き出しを ask に戻す。 */
export function permissionPresetRules(): OpencodePermissionRule[] {
  return [
    { action: 'shell', resource: '*', effect: 'ask' },
    ...READ_ONLY_COMMANDS.map((c): OpencodePermissionRule => ({ action: 'shell', resource: `${c} *`, effect: 'allow' })),
    ...ASK_AGAIN.map((r): OpencodePermissionRule => ({ action: 'shell', resource: r, effect: 'ask' })),
  ];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 設定の中身に、許可を決める鍵（1.x の `permission` と `tools`、2.x の `permissions`）が上の段にあるか。 */
function hasPermissionKeys(file: string): boolean {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  let j: unknown;
  try { j = parseJsonc(text); } catch { return false; }
  return isObj(j) && (j.permission !== undefined || j.permissions !== undefined || j.tools !== undefined);
}

/** 利用者の設定（opencodeConfigPath）だけを見る形。設定の画面が、スイッチを無効にして注記を出すのに使う（会話のフォルダはまだ決まっていないため）。 */
export function userConfigDefinesPermissions(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return hasPermissionKeys(opencodeConfigPath(home, env));
}

/**
 * 利用者が opencode の設定で許可を決めているか。決めていれば、ひな形は重ねない（利用者の規則を優先する）。
 * hangar の足す設定（OPENCODE_CONFIG_CONTENT）は、opencode が利用者の設定より後に読むので、重ねると利用者の規則に勝ってしまうからである。
 * 見るのは、利用者の設定（opencodeConfigPath）と、会話のフォルダから上へたどった各階の `opencode.json(c)` と `.opencode/opencode.json(c)`（opencode が読む所）。
 * agent ごとの許可（`agent.<名前>.permission`）は見ない。opencode はそれを上の段の規則より後に足すので、重ねても利用者の規則が勝つ。
 */
export function userDefinesPermissions(home: string, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (userConfigDefinesPermissions(home, env)) return true;
  for (let dir = path.resolve(cwd); ; ) {
    for (const f of ['opencode.json', 'opencode.jsonc', path.join('.opencode', 'opencode.json'), path.join('.opencode', 'opencode.jsonc')]) {
      if (hasPermissionKeys(path.join(dir, f))) return true;
    }
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/**
 * 会話を起こすときに serve へ重ねる規則。設定（opencodePermissionPreset）が切か、利用者が許可を決めていれば null（重ねない）。
 * env は hangar の環境で、XDG_CONFIG_HOME を見る（serve にも同じ値を渡す）。
 */
export function permissionPresetFor(o: { enabled: boolean; home: string; cwd: string; env?: NodeJS.ProcessEnv }): OpencodePermissionRule[] | null {
  if (!o.enabled || userDefinesPermissions(o.home, o.cwd, o.env)) return null;
  return permissionPresetRules();
}
