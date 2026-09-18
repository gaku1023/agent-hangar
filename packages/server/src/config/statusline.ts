import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StatuslineStatusDto } from '@agent-hangar/shared';

// statusline スクリプトへの追記は、hangar が ~/.claude 配下に書く唯一の操作である。
// ここでは読み取りと、承諾を得た後に呼ばれる追記だけを提供し、問いかけは CLI が担う。

export const STATUSLINE_MARKER = '# agent-hangar: 使用量をローカルサーバへ渡す。失敗は無視する。';

/**
 * 設計文書のスニペット。
 * 標準入力を読んでサーバへ背景で送り、同じ内容を元のスクリプトの標準入力に戻す。
 * トークンは HANGAR_HOME があればそこから読む。
 * 既定は従来どおり ~/.agent-hangar である。
 */
export function statuslineSnippet(port: number): string {
  return [
    STATUSLINE_MARKER,
    '__hangar_input=$(cat)',
    '__hangar_home="${HANGAR_HOME:-$HOME/.agent-hangar}"',
    `printf '%s' "$__hangar_input" | curl -s -m 0.3 -X POST \\`,
    `  -H 'Content-Type: application/json' \\`,
    '  -H "Authorization: Bearer $(cat "$__hangar_home/token" 2>/dev/null)" \\',
    `  --data-binary @- http://127.0.0.1:${port}/api/ingest/statusline >/dev/null 2>&1 &`,
    'exec <<<"$__hangar_input"',
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

/** バックアップを取ってから、shebang の直後（無ければ先頭）にスニペットを入れる。目印があれば何もしない。 */
export function appendStatuslineSnippet(scriptPath: string, port: number, now: Date = new Date()): { changed: boolean; backup: string | null } {
  const src = fs.readFileSync(scriptPath, 'utf8');
  if (src.includes(STATUSLINE_MARKER)) return { changed: false, backup: null };
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
