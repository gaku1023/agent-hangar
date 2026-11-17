import fs from 'node:fs';
import path from 'node:path';

export const HOOK_SCRIPT_NAME = 'hangar-hook.mjs';

/**
 * hangar が起こした claude の hook が起こす台本。
 * 標準入力に来た hook の入力を、そのまま hangar のサーバの `/mcp/s/<id>/hook` へ送る（provider/claude-code/launch/hookSettings.ts）。
 * 宛先と鍵は、引数に渡した MCP の設定ファイル（0600）から読む。鍵を argv にも設定にも載せないためである。
 * 許可の確認（PermissionRequest）だけは、送ったあとに /decision で答えを待つ（sessions/hookDecisions.ts）。
 * 答えが来れば標準出力に書く。claude は札を出さずに、その答えを使う。
 * 来なければ（hangar が止まっている、待ちが閉じた、親の claude が消えた）何も書かず、札は画面に残る。
 * 何があっても失敗は出さず、0 で抜ける。hangar が止まっている間も、claude の画面に失敗を出さない。
 * 依存を持たない。node 18 からある fetch だけを使う。
 * 台本の中の注記は英語にする。利用者の置き場に置くファイルの中身で、画面の文言ではないためである。
 */
export function hookScript(): string {
  return [
    '// agent-hangar: forwards a Claude Code hook input to the hangar server.',
    '// usage: node hangar-hook.mjs <MCP config file> (the hook input on stdin)',
    '// Exits 0 without output, even when hangar is not running.',
    '// For a PermissionRequest, hangar may hand back a wait id; the script then waits for the answer',
    '// (a decision from a peer device or the orchestrator) and prints it, so that Claude Code skips its own prompt.',
    '// If nothing is printed, the prompt stays on screen and can be answered there.',
    "import fs from 'node:fs';",
    'const LIMIT = 256 * 1024;',
    'const POLL_MS = 25000;',
    'const quit = () => process.exit(0);',
    'const [config] = process.argv.slice(2);',
    'if (!config) quit();',
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { input += c; if (input.length > LIMIT) quit(); });",
    "process.stdin.on('error', quit);",
    '// The parent (claude) went away: stop waiting.',
    'const parentAlive = () => { try { process.kill(process.ppid, 0); return true; } catch { return false; } };',
    "process.stdin.on('end', async () => {",
    '  try {',
    "    const server = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.hangar;",
    "    const headers = { 'content-type': 'application/json', authorization: server.headers.Authorization };",
    "    const res = await fetch(`${server.url}/hook`, { method: 'POST', headers, body: input, signal: AbortSignal.timeout(3000) });",
    '    let event = null;',
    '    try { event = JSON.parse(input).hook_event_name; } catch {}',
    "    if (event !== 'PermissionRequest' || res.status !== 200) quit();",
    '    const { id } = await res.json();',
    "    if (typeof id !== 'string') quit();",
    '    while (parentAlive()) {',
    "      const r = await fetch(`${server.url}/decision`, { method: 'POST', headers, body: JSON.stringify({ id, waitMs: POLL_MS }), signal: AbortSignal.timeout(POLL_MS + 10000) });",
    '      if (!r.ok) quit();',
    '      const j = await r.json();',
    "      if (j.t === 'answer') { process.stdout.write(JSON.stringify(j.output), quit); return; }",
    "      if (j.t !== 'pending') quit();",
    '    }',
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
