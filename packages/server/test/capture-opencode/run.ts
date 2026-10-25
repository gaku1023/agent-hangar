import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureOutputSync } from '../../src/platform/capture.ts';
import { OpencodeClient } from '../../src/provider/opencode/client.ts';
import { opencodeVersionOf } from '../../src/provider/opencode/compat/version.ts';
import type { ServeProcess } from '../../src/provider/opencode/serve/spawn.ts';
import { FIXTURE_OPENCODE_DIR } from '../opencodeFixtures.ts';
import {
  liveEnv, makeWorld, MOCK_MCP_SECRET, opencodeBin, PROMPT_HI, PROMPT_SLEEP, PROMPT_TURN, serveApi, startLiveServe, startMockLlm, startMockMcp,
  stopLiveServe, tapEvents, until, writeUserConfig, type EventTap, type LiveWorld,
} from '../opencodeHarness.ts';

// opencode の見本を採る道具。入口は scripts/capture-opencode-fixtures.ts（npm run capture-opencode-fixtures）。
// 本物の opencode を、試しの置き場（XDG_*_HOME を一時ディレクトリへ）と空の環境で 1 本だけ起こす。LLM は呼ばない（模擬を手元に立てる）。
// 利用者の opencode の記録と設定には触らず、終わったら置き場ごと消す。CI では動かさない（照合は opencodeLive.test.ts）。
// 採るもの（各版の README.md に同じ表を書く）：version.txt、help.txt、events-turn.sse、events-interrupt.sse、events-reconnect.sse、rest.json、
// messages.json、messages-pages.json、messages-while-form.json、messages-while-running.json。

const CLI_TIMEOUT_MS = 60_000;
const WAIT_MS = 60_000;
const ABORT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
/** 見本に書く置き換え先。2.1.4 の見本と同じ名前にする。 */
const PLACE = { repo: '/work/repo', root: '/work/env2', tmp: '/work/tmp', home: '/work/home' };

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
type Rec = Record<string, unknown>;
const dataOf = (v: unknown): unknown => (v && typeof v === 'object' ? (v as Rec).data : undefined);
const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : !!v && typeof v === 'object' && Object.keys(v).length > 0);

type Options = { force: boolean; out: string | null };
function parseArgs(argv: string[]): Options {
  const o: Options = { force: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--out') o.out = argv[++i] ?? null;
    else throw new Error(`知らない引数です：${a}（使えるのは --force と --out <ディレクトリ>）`);
  }
  return o;
}

/** 手元のパスを見本の名前に置き換える。長いものから置き換える（repo は root の下にある）。 */
function redactor(w: LiveWorld): (text: string) => string {
  const pairs: [string, string][] = [
    [w.repo, PLACE.repo], [w.root, PLACE.root],
    ...[...new Set([os.tmpdir(), fs.realpathSync(os.tmpdir())])].map((t): [string, string] => [t.replace(/\/$/, ''), PLACE.tmp]),
    [os.homedir(), PLACE.home],
  ];
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (text) => pairs.reduce((t, [from, to]) => t.split(from).join(to), text);
}

/** 見本に残ってはいけない値（serve のパスワード、MCP の秘密、利用者の名前とホーム）。見つけたら書かずに止める。 */
function leaksOf(files: Map<string, string>, secrets: string[]): string[] {
  const found: string[] = [];
  for (const [name, text] of files) for (const s of secrets) if (s && text.includes(s)) found.push(`${name} に ${s.length > 12 ? `${s.slice(0, 4)}…` : '秘密の値'} が残っています`);
  return found;
}

const sse = (frames: string[]): string => frames.map((f) => `${f}\n\n`).join('');
const json = (v: unknown): string => `${JSON.stringify(v, null, 1)}\n`;

