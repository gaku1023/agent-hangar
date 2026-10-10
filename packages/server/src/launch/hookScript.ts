import fs from 'node:fs';
import path from 'node:path';

export const HOOK_SCRIPT_NAME = 'hangar-hook.mjs';

/**
 * hangar が起こした claude の hook が起こす台本。
 * 標準入力に来た hook の入力を、そのまま hangar のサーバの `/mcp/s/<id>/hook` へ送る（provider/claude-code/launch/hookSettings.ts）。
 * 宛先と鍵は、引数に渡した MCP の設定ファイル（0600）から読む。鍵を argv にも設定にも載せないためである。
 * 何があっても何も書かずに 0 で抜ける。hangar が止まっている間も、claude の画面に失敗を出さない。
 * 依存を持たない。node 18 からある fetch だけを使う。
 * 台本の中の注記は英語にする。利用者の置き場に置くファイルの中身で、画面の文言ではないためである。
 */
export function hookScript(): string {
  return [
    '// agent-hangar: forwards a Claude Code hook input to the hangar server.',
    '// usage: node hangar-hook.mjs <MCP config file> (the hook input on stdin)',
    '// Always exits 0 without output, even when hangar is not running.',
    "import fs from 'node:fs';",
    'const LIMIT = 256 * 1024;',
    'const quit = () => process.exit(0);',
    'const [config] = process.argv.slice(2);',
    'if (!config) quit();',
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { input += c; if (input.length > LIMIT) quit(); });",
    "process.stdin.on('error', quit);",
    "process.stdin.on('end', async () => {",
    '  try {',
    "    const server = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.hangar;",
    "    await fetch(`${server.url}/hook`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: server.headers.Authorization }, body: input, signal: AbortSignal.timeout(3000) });",
    '  } catch {}',
    '  quit();',
    '});',
    '',
  ].join('\n');
}

/**
 * <home>/bin に台本を置き、そのパスを返す。中身が同じなら書かない。
 * node は台本を最初に全部読んでから走るので、その場で書き換えてよい。
 */
export function ensureHookScript(home: string): string {
  const dir = path.join(home, 'bin');
  const file = path.join(dir, HOOK_SCRIPT_NAME);
  const body = hookScript();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body);
  return file;
}
