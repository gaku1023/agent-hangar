import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StatuslineStatusDto } from '@agent-hangar/shared';

// statusline スクリプトへの追記は、hangar が ~/.claude 配下に書く唯一の操作である。
// ここでは読み取りと、承諾を得た後に呼ばれる追記だけを提供し、問いかけは CLI が担う。

export const STATUSLINE_MARKER = '# agent-hangar: 使用量をローカルサーバへ渡す。失敗は無視する。';

/** スニペットの終わりの行。目印と合わせて、入っているスニペットの範囲を決める。 */
const SNIPPET_END = 'exec <<<"$__hangar_input"';

/**
 * 設計文書のスニペット。
 * 標準入力を読んでサーバへ背景で送り、同じ内容を元のスクリプトの標準入力に戻す。
 * トークンは HANGAR_HOME があればそこから読む。
 * 既定は従来どおり ~/.agent-hangar である。
 *
 * トークンは環境変数で curl に渡す。
 * `-H "Authorization: Bearer $(cat ...)"` と書くとシェルが先に展開するので、
 * 64 桁が curl の argv に載り、statusline が走るたびに ps から読める。
 * curl の --variable %NAME は環境変数を読み、--expand-header がそれをヘッダに差し込む。
 * この 2 つは curl 8.3 以降にある（手元は 8.7.1 で確認）。
 */
export function statuslineSnippet(port: number): string {
  return [
    STATUSLINE_MARKER,
    '__hangar_input=$(cat)',
    '__hangar_home="${HANGAR_HOME:-$HOME/.agent-hangar}"',
    '__hangar_token=$(cat "$__hangar_home/token" 2>/dev/null)',
    `printf '%s' "$__hangar_input" | HANGAR_TOKEN="$__hangar_token" curl -s -m 0.3 -X POST \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  --variable '%HANGAR_TOKEN' --expand-header 'Authorization: Bearer {{HANGAR_TOKEN}}' \\`,
    `  --data-binary @- http://127.0.0.1:${port}/api/ingest/statusline >/dev/null 2>&1 &`,
    SNIPPET_END,
    '',
  ].join('\n');
}

const expandHome = (p: string, homeDir: string) => (p === '~' ? homeDir : p.startsWith('~/') ? path.join(homeDir, p.slice(2)) : p);

/** ~/.claude/settings.json の statusLine.command を読み、先頭の語がファイルならその絶対パスを返す。 */
export function resolveStatuslineScript(claudeDir: string, homeDir: string = os.homedir()): { command: string | null; scriptPath: string | null } {
  const file = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(file)) return { command: null, scriptPath: null };
  let command: string | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { statusLine?: { command?: unknown } };
    command = typeof j.statusLine?.command === 'string' && j.statusLine.command.trim() ? j.statusLine.command.trim() : null;
  } catch {
    return { command: null, scriptPath: null };
  }
  if (!command) return { command: null, scriptPath: null };
  const words = command.split(/\s+/);
  const first = ['bash', 'sh', 'zsh'].includes(words[0] ?? '') ? words[1] : words[0];
  if (!first) return { command, scriptPath: null };
  const candidate = path.resolve(expandHome(first, homeDir));
  const ok = fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  return { command, scriptPath: ok ? candidate : null };
}

export function statuslineStatus(claudeDir: string, homeDir: string = os.homedir()): StatuslineStatusDto {
  const r = resolveStatuslineScript(claudeDir, homeDir);
  const installed = r.scriptPath !== null && fs.readFileSync(r.scriptPath, 'utf8').includes(STATUSLINE_MARKER);
  return { command: r.command, scriptPath: r.scriptPath, installed };
}

const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

/**
 * 入っているスニペットの行の範囲。目印の行から終わりの行までを見る。
 * 手で書き換えられていて終わりの行が見つからないときは null を返し、呼び手は何もしない。
 */
function snippetRange(lines: string[]): { from: number; to: number } | null {
  const from = lines.indexOf(STATUSLINE_MARKER);
  if (from === -1) return null;
  const limit = Math.min(lines.length, from + 20);
  for (let i = from + 1; i < limit; i++) if (lines[i] === SNIPPET_END) return { from, to: i };
  return null;
}

/** 入っているスニペットが今の形かどうか。目印が無ければ偽。 */
export function statuslineSnippetUpToDate(scriptPath: string, port: number): boolean {
  const lines = fs.readFileSync(scriptPath, 'utf8').split('\n');
  const r = snippetRange(lines);
  return r !== null && `${lines.slice(r.from, r.to + 1).join('\n')}\n` === statuslineSnippet(port);
}

/**
 * バックアップを取ってから、shebang の直後（無ければ先頭）にスニペットを入れる。
 * 既に入っていて今の形と違えば、その範囲だけを差し替える。
 * 目印だけを見て何もしないと、トークンを argv に載せる古い形が残り続けるためである。
 */
export function appendStatuslineSnippet(scriptPath: string, port: number, now: Date = new Date()): { changed: boolean; backup: string | null } {
  const src = fs.readFileSync(scriptPath, 'utf8');
  if (src.includes(STATUSLINE_MARKER)) {
    const lines = src.split('\n');
    const range = snippetRange(lines);
    if (!range) return { changed: false, backup: null };
    const snippet = statuslineSnippet(port);
    if (`${lines.slice(range.from, range.to + 1).join('\n')}\n` === snippet) return { changed: false, backup: null };
    const backup = `${scriptPath}.bak-${stamp(now)}`;
    fs.copyFileSync(scriptPath, backup);
    const mode = fs.statSync(scriptPath).mode;
    const next = [...lines.slice(0, range.from), ...snippet.split('\n').slice(0, -1), ...lines.slice(range.to + 1)].join('\n');
    fs.writeFileSync(scriptPath, next, { mode });
    return { changed: true, backup };
  }
  const backup = `${scriptPath}.bak-${stamp(now)}`;
  fs.copyFileSync(scriptPath, backup);
  const nl = src.indexOf('\n');
  // shebang の行だけで改行が無いときは、行を閉じてからスニペットを足す。
  const hasShebang = src.startsWith('#!');
  const head = hasShebang ? (nl === -1 ? `${src}\n` : src.slice(0, nl + 1)) : '';
  const rest = hasShebang ? (nl === -1 ? '' : src.slice(nl + 1)) : src;
  const mode = fs.statSync(scriptPath).mode;
  fs.writeFileSync(scriptPath, head + statuslineSnippet(port) + rest, { mode });
  return { changed: true, backup };
}