export async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv);
  const bin = opencodeBin();
  if (!bin) throw new Error('opencode が見つかりません。HANGAR_OPENCODE_BIN で場所を渡すか、PATH に入れてください');
  const world = makeWorld('hangar-opencode-capture-');
  const env = liveEnv(bin, world);
  const versionOut = captureOutputSync(bin, ['--version'], { env, timeoutMs: CLI_TIMEOUT_MS }).stdout;
  const version = opencodeVersionOf(versionOut);
  const target = o.out ? path.resolve(o.out) : path.join(FIXTURE_OPENCODE_DIR, version ?? 'unknown');
  const refusal = !version ? `opencode の版を読めません：${versionOut.trim().slice(0, 200)}`
    : fs.existsSync(target) && !o.force ? `${target} はもうあります。採り直すときは --force を付けてください` : null;
  if (refusal || !version) {
    fs.rmSync(world.root, { recursive: true, force: true });
    throw new Error(refusal ?? 'opencode の版を読めません');
  }
  console.log(`opencode ${version}（${bin}）の見本を ${target} に採ります`);

  let serve: ServeProcess | null = null;
  let password = '';
  const taps: EventTap[] = [];
  const llm = await startMockLlm({ repo: world.repo });
  const mcp = await startMockMcp();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const t of taps) await t.close().catch(() => undefined);
    if (serve) await stopLiveServe(serve);
    await llm.close();
    await mcp.close();
    fs.rmSync(world.root, { recursive: true, force: true });
  };
  const onSignal = (sig: NodeJS.Signals) => { console.error(`${sig} を受けました。後始末をして止めます`); void cleanup().finally(() => process.exit(130)); };
  for (const s of ABORT_SIGNALS) process.once(s, onSignal);

  const files = new Map<string, string>();
  try {
    files.set('version.txt', versionOut);
    files.set('help.txt', captureOutputSync(bin, ['--help'], { env, timeoutMs: CLI_TIMEOUT_MS }).stdout);
    writeUserConfig(world, llm.url);
    serve = await startLiveServe(bin, world, mcp.url);
    password = serve.password;
    const s = serve;
    const client = new OpencodeClient(s, { timeoutMs: 30_000 });
    const get = async (p: string) => (await serveApi(s, 'GET', p)).body;
    const at = `${encodeURIComponent('location[directory]')}=${encodeURIComponent(world.repo)}`;
    const rest: Rec = {};
    rest.idle = await get('/api/session/active');
    // 1 つ目の会話：1 ターン（許可 → … → form → 文）。流れは events-turn.sse に書く。
    // 場所を初めて使ったときの出来事（agent.updated など）も入るよう、場所に触る前に流れを開く。
    const turn = await tapEvents((signal) => client.events(signal));
    taps.push(turn);
    await turn.waitFor((e) => e.type === 'server.connected');
    await until(() => client.mcpStatus(world.repo), (r) => r.some((x) => x.name === 'hangar' && x.status === 'connected'), 'hangar MCP', WAIT_MS, 500);
    const sid = await client.createSession({ directory: world.repo });
    console.log(`会話 ${sid}`);
    await serveApi(s, 'POST', `/api/session/${sid}/prompt`, { text: PROMPT_TURN });
    const perm = await until(() => get(`/api/session/${sid}/permission`), (v) => nonEmpty(dataOf(v)), 'permission', WAIT_MS);
    rest.running = await get('/api/session/active');
    rest.permission = perm;
    rest.permissionRequest = await get(`/api/permission/request?${at}`);
    // 待ちの途中でつなぎ直したときの頭。
    const again = await tapEvents((signal) => client.events(signal));
    await sleep(1500);
    await again.close();
    files.set('events-reconnect.sse', sse(again.frames));
    for (const p of dataOf(perm) as { id: string }[]) await serveApi(s, 'POST', `/api/session/${sid}/permission/${p.id}/reply`, { decision: 'once' });
    const form = await until(() => get(`/api/session/${sid}/form`), (v) => nonEmpty(dataOf(v)), 'form', WAIT_MS);
    rest.form = form;
    rest.formRequest = await get(`/api/form?${at}`);
    files.set('messages-while-form.json', json(await get(`/api/session/${sid}/message?limit=100`)));
    for (const f of dataOf(form) as { id: string; fields: { key: string }[] }[]) await serveApi(s, 'POST', `/api/session/${sid}/form/${f.id}/reply`, { answer: { [f.fields[0]!.key]: 'Red' } });
    await turn.waitFor((e) => e.sessionID === sid && e.type === 'session.execution.succeeded', WAIT_MS);
    await until(() => client.active(), (a) => !a.has(sid), 'idle', WAIT_MS);
    await sleep(500);
    rest.noPermission = await get(`/api/session/${sid}/permission`);
    rest.noForm = await get(`/api/session/${sid}/form`);
    files.set('events-turn.sse', sse(turn.frames));
    files.set('rest.json', json(rest));

    // 同じ会話の 2 つ目：`sleep 20` が動いている間の本文を採り、interrupt で止める。
    await serveApi(s, 'POST', `/api/session/${sid}/prompt`, { text: PROMPT_SLEEP });
    const p2 = await until(() => get(`/api/session/${sid}/permission`), (v) => nonEmpty(dataOf(v)), 'permission (sleep)', WAIT_MS);
    for (const p of dataOf(p2) as { id: string }[]) await serveApi(s, 'POST', `/api/session/${sid}/permission/${p.id}/reply`, { decision: 'once' });
    await until(() => get(`/api/session/${sid}/message?limit=5`), (v) => JSON.stringify(v).includes('"status":"running"'), 'running shell', WAIT_MS);
    await sleep(500);
    files.set('messages-while-running.json', json(await get(`/api/session/${sid}/message?limit=100`)));
    await serveApi(s, 'POST', `/api/session/${sid}/interrupt`, {});
    await until(() => client.active(), (a) => !a.has(sid), 'idle (sleep)', WAIT_MS);

    // 3 つ目：文だけ。終わった後の本文の全部と、limit=4 のページの並び。
    await serveApi(s, 'POST', `/api/session/${sid}/prompt`, { text: PROMPT_HI });
    await sleep(500);
    await until(() => client.active(), (a) => !a.has(sid), 'idle (hi)', WAIT_MS);
    await sleep(500);
    files.set('messages.json', json(await get(`/api/session/${sid}/message?limit=100`)));
    const pages: unknown[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const q = new URLSearchParams({ limit: '4', ...(cursor ? { cursor } : {}) });
      const r = await serveApi(s, 'GET', `/api/session/${sid}/message?${q.toString()}`);
      pages.push({ query: q.toString(), status: r.status, body: r.body });
      const next = (r.body as { cursor?: { next?: unknown } } | null)?.cursor?.next;
      cursor = typeof next === 'string' && next !== '' ? next : null;
      if (!cursor) break;
    }
    files.set('messages-pages.json', json(pages));

    // 2 つ目の会話：許可の待ちの途中で interrupt した流れ。新しく開いた流れに書く。
    const intr = await tapEvents((signal) => client.events(signal));
    taps.push(intr);
    await intr.waitFor((e) => e.type === 'server.connected');
    const other = await client.createSession({ directory: world.repo });
    await serveApi(s, 'POST', `/api/session/${other}/prompt`, { text: PROMPT_TURN });
    await until(() => get(`/api/session/${other}/permission`), (v) => nonEmpty(dataOf(v)), 'permission (interrupt)', WAIT_MS);
    await serveApi(s, 'POST', `/api/session/${other}/interrupt`, {});
    await intr.waitFor((e) => e.sessionID === other && e.type === 'session.execution.interrupted', WAIT_MS);
    await sleep(1000);
    files.set('events-interrupt.sse', sse(intr.frames));
  } finally {
    await cleanup();
    for (const sig of ABORT_SIGNALS) process.removeListener(sig, onSignal);
  }

  const redact = redactor(world);
  const out = new Map([...files].map(([name, text]) => [name, name.endsWith('.txt') ? text : redact(text)]));
  const leaks = leaksOf(out, [password, MOCK_MCP_SECRET, world.root, os.homedir()]);
  if (leaks.length > 0) throw new Error(`見本に残してはいけない値が見つかったので、書きませんでした：\n${leaks.join('\n')}`);
  out.set('README.md', readme(version, bin));
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const [name, text] of out) fs.writeFileSync(path.join(target, name), text);
  console.log(`${out.size} 個のファイルを書きました。provider/opencode/compat/cli.ts の組み込みの一覧を help.txt と揃え、cli.test.ts を通してください`);
}

