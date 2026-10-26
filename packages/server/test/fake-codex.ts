import { createRequire } from 'node:module';
import { writeFakeNodeTool } from './fake-bin.ts';

const requireFromHere = createRequire(import.meta.url);

/**
 * 実物の codex の代わり。版とログインのふりと、app-server の JSON-RPC の最小のふり（rollout は B5 で足す）。
 *
 * app-server のふり（`codex app-server --listen ws://127.0.0.1:<port> --ws-auth capability-token --ws-token-file <file> …`）：
 * - /healthz は token 無しで 200。WebSocket は `Authorization: Bearer <token>` が合わなければ 401。
 * - initialize、thread/start、turn/start、turn/interrupt、thread/resume、thread/fork、thread/loaded/list に答える。
 *   thread/resume の cwd は、そのプロセスで最初の resume のときだけ会話の cwd を上書きする（E0）。thread/fork は rollout のある新しい会話を作る。
 *   thread/resume は、ターンがまだ無いスレッドには実物と同じ -32600 `no rollout found for thread id …` を返す。
 * - 通知：thread/started（接続の URL の query に `tui=1&cwd=…` を付けた接続が来たとき、ephemeral:false を全接続へ。実物の TUI の接続の真似）、
 *   turn/start で thread/status/changed(active)、turn/started（購読した接続だけ）、少しあとに turn/completed と idle。
 *   最初のターンのあと ephemeral:true の thread/started を 1 つ（題名の生成の真似）。
 * - 入力の文の頭で振る舞いを変える（B4）。`ask:command`、`ask:file`、`ask:perm`、`ask:input`、`ask:mcp` は、承認や質問の要求を購読した接続へ送り、
 *   status を waitingOnApproval か waitingOnUserInput にして待つ（実物の TUI の代わりに、どれかの接続が id つきの応答を返すと、serverRequest/resolved を全接続へ流し、status を戻して完了する）。
 *   `hang` は完了しない。`thread/read` は status を返す。`__resolve` を呼ぶ代わりに、接続は応答（{id, result}）を返すだけでよい。
 * - SIGTERM で止まる。`fakeGrandchild` の指定があれば、孫（長く眠る子）を 1 つ起こす（止め方の試験用）。
 * `--version` は `codex-cli <version>` を出して 0 で終わる。`login status` は loggedIn なら 0、でなければ 1（実物と同じく標準エラーへ文を出す）。
 * 起動のたびに、argv と環境変数のキーを logFile に 1 行 1 件の JSON で足す（環境の漏れを試験で見る）。
 */
export type FakeCodexOptions = {
  version?: string;
  loggedIn?: boolean;
  /** 起動の記録の置き場。 */
  logFile?: string;
  /** app-server が起動時に孫を 1 つ起こし、その pid をこのファイルに書く。 */
  grandchildPidFile?: string;
  /** SIGTERM を無視する（SIGKILL までの猶予の試験用）。 */
  ignoreSigterm?: boolean;
  /** 起動の直後に落ちる（標準エラーへ書いて 1 で終わる）。 */
  crashOnStart?: boolean;
  /** 受けた要求（method と params）を 1 行 1 件の JSON で足す置き場。`{ ev: 'rpc', method, params }`、通知を送ったときは `{ ev: 'note', method }`。 */
  rpcLogFile?: string;
  /** mcpServerStatus/list が hangar を connected と答えるまでの問い合わせの回数（既定 0）。'failed' なら failed と答える。 */
  mcpPendingPolls?: number | 'failed';
  /** ターンが終わるまでの時間（ミリ秒、既定 60）。interrupt の試験では長くする。 */
  turnMs?: number;
  /** app-server が起動時から持つ会話（rollout がある。hangar の外で作られたもの）。resume と fork の試験用。 */
  knownThreads?: { id: string; cwd: string }[];
};