function readme(version: string, bin: string): string {
  const day = new Date().toISOString().slice(0, 10);
  const how = bin.includes('node_modules') ? 'npm の `@opencode/cli`' : bin.startsWith('/opt/homebrew/') || bin.startsWith('/home/linuxbrew/') ? 'Homebrew の `opencode`' : `\`${path.basename(bin)}\``;
  return `# opencode ${version} の見本

- 採った日：${day}
- 版：\`opencode --version\` の出力（\`version.txt\`）。
- 入れ方：${how}。
- 採り方：\`npm run capture-opencode-fixtures\`（\`packages/server/test/capture-opencode/run.ts\`）。
  空の環境（\`HOME\`、\`USER\`、\`LOGNAME\`、\`SHELL\`、\`TMPDIR\`、\`LANG\` と最小の \`PATH\`）に、試しの置き場の \`XDG_CONFIG_HOME\`・\`XDG_DATA_HOME\`・\`XDG_STATE_HOME\`・\`XDG_CACHE_HOME\` を足して、\`opencode serve\` を 1 本だけ起こした。
  LLM は呼んでいない。試しの置き場の \`opencode.json\` の \`provider\` に OpenAI 互換の模擬（手元の 127.0.0.1）を置き、\`permission\` は shell を \`ask\`、edit と write を \`allow\` にした。
  hangar の MCP の代わりに同じ形の小さな MCP（道具は \`set_turn_intent\`）を、hangar と同じく \`OPENCODE_CONFIG_CONTENT\` で渡した。
- 書き留めた後で、手元のパスだけを置き換えた（作業のフォルダは \`${PLACE.repo}\`、試しの置き場は \`${PLACE.root}\`、一時ディレクトリは \`${PLACE.tmp}\`、ホームは \`${PLACE.home}\`）。ほかは手で直していない。

\`help.txt\` と \`version.txt\` は空の環境での標準出力そのままで、手で直さない。
\`provider/opencode/compat/cli.ts\` の組み込みの一覧は、最も新しい見本の \`help.txt\` と揃える（\`cli.test.ts\` が突き合わせる）。

## 筋書き

1. 会話 1 を ID なしの \`POST /api/session\` で作り、\`POST /api/session/{id}/prompt\` で 1 つ目の発言を送る。
   模擬は shell → execute（中で \`hangar.set_turn_intent\`）→ write → edit → read → question → 文、の順に呼ぶ。
   許可に \`once\` で、form に \`Red\` で答える。
2. 同じ会話の 2 つ目の発言で、shell の \`sleep 20\` を許し、動いている間に \`POST /api/session/{id}/interrupt\` を送る。
3. 3 つ目の発言は文だけ。
4. 会話 2 で 1 つ目と同じ発言を送り、許可の待ちの途中で interrupt を送る。

| ファイル | 中身 |
| --- | --- |
| \`events-turn.sse\` | 筋書き 1 の \`/api/event\` の流れ（つないだときから、ターンが終わるまで）。 |
| \`events-interrupt.sse\` | 筋書き 4 のために新しく開いた \`/api/event\` の流れ。\`permission.replied\` は来ず、\`session.execution.interrupted\` で終わる。 |
| \`events-reconnect.sse\` | 筋書き 1 の許可の待ちの途中で、もう 1 本つないだときの頭。 |
| \`rest.json\` | 取り直しに使う道の答え。\`idle\`・\`running\` は \`GET /api/session/active\`、\`permission\`・\`noPermission\` は \`GET /api/session/{id}/permission\`、\`form\`・\`noForm\` は \`GET /api/session/{id}/form\`、\`permissionRequest\` は \`GET /api/permission/request\`、\`formRequest\` は \`GET /api/form\`（後の 2 つは \`location[directory]\` 付き。hangar はこちらを使う）。 |
| \`messages.json\` | 筋書き 3 の後の \`GET /api/session/{id}/message?limit=100\` の答え。data は新しい順。 |
| \`messages-pages.json\` | 同じ時点で \`limit=4\` と \`cursor\` で送った答えの並び（\`query\`、\`status\`、\`body\`）。 |
| \`messages-while-form.json\` | 筋書き 1 で form を待っている間の答え。 |
| \`messages-while-running.json\` | 筋書き 2 で \`sleep 20\` が動いている間の答え。 |
`;
}