export function writeFakeCodex(dir: string, o: FakeCodexOptions = {}): string {
  const version = o.version ?? '0.164.0';
  const script = `
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(${JSON.stringify(requireFromHere.resolve('ws'))});
const { WebSocketServer } = require('ws');
const args = process.argv.slice(2);
const OPTS = ${JSON.stringify({ g: o.grandchildPidFile ?? null, i: !!o.ignoreSigterm, c: !!o.crashOnStart, r: o.rpcLogFile ?? null, m: o.mcpPendingPolls ?? 0, t: o.turnMs ?? 60, k: o.knownThreads ?? [] })};
const rlog = (o) => { if (OPTS.r) fs.appendFileSync(OPTS.r, JSON.stringify(o) + '\\n'); };
${o.logFile ? `fs.appendFileSync(${JSON.stringify(o.logFile)}, JSON.stringify({ argv: args, env: process.env }) + '\\n');` : ''}
if (args[0] === '--version') { process.stdout.write('codex-cli ${version}\\n'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  if (${o.loggedIn === false ? 'false' : 'true'}) { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }
  process.stderr.write('Not logged in\\n'); process.exit(1);
}
if (args[0] === 'app-server') await appServer(args);
else {
process.stderr.write('fake codex: unsupported ' + args.join(' ') + '\\n'); process.exit(2);
}

async function appServer(args) {
  if (OPTS.c) { process.stderr.write('fake codex app-server: crashed on start\\n'); process.exit(1); }
  const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
  const listen = new URL(flag('--listen'));
  const token = fs.readFileSync(flag('--ws-token-file'), 'utf8').trim();
  const threads = new Map(); // id -> { cwd, turns, subscribers:Set }
  let seq = 0;
  for (const k of OPTS.k) threads.set(k.id, { cwd: k.cwd, turns: 1, subscribers: new Set(), loaded: false });
  let turnSeq = 0;
  let polls = 0;
  const uuid = () => '01a00000-0000-7000-8000-' + String(++seq).padStart(12, '0');
  const clients = new Set();
  const waiting = new Map(); // 要求の id -> 解けたときの続き
  let reqSeq = 100;
  const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const broadcast = (m, p) => { for (const c of clients) send(c, { method: m, params: p }); };
  const threadBody = (id, eph) => { const t = threads.get(id); return { id, sessionId: id, ephemeral: eph, cwd: t?.cwd ?? null, path: null, environments: eph ? [] : [{ cwd: t?.cwd ?? null }] }; };
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== 'Bearer ' + token) { socket.write('HTTP/1.1 401 Unauthorized\\r\\nContent-Length: 0\\r\\n\\r\\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('tui') === '1') {
      const id = uuid();
      threads.set(id, { cwd: u.searchParams.get('cwd'), turns: 0, subscribers: new Set(), tui: true });
      setTimeout(() => broadcast('thread/started', { thread: threadBody(id, false) }), 20);
    }
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.id !== undefined && m.method === undefined) {
        // サーバからの要求への応答（実物では TUI が返す）。
        const w = waiting.get(m.id);
        if (w) { waiting.delete(m.id); w(); }
        return;
      }
      if (m.id === undefined) return;
      const ok = (result) => send(ws, { id: m.id, result });
      const fail = (code, message) => send(ws, { id: m.id, error: { code, message } });
      const p = m.params ?? {};
      rlog({ ev: 'rpc', method: m.method, params: p });
      switch (m.method) {
        case 'initialize': return ok({ userAgent: 'fake-codex/0', codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos' });
        case 'thread/start': {
          const id = uuid();
          threads.set(id, { cwd: p.cwd ?? null, turns: 0, subscribers: new Set([ws]) });
          ok({ thread: threadBody(id, false), cwd: p.cwd ?? null, model: p.model ?? 'fake-model', approvalPolicy: p.approvalPolicy ?? 'on-request', sandbox: p.sandbox ?? 'workspace-write' });
          setTimeout(() => broadcast('thread/started', { thread: threadBody(id, false) }), 5);
          return;
        }
        case 'mcpServerStatus/list': {
          const has = args.some((a) => a.startsWith('mcp_servers.hangar.url='));
          polls++;
          const status = !has ? null : OPTS.m === 'failed' ? 'failed' : polls > OPTS.m ? 'connected' : 'starting';
          return ok({ data: has ? [{ name: 'hangar', runtimeStatus: status, authStatus: 'bearerToken', tools: {}, resources: [], resourceTemplates: [] }] : [] });
        }
        case 'thread/read': {
          const t = threads.get(p.threadId);
          if (!t) return fail(-32600, 'thread not found: ' + p.threadId);
          return ok({ thread: { ...threadBody(p.threadId, false), turns: t.current ? [{ id: t.current.id, status: 'inProgress' }] : [], status: t.status ?? { type: t.current ? 'active' : 'idle', ...(t.current ? { activeFlags: [] } : {}) } } });
        }
        case 'thread/loaded/list': return ok({ data: [...threads.keys()] });
        case 'thread/resume': {
          const t = threads.get(p.threadId);
          if (!t) return fail(-32600, 'no rollout found for thread id ' + p.threadId);
          if (t.turns === 0) return fail(-32600, 'no rollout found for thread id ' + p.threadId);
          t.subscribers.add(ws);
          if (!t.loaded && p.cwd) t.cwd = p.cwd;
          t.loaded = true;
          return ok({ thread: threadBody(p.threadId, false), cwd: t.cwd });
        }
        case 'thread/fork': {
          const src = threads.get(p.threadId);
          if (!src || src.turns === 0) return fail(-32600, 'no rollout found for thread id ' + p.threadId);
          const id = uuid();
          threads.set(id, { cwd: p.cwd ?? src.cwd, turns: 1, subscribers: new Set([ws]), loaded: true });
          ok({ thread: threadBody(id, false), cwd: p.cwd ?? src.cwd });
          setTimeout(() => broadcast('thread/started', { thread: threadBody(id, false) }), 5);
          return;
        }
        case 'turn/start': {
          const t = threads.get(p.threadId);
          if (!t) return fail(-32600, 'thread not found: ' + p.threadId);
          const turn = { id: 'turn-' + (++turnSeq), status: 'inProgress', items: [] };
          t.turns++;
          t.subscribers.add(ws);
          t.current = turn;
          t.status = undefined;
          ok({ turn });
          const first = t.turns === 1;
          broadcast('thread/status/changed', { threadId: p.threadId, status: { type: 'active', activeFlags: [] } });
          for (const c of t.subscribers) send(c, { method: 'turn/started', params: { threadId: p.threadId, turn } });
          if (first) { const eid = uuid(); threads.set(eid, { cwd: null, turns: 0, subscribers: new Set() }); setTimeout(() => broadcast('thread/started', { thread: threadBody(eid, true) }), 10); }
          const text = String(p.input?.[0]?.text ?? '');
          const kind = text.startsWith('ask:') ? text.slice(4) : null;
          const setStatus = (status) => { t.status = status; broadcast('thread/status/changed', { threadId: p.threadId, status }); };
          const finish = () => {
            t.current = null;
            t.status = { type: 'idle' };
            for (const c of t.subscribers) send(c, { method: 'turn/completed', params: { threadId: p.threadId, turn: { ...turn, status: 'completed' } } });
            broadcast('thread/status/changed', { threadId: p.threadId, status: { type: 'idle' } });
          };
          if (text === 'hang') return;
          if (kind) {
            setTimeout(() => {
              const id = ++reqSeq;
              const common = { threadId: p.threadId, turnId: turn.id, itemId: 'item-' + id, startedAtMs: 1 };
              const reqs = {
                command: ['item/commandExecution/requestApproval', { ...common, command: 'rm -rf build', cwd: t.cwd, reason: 'needs write' }, 'waitingOnApproval'],
                file: ['item/fileChange/requestApproval', { ...common, grantRoot: '/w/out', reason: 'write outside' }, 'waitingOnApproval'],
                perm: ['item/permissions/requestApproval', { ...common, cwd: t.cwd, reason: 'network please', permissions: { network: { enabled: true }, fileSystem: { write: ['/w/out'] } } }, 'waitingOnApproval'],
                input: ['item/tool/requestUserInput', { ...common, isBlocking: true, questions: [{ id: 'q1', header: 'Pick', question: 'Which one?', options: [{ label: 'a', description: 'A' }] }] }, 'waitingOnUserInput'],
                mcp: ['mcpServer/elicitation/request', { threadId: p.threadId, turnId: turn.id, serverName: 'srv', mode: 'form', message: 'Need a value', requestedSchema: {} }, 'waitingOnUserInput'],
              }[kind];
              setStatus({ type: 'active', activeFlags: [reqs[2]] });
              for (const c of t.subscribers) send(c, { id, method: reqs[0], params: reqs[1] });
              waiting.set(id, () => {
                broadcast('serverRequest/resolved', { threadId: p.threadId, requestId: id });
                setStatus({ type: 'active', activeFlags: [] });
                setTimeout(finish, 30);
              });
            }, 10);
            return;
          }
          t.timer = setTimeout(() => {
            t.current = null;
            for (const c of t.subscribers) send(c, { method: 'turn/completed', params: { threadId: p.threadId, turn: { ...turn, status: 'completed' } } });
            broadcast('thread/status/changed', { threadId: p.threadId, status: { type: 'idle' } });
          }, OPTS.t);
          return;
        }
        case 'turn/interrupt': {
          const t = threads.get(p.threadId);
          if (!t || !t.current) return fail(-32600, 'no active turn');
          clearTimeout(t.timer);
          const turn = t.current;
          t.current = null;
          ok({});
          for (const c of t.subscribers) send(c, { method: 'turn/completed', params: { threadId: p.threadId, turn: { ...turn, status: 'interrupted' } } });
          broadcast('thread/status/changed', { threadId: p.threadId, status: { type: 'idle' } });
          return;
        }
        default: return fail(-32601, 'method not found: ' + m.method);
      }
    });
  });
  await new Promise((r) => server.listen(Number(listen.port), listen.hostname, r));
  if (OPTS.g) {
    const gc = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' });
    fs.writeFileSync(OPTS.g, String(gc.pid));
  }
  process.on('SIGTERM', () => { rlog({ ev: 'sigterm' }); if (OPTS.i) return; process.exit(0); });
  await new Promise(() => {});
}
`;
  return writeFakeNodeTool(dir, 'codex', script);
}
