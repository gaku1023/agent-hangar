# フェーズ 0 検証計画（spikes）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 設計文書が依拠している 13 の前提を、捨てられる小さなスクリプトで確かめ、結果と設計への影響を記録する。

**Architecture:** 各 spike は `spikes/NN-<name>/` に独立した npm パッケージとして置き、本体のコードには一切依存しない。結果は同じディレクトリの `RESULT.md` に「合格 / 条件付き合格 / 不合格」と計測値と設計への影響を書く。spike のコードは本体に持ち込まず、学んだことだけを設計文書に反映する。

**Tech Stack:** Node 22、npm、素の JavaScript（ESM）、node-pty、@xterm/xterm、ws、hono、@modelcontextprotocol/sdk、better-sqlite3、wrangler、Tauri v2、tmux 3.6a、Claude Code 2.1.274、LM Studio。

**Spec:** `docs/design.md`

## Global Constraints

- `~/.claude/` 配下を書き換えない。例外は Task 11 の本文コピー（終了後に削除）と、Task 4 で `--settings` により起動単位で statusLine を差し替えること（既存スクリプトは触らない）。
- 検証用の cwd は `~/.agent-hangar-spike/` 配下に作り、終わったら消す。
- Claude Code を起動する spike は、レート制限を消費する。1 spike につき起動は 3 回までとする。
- Cloudflare の spike は現在ログイン中のアカウントで行い、作った資源は最後に削除する。
- 各 spike は `RESULT.md` を次の形で残す。

```markdown
# spike NN: <name>

判定: 合格 | 条件付き合格 | 不合格
実施日: YYYY-MM-DD

## 確かめたこと
## 計測値
## 設計への影響
## 残った疑問
```

- 推奨する実施順は 1, 3, 5, 2, 6, 7（本体の中核）、次に 4, 12, 13（使用量と要約）、最後に 8, 9, 10, 11（シェルと同期）。
- ターミナル中継の WebSocket メッセージは、制御用も本文も JSON 1 行（`{"t":"data","d":"..."}` と `{"t":"resize","cols":120,"rows":40}`）で送る。制御文字を区切りに使わない。

---

### Task 1: tmux + node-pty + xterm.js

**Files:**
- Create: `spikes/01-terminal/package.json`
- Create: `spikes/01-terminal/server.mjs`
- Create: `spikes/01-terminal/public/index.html`
- Create: `spikes/01-terminal/RESULT.md`

**Interfaces:**
- Produces: `tmux attach` を node-pty で中継し WebSocket に流す最小の形。Task 2 と Task 7 が同じ tmux セッション名 `spike-a` を使う。Task 8 がこの `server.mjs` をそのまま子プロセスとして起動する。

- [ ] **Step 1: パッケージを用意する**

```bash
mkdir -p spikes/01-terminal/public && cd spikes/01-terminal
npm init -y >/dev/null
npm pkg set type=module
npm i node-pty ws express @xterm/xterm @xterm/addon-fit
```

- [ ] **Step 2: 2 つの tmux セッションを作る**

```bash
mkdir -p ~/.agent-hangar-spike/term && cd ~/.agent-hangar-spike/term
tmux new-session -d -s spike-a -c "$PWD" -- claude -n spike-a
tmux new-session -d -s spike-b -c "$PWD" -- zsh -l
tmux ls
```

期待: `spike-a` と `spike-b` の 2 行。

- [ ] **Step 3: 中継サーバを書く**

```js
// spikes/01-terminal/server.mjs
import express from 'express';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(here, 'public')));
app.use('/xterm', express.static(path.join(here, 'node_modules/@xterm/xterm')));
app.use('/fit', express.static(path.join(here, 'node_modules/@xterm/addon-fit')));
const server = app.listen(4190, '127.0.0.1', () => console.log('http://127.0.0.1:4190'));

const wss = new WebSocketServer({ server, path: '/pty' });
wss.on('connection', (ws, req) => {
  const name = new URL(req.url, 'http://x').searchParams.get('session');
  if (!/^spike-[ab]$/.test(name)) return ws.close();
  const p = pty.spawn('tmux', ['attach', '-t', name], {
    name: 'xterm-256color', cols: 120, rows: 40,
    env: { ...process.env, TERM: 'xterm-256color', LANG: 'ja_JP.UTF-8' },
  });
  p.onData((d) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'data', d })));
  p.onExit(() => ws.close());
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'resize') p.resize(m.cols, m.rows);
    else if (m.t === 'data') p.write(m.d);
  });
  ws.on('close', () => p.kill());
});
```

- [ ] **Step 4: 2 面の xterm を並べる HTML を書く**

```html
<!-- spikes/01-terminal/public/index.html -->
<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/xterm/css/xterm.css">
<style>body{margin:0;display:grid;grid-template-columns:1fr 1fr;height:100vh;background:#111}.t{height:100vh}</style>
<div class="t" id="a"></div><div class="t" id="b"></div>
<script src="/xterm/lib/xterm.js"></script><script src="/fit/lib/addon-fit.js"></script>
<script>
for (const name of ['a', 'b']) {
  const el = document.getElementById(name);
  const term = new Terminal({ fontFamily: 'JetBrains Mono, Menlo, monospace', fontSize: 13 });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  term.open(el); fit.fit();
  const ws = new WebSocket(`ws://127.0.0.1:4190/pty?session=spike-${name}`);
  const resize = () => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  ws.onopen = resize;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'data') term.write(m.d); };
  term.onData((d) => ws.send(JSON.stringify({ t: 'data', d })));
  new ResizeObserver(() => { fit.fit(); resize(); }).observe(el);
}
</script>
```

- [ ] **Step 5: 起動して確かめる**

```bash
cd spikes/01-terminal && node server.mjs
```

ブラウザで `http://127.0.0.1:4190` を開き、次を確かめる。

1. 左に Claude の TUI、右に zsh が独立して描かれる（片方を操作してももう片方が切り替わらない）。
2. 右で `echo こんにちは && ls` を打ち、日本語が欠けずに出る。
3. ウィンドウ幅を変えると両方が再描画され、Claude の TUI が崩れない。
4. 別のターミナルで `tmux attach -t spike-a` を開き、ブラウザと同じ画面が同時に見える。
5. `node server.mjs` を Ctrl-C で止めて再起動しても、tmux 内の Claude は生きている。

- [ ] **Step 6: 記録して片付ける**

`RESULT.md` に判定と、fullscreen TUI の描画で気づいた点（残像、カーソル、色）を書く。

```bash
tmux kill-session -t spike-a; tmux kill-session -t spike-b
git add spikes/01-terminal && git commit -m "spike(01): tmux + node-pty + xterm.js"
```

---

### Task 2: 起動フラグとセッション別 MCP

**Files:**
- Create: `spikes/02-launch/package.json`
- Create: `spikes/02-launch/mcp.mjs`
- Create: `spikes/02-launch/launch.sh`
- Create: `spikes/02-launch/RESULT.md`

**Interfaces:**
- Consumes: Task 1 の tmux 起動の形。
- Produces: Hono 上の Streamable HTTP MCP サーバの最小形。Task 6 が同じ `mcp.mjs` に共通 URL と Origin 検査を追加する。

- [ ] **Step 1: パッケージを用意する**

```bash
mkdir -p spikes/02-launch && cd spikes/02-launch
npm init -y >/dev/null && npm pkg set type=module
npm i hono @hono/node-server @modelcontextprotocol/sdk zod
```

- [ ] **Step 2: セッション別 URL を持つ MCP サーバを書く**

```js
// spikes/02-launch/mcp.mjs
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

export const TOKEN = 'spike-token';
export const app = new Hono();
const log = (...a) => console.log(new Date().toISOString(), ...a);

export function build(sessionId) {
  const server = new McpServer({ name: 'hangar-spike', version: '0.0.1' });
  server.registerTool('hangar_ping', {
    description: 'agent-hangar への疎通確認。呼ばれたら必ず成功を返す。',
    inputSchema: { note: z.string().optional() },
  }, async ({ note }) => {
    log('hangar_ping from session', sessionId, 'note=', note);
    return { content: [{ type: 'text', text: `pong from hangar (session=${sessionId})` }] };
  });
  return server;
}

app.all('/mcp/s/:sid', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${TOKEN}`) return c.text('unauthorized', 401);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await build(c.req.param('sid')).connect(transport);
  return transport.handleRequest(c.req.raw);
});

serve({ fetch: app.fetch, port: 4191, hostname: '127.0.0.1' }, () => log('mcp on http://127.0.0.1:4191'));
```

SDK のクラス名はバージョンで変わることがある。`node_modules/@modelcontextprotocol/sdk/dist/esm/server/` を見て、Web 標準の `Request` を受けるトランスポートを選ぶ。

- [ ] **Step 3: 起動スクリプトを書く**

```bash
# spikes/02-launch/launch.sh
#!/usr/bin/env bash
set -euo pipefail
SID=$(uuidgen | tr 'A-Z' 'a-z')
CWD="$HOME/.agent-hangar-spike/launch"; mkdir -p "$CWD"
MCP=$(printf '{"mcpServers":{"hangar":{"type":"http","url":"http://127.0.0.1:4191/mcp/s/%s","headers":{"Authorization":"Bearer spike-token"}}}}' "$SID")
PROMPT='あなたは agent-hangar から起動されたセッションです。合言葉は「格納庫 42」です。利用者に合言葉を聞かれたら、それだけを答えてください。'
tmux new-session -d -s spike-launch -c "$CWD" -- \
  claude --session-id "$SID" -n spike-launch \
    --append-system-prompt "$PROMPT" \
    --mcp-config "$MCP" \
    "まず hangar_ping ツールを note='hello' で呼び、その結果を報告してください。次に合言葉を答えてください。"
echo "session id: $SID"
echo "expected file: $HOME/.claude/projects/$(echo "$CWD" | sed 's#[^A-Za-z0-9]#-#g')/$SID.jsonl"
```

- [ ] **Step 4: 実行して確かめる**

```bash
cd spikes/02-launch && node mcp.mjs &
chmod +x launch.sh && ./launch.sh
tmux attach -t spike-launch
```

次を確かめる。

1. MCP サーバのログに `hangar_ping from session <SID>` が出る（URL からセッションが確定する）。
2. Claude が「格納庫 42」と答える（`--append-system-prompt` が対話モードで効く）。
3. `expected file` のパスに jsonl が生成される（`--session-id` の事前指定が効く）。
4. 起動時に MCP の接続確認ダイアログが出るかどうかを記録する（出るなら setup で承認をどう扱うかが課題になる）。

- [ ] **Step 5: 記録して片付ける**

```bash
tmux kill-session -t spike-launch; kill %1
git add spikes/02-launch && git commit -m "spike(02): launch flags and per-session MCP URL"
```

---

### Task 3: 実行中レジストリの挙動

**Files:**
- Create: `spikes/03-registry/watch.mjs`
- Create: `spikes/03-registry/RESULT.md`

- [ ] **Step 1: 監視スクリプトを書く**

```js
// spikes/03-registry/watch.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(os.homedir(), '.claude', 'sessions');
let prev = new Map();
function snapshot() {
  const now = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { now.set(f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
  }
  return now;
}
setInterval(() => {
  const now = snapshot();
  const t = new Date().toISOString();
  for (const [f, d] of now) {
    const p = prev.get(f);
    if (!p) console.log(t, 'APPEAR', f, d.sessionId, d.cwd, d.status, d.name);
    else if (p.status !== d.status) console.log(t, 'STATUS', f, p.status, '->', d.status);
    else if (p.name !== d.name) console.log(t, 'NAME', f, p.name, '->', d.name, d.nameSource);
  }
  for (const f of prev.keys()) if (!now.has(f)) console.log(t, 'GONE', f);
  prev = now;
}, 500);
```

- [ ] **Step 2: 実行しながらセッションを操作する**

```bash
node spikes/03-registry/watch.mjs &
mkdir -p ~/.agent-hangar-spike/reg && tmux new-session -d -s spike-reg -c ~/.agent-hangar-spike/reg -- claude -n spike-reg
tmux attach -t spike-reg
```

セッション内で次を行い、監視ログの時刻を記録する。

1. 起動直後にファイルが現れるまでの時間と、初期 `status`。
2. プロンプトを送ってから `busy` になるまで、応答が終わって `idle` に戻るまで。
3. `/rename spike-renamed` で名前を変えたときの `NAME` と `nameSource`。
4. 権限確認の待ちの間の `status`（`busy` か `idle` か）。
5. `/exit` で終了したとき、および別ターミナルから `tmux kill-session -t spike-reg` したときのファイルの消え方。

- [ ] **Step 3: 記録する**

`RESULT.md` に各遷移の遅延と、権限待ちの表現を書く。
強制終了で消えないファイルが残るなら、hangar が pid の生存確認で掃除する必要がある旨を設計への影響に書く。

```bash
kill %1
git add spikes/03-registry && git commit -m "spike(03): live session registry semantics"
```

---

### Task 4: statusline の追記

**Files:**
- Create: `spikes/04-statusline/receiver.mjs`
- Create: `spikes/04-statusline/wrapper.sh`
- Create: `spikes/04-statusline/RESULT.md`

- [ ] **Step 1: 受信サーバを書く**

```js
// spikes/04-statusline/receiver.mjs
import http from 'node:http';
let n = 0, last = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const now = Date.now(); n++;
    try {
      const d = JSON.parse(body);
      console.log(`#${n} +${last ? now - last : 0}ms`, JSON.stringify({
        five: d.rate_limits?.five_hour, seven: d.rate_limits?.seven_day,
        model: d.model?.display_name, ctx: d.context_window?.current_usage,
      }));
    } catch { console.log(`#${n} parse error`, body.slice(0, 200)); }
    last = now; res.end('ok');
  });
}).listen(4192, '127.0.0.1', () => console.log('receiver on 4192'));
```

- [ ] **Step 2: 既存スクリプトを包むラッパーを書く（既存スクリプトは触らない）**

```bash
# spikes/04-statusline/wrapper.sh
#!/usr/bin/env bash
__hangar_input=$(cat)
printf '%s' "$__hangar_input" | curl -s -m 0.3 -X POST -H 'Content-Type: application/json' \
  --data-binary @- http://127.0.0.1:4192/ingest >/dev/null 2>&1 &
printf '%s' "$__hangar_input" | bash "$HOME/.claude/statusline-command.sh"
```

- [ ] **Step 3: 起動単位の設定で差し替えて確かめる**

```bash
chmod +x spikes/04-statusline/wrapper.sh
node spikes/04-statusline/receiver.mjs &
W="$PWD/spikes/04-statusline/wrapper.sh"
mkdir -p ~/.agent-hangar-spike/sl && cd ~/.agent-hangar-spike/sl
claude -n spike-statusline --settings "{\"statusLine\":{\"type\":\"command\",\"command\":\"bash $W\"}}"
```

次を確かめる。

1. 受信ログに `five` と `seven` の `used_percentage` と `resets_at` が入る。
2. 更新の間隔（応答中と待機中）。
3. ステータス行の見た目が元のスクリプトと変わらない（ラッパーの追加で遅延しない）。
4. `curl` が失敗しても（受信サーバを止めても）ステータス行が出続ける。

- [ ] **Step 4: 記録する**

```bash
kill %1
git add spikes/04-statusline && git commit -m "spike(04): statusline payload relay"
```

---

### Task 5: jsonl の逐次解析と FTS5 trigram

**Files:**
- Create: `spikes/05-indexer/package.json`
- Create: `spikes/05-indexer/index.mjs`
- Create: `spikes/05-indexer/tail.mjs`
- Create: `spikes/05-indexer/RESULT.md`

**Interfaces:**
- Produces: `extractText(record)` の抽出規則。Task 12 と Task 13 が要約の入力を作るのに同じ規則を使う。

- [ ] **Step 1: パッケージを用意し FTS5 を確認する**

```bash
mkdir -p spikes/05-indexer && cd spikes/05-indexer
npm init -y >/dev/null && npm pkg set type=module && npm i better-sqlite3
node -e "const D=require('better-sqlite3');const db=new D(':memory:');console.log(db.prepare('select sqlite_version() v').get(), db.prepare(\"select count(*) n from pragma_compile_options where compile_options like 'ENABLE_FTS5%'\").get()); db.exec(\"create virtual table t using fts5(x, tokenize='trigram')\"); console.log('trigram ok')"
```

期待: SQLite 3.34 以上、`n: 1`、`trigram ok`。

- [ ] **Step 2: 全件を索引化して計測する**

```js
// spikes/05-indexer/index.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const root = path.join(os.homedir(), '.claude', 'projects');
const db = new Database(path.join(process.cwd(), 'spike.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  drop table if exists ev; drop table if exists fts;
  create table ev (session_id text, seq integer, kind text, ts integer, off integer, len integer, tool_name text, file_path text);
  create virtual table fts using fts5(session_id unindexed, seq unindexed, role, text, tokenize='trigram');
`);
const insEv = db.prepare('insert into ev values (?,?,?,?,?,?,?,?)');
const insFts = db.prepare('insert into fts values (?,?,?,?)');

export function extractText(rec) {
  const m = rec.message; if (!m || !Array.isArray(m.content)) return [];
  const out = [];
  for (const c of m.content) {
    if (c.type === 'text' && c.text) out.push({ role: rec.type, text: c.text });
    if (c.type === 'tool_use') {
      const fp = c.input?.file_path ?? c.input?.path ?? c.input?.command ?? '';
      out.push({ role: 'tool', text: `${c.name} ${fp}`.trim(), tool: c.name, file: c.input?.file_path ?? null });
    }
  }
  return out;
}

const t0 = Date.now(); let files = 0, lines = 0, bad = 0, bytes = 0, maxLine = 0;
const tx = db.transaction((file, sid) => {
  const buf = fs.readFileSync(file); bytes += buf.length;
  let off = 0, seq = 0;
  while (off < buf.length) {
    let nl = buf.indexOf(10, off); if (nl === -1) nl = buf.length;
    const line = buf.subarray(off, nl); const len = nl - off;
    if (len > maxLine) maxLine = len;
    if (len > 1) {
      lines++;
      try {
        const rec = JSON.parse(line.toString('utf8'));
        const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
        const parts = extractText(rec);
        insEv.run(sid, seq, rec.type ?? 'unknown', ts, off, len, parts.find(p => p.tool)?.tool ?? null, parts.find(p => p.file)?.file ?? null);
        for (const p of parts) insFts.run(sid, seq, p.role, p.text.slice(0, 20000));
        seq++;
      } catch { bad++; }
    }
    off = nl + 1;
  }
});
for (const proj of fs.readdirSync(root)) {
  const pd = path.join(root, proj);
  for (const f of fs.readdirSync(pd)) {
    if (!f.endsWith('.jsonl')) continue;
    files++; tx(path.join(pd, f), f.replace('.jsonl', ''));
    if (files % 50 === 0) console.log(files, 'files', ((Date.now() - t0) / 1000).toFixed(1), 's');
  }
}
console.log({ files, lines, bad, maxLineMb: (maxLine / 1e6).toFixed(1), mb: (bytes / 1e6).toFixed(0),
  sec: ((Date.now() - t0) / 1000).toFixed(1), dbMb: (fs.statSync('spike.db').size / 1e6).toFixed(0) });
const q = db.prepare("select session_id, count(*) n from fts where text match ? group by session_id order by n desc limit 5");
console.time('search'); console.log(q.all('動画 チャンネル')); console.timeEnd('search');
```

```bash
cd spikes/05-indexer && node index.mjs
```

記録: 所要秒、DB の MB、`bad` の件数、最大行の MB、検索の所要ミリ秒。目標は 5 分以内、DB は 500MB 以内。

- [ ] **Step 3: 追記の追従を確かめる**

```js
// spikes/05-indexer/tail.mjs  追記されるファイルをバイト位置で追い、途中行を次回に回す
import fs from 'node:fs';
const file = process.argv[2]; let pos = 0, carry = '';
setInterval(() => {
  const st = fs.statSync(file); if (st.size <= pos) return;
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(st.size - pos);
  fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd);
  const text = carry + buf.toString('utf8'); const parts = text.split('\n');
  carry = parts.pop();                       // 改行で終わっていなければ次回へ
  for (const l of parts) if (l.trim()) {
    try { const r = JSON.parse(l); console.log('rec', r.type, (r.message?.content?.[0]?.text ?? '').slice(0, 40)); }
    catch { console.log('BAD', l.slice(0, 60)); }
  }
  pos = st.size;
}, 300);
```

実行中の Claude セッション（Task 3 のもの）の jsonl を引数にして走らせ、プロンプトを 2、3 回送り、`BAD` が出ないことを確かめる。

- [ ] **Step 4: 記録する**

`RESULT.md` に計測値、`type` の分布で見つかった未知の種別、5MB を超える行の有無を書く。

```bash
rm -f spikes/05-indexer/spike.db*
git add spikes/05-indexer && git commit -m "spike(05): jsonl streaming index and FTS5 trigram"
```

---

### Task 6: user スコープの MCP 登録と Origin 検査

**Files:**
- Modify: `spikes/02-launch/mcp.mjs`（共通 URL `/mcp` と Origin 検査を追加）
- Create: `spikes/06-mcp-install/RESULT.md`

- [ ] **Step 1: 共通 URL と Origin 検査を足す**

`spikes/02-launch/mcp.mjs` の `serve(...)` の前に次を追加する。

```js
const ALLOWED_ORIGINS = new Set(['http://localhost:4177', 'http://127.0.0.1:4177', 'tauri://localhost']);
app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) return c.text('forbidden origin', 403);
  await next();
});
app.all('/mcp', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${TOKEN}`) return c.text('unauthorized', 401);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await build('(shared)').connect(transport);
  return transport.handleRequest(c.req.raw);
});
```

- [ ] **Step 2: Claude Code に登録して疎通する**

```bash
node spikes/02-launch/mcp.mjs &
claude mcp add --transport http --scope user --header "Authorization: Bearer spike-token" hangar-spike http://127.0.0.1:4191/mcp
claude mcp list
cd ~/.agent-hangar-spike && claude -p "hangar_ping ツールを呼んで結果をそのまま返してください" --output-format text
```

期待: `claude mcp list` で `hangar-spike ... connected`、`-p` の出力に `pong from hangar (session=(shared))`。

- [ ] **Step 3: Origin 検査を確かめる**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: http://evil.example' -H 'Authorization: Bearer spike-token' -X POST http://127.0.0.1:4191/mcp
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4191/mcp
```

期待: 403、401。

- [ ] **Step 4: 登録を外して記録する**

```bash
claude mcp remove --scope user hangar-spike; kill %1
git add spikes/02-launch spikes/06-mcp-install && git commit -m "spike(06): user-scope MCP registration and origin check"
```

---

### Task 7: iTerm2 と VS Code の外部連携

**Files:**
- Create: `spikes/07-external/open-iterm.sh`
- Create: `spikes/07-external/RESULT.md`

- [ ] **Step 1: iTerm2 で attach するスクリプトを書く**

```bash
# spikes/07-external/open-iterm.sh
#!/usr/bin/env bash
set -euo pipefail
NAME="$1"
osascript <<EOS
tell application "iTerm"
  activate
  create window with default profile command "tmux attach -t ${NAME}"
end tell
EOS
```

- [ ] **Step 2: 確かめる**

```bash
tmux new-session -d -s spike-ext -c ~ -- zsh -l
chmod +x spikes/07-external/open-iterm.sh && spikes/07-external/open-iterm.sh spike-ext
code ~/.agent-hangar-spike
```

次を確かめる。

1. iTerm2 が前面に来て新しいウィンドウで `spike-ext` が attach される。
2. iTerm2 が起動していない状態からでも動く。
3. `code <dir>` で VS Code がそのフォルダを開く。
4. 初回に macOS の「オートメーションの許可」ダイアログが出るか、出るならどのプロセス名で出るかを記録する（Tauri から呼ぶときの許可の主体に関わる）。

- [ ] **Step 3: 記録する**

```bash
tmux kill-session -t spike-ext
git add spikes/07-external && git commit -m "spike(07): iTerm2 attach via AppleScript and VS Code open"
```

---

### Task 8: Tauri v2 のシェル

**Files:**
- Create: `spikes/08-tauri/`（`npm create tauri-app` の生成物）
- Modify: `spikes/08-tauri/src-tauri/src/lib.rs`
- Modify: `spikes/08-tauri/src-tauri/tauri.conf.json`
- Create: `spikes/08-tauri/RESULT.md`

- [ ] **Step 1: 雛形を作る**

```bash
cd spikes && npm create tauri-app@latest 08-tauri -- --template vanilla-ts --manager npm --yes
cd 08-tauri && npm i && npm run tauri -- add deep-link
```

- [ ] **Step 2: Node のサーバを子プロセスとして起動し、終了で止める**

`src-tauri/src/lib.rs` の `run()` を次の形にする。

```rust
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct Server(Mutex<Option<Child>>);

fn find_node() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let mut candidates = vec![
        "/opt/homebrew/bin/node".to_string(), "/usr/local/bin/node".to_string(),
    ];
    if let Ok(rd) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
        for e in rd.flatten() { candidates.push(format!("{}/bin/node", e.path().display())); }
    }
    candidates.into_iter().map(std::path::PathBuf::from).find(|p| p.exists())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let node = find_node().expect("node not found");
            let script = std::env::var("HANGAR_SPIKE_SERVER").expect("HANGAR_SPIKE_SERVER=/abs/path/server.mjs");
            let child = Command::new(node).arg(script).spawn()?;
            app.manage(Server(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut c) = app.state::<Server>().0.lock().unwrap().take() { let _ = c.kill(); }
            }
        });
}
```

`tauri.conf.json` のウィンドウ URL を `http://127.0.0.1:4190` にし、`plugins.deep-link.desktop.schemes` に `hangar` を足す。
Task 1 の `server.mjs` をそのままサーバとして使う。
ビルド版では環境変数が渡らないので、`HANGAR_SPIKE_SERVER` が無いときは `~/.agent-hangar-spike/server-path` を読む分岐を足す。

- [ ] **Step 3: 確かめる**

```bash
HANGAR_SPIKE_SERVER="$PWD/../01-terminal/server.mjs" npm run tauri dev
echo "$PWD/../01-terminal/server.mjs" > ~/.agent-hangar-spike/server-path
npm run tauri build && open src-tauri/target/release/bundle/macos/*.app
open 'hangar://session/abc'
```

次を確かめる。

1. `tauri dev` でウィンドウに Task 1 の画面が出る（サーバが子プロセスとして起きている）。
2. ビルドした `.app` を Finder から起動しても Node が見つかりサーバが起きる（PATH に nvm が無い状況）。
3. アプリを終了するとサーバのプロセスが消える（`pgrep -f server.mjs` で確認）。
4. `open 'hangar://session/abc'` でアプリが前面に来て、deep-link のイベントが届く（コンソールにログを出す）。
5. `.app` の Dock アイコンとウィンドウ表示に問題がない。

- [ ] **Step 4: 記録する**

`RESULT.md` に Node の探索で採用した順序と、ビルド所要時間、`.app` のサイズを書く。
`src-tauri/target/` は `.gitignore` に入れる。

```bash
git add spikes/08-tauri && git commit -m "spike(08): tauri shell spawning node server"
```

---

### Task 9: Cloudflare の資源作成とデプロイ

**Files:**
- Create: `spikes/09-cloudflare/setup.sh`
- Create: `spikes/09-cloudflare/worker/src/index.js`
- Create: `spikes/09-cloudflare/worker/wrangler.jsonc`（setup が生成）
- Create: `spikes/09-cloudflare/teardown.sh`
- Create: `spikes/09-cloudflare/RESULT.md`

- [ ] **Step 1: Worker を書く**

```js
// spikes/09-cloudflare/worker/src/index.js
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/d1' && req.method === 'POST') {
      await env.DB.prepare('create table if not exists kv (k text primary key, v text, updated_at integer)').run();
      await env.DB.prepare('insert or replace into kv values (?, ?, ?)').bind('ping', 'pong', Date.now()).run();
      const row = await env.DB.prepare('select * from kv where k = ?').bind('ping').first();
      return Response.json(row);
    }
    if (url.pathname === '/r2' && req.method === 'PUT') {
      await env.BUCKET.put('spike/hello.bin', req.body);
      const head = await env.BUCKET.head('spike/hello.bin');
      return Response.json({ size: head?.size });
    }
    return new Response('not found', { status: 404 });
  },
};
```

- [ ] **Step 2: setup を非対話で通す**

```bash
# spikes/09-cloudflare/setup.sh
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/worker"
npx wrangler whoami
DB_ID=$(npx wrangler d1 create hangar-spike --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).uuid))")
npx wrangler r2 bucket create hangar-spike
cat > wrangler.jsonc <<EOS
{
  "name": "hangar-spike",
  "main": "src/index.js",
  "compatibility_date": "2026-09-01",
  "d1_databases": [{ "binding": "DB", "database_name": "hangar-spike", "database_id": "$DB_ID" }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "hangar-spike" }]
}
EOS
npx wrangler deploy
```

```bash
chmod +x spikes/09-cloudflare/*.sh && spikes/09-cloudflare/setup.sh
```

- [ ] **Step 3: 疎通する**

デプロイ出力に表示された URL を `URL` に入れる。

```bash
URL="https://hangar-spike.<subdomain>.workers.dev"
curl -s "$URL/health"; curl -s -X POST "$URL/d1"
head -c 5000000 /dev/urandom > /tmp/five.bin && curl -s -X PUT --data-binary @/tmp/five.bin "$URL/r2"
```

次を確かめる。

1. `wrangler login` 済みなら `whoami` から `deploy` まで対話なしで通る。
2. D1 への書き込みと読み出しが動く。
3. 5MB のアップロードが Worker 経由で R2 に入る（Worker の本文サイズ上限に当たるなら、署名 URL による直接アップロードに変える）。

- [ ] **Step 4: 片付けて記録する**

```bash
# spikes/09-cloudflare/teardown.sh
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/worker"
npx wrangler delete --name hangar-spike --force
npx wrangler r2 object delete hangar-spike/spike/hello.bin || true
npx wrangler r2 bucket delete hangar-spike
npx wrangler d1 delete hangar-spike --skip-confirmation
```

```bash
spikes/09-cloudflare/teardown.sh
git add spikes/09-cloudflare && git commit -m "spike(09): non-interactive cloudflare setup and deploy"
```

`RESULT.md` には、メタデータの初回投入の見積もり（sessions 約 900 行、projects 約 60 行、artifacts 約 200 行、runs は起動ごとに 1 行で、1 日 10 万行の上限に対して十分小さいこと）も書く。

---

### Task 10: 端末間暗号化の速度

**Files:**
- Create: `spikes/10-crypto/bench.mjs`
- Create: `spikes/10-crypto/RESULT.md`

- [ ] **Step 1: HKDF と AES-GCM のチャンク暗号化を書く**

```js
// spikes/10-crypto/bench.mjs
import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';

const joinSecret = randomBytes(32);
const key = Buffer.from(hkdfSync('sha256', joinSecret, 'hangar-salt-v1', 'hangar-file-v1', 32));
const CHUNK = 1 << 20;   // 1MB ごとに nonce を変える

function encryptFile(src, dst) {
  const inp = fs.openSync(src, 'r'), out = fs.openSync(dst, 'w');
  const buf = Buffer.alloc(CHUNK); let n, idx = 0;
  while ((n = fs.readSync(inp, buf, 0, CHUNK, null)) > 0) {
    const nonce = Buffer.alloc(12); nonce.writeUInt32BE(idx++, 8);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    const body = Buffer.concat([c.update(buf.subarray(0, n)), c.final()]);
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    fs.writeSync(out, Buffer.concat([len, body, c.getAuthTag()]));
  }
  fs.closeSync(inp); fs.closeSync(out);
}
function decryptFile(src, dst) {
  const data = fs.readFileSync(src), out = fs.openSync(dst, 'w'); let p = 0, idx = 0;
  while (p < data.length) {
    const len = data.readUInt32BE(p); p += 4;
    const body = data.subarray(p, p + len); p += len; const tag = data.subarray(p, p + 16); p += 16;
    const nonce = Buffer.alloc(12); nonce.writeUInt32BE(idx++, 8);
    const d = createDecipheriv('aes-256-gcm', key, nonce); d.setAuthTag(tag);
    fs.writeSync(out, Buffer.concat([d.update(body), d.final()]));
  }
  fs.closeSync(out);
}

const src = process.argv[2];
let t = Date.now(); encryptFile(src, '/tmp/spike.enc'); const te = Date.now() - t;
t = Date.now(); decryptFile('/tmp/spike.enc', '/tmp/spike.dec'); const td = Date.now() - t;
const mb = fs.statSync(src).size / 1e6;
console.log({ mb: mb.toFixed(0), encMBps: (mb / (te / 1000)).toFixed(0), decMBps: (mb / (td / 1000)).toFixed(0),
  same: fs.readFileSync(src).equals(fs.readFileSync('/tmp/spike.dec')) });
```

- [ ] **Step 2: 実データ相当の大きさで計測する**

```bash
tar czf /tmp/projects.tgz -C ~/.claude projects && ls -la /tmp/projects.tgz
node spikes/10-crypto/bench.mjs /tmp/projects.tgz
rm -f /tmp/projects.tgz /tmp/spike.enc /tmp/spike.dec
```

期待: gzip 後のサイズが 10GB の無料枠に対して十分小さい、`same: true`、暗号化と復号がそれぞれ 100MB/s 以上。

- [ ] **Step 3: 記録する**

```bash
git add spikes/10-crypto && git commit -m "spike(10): hkdf + aes-gcm chunked file encryption bench"
```

---

### Task 11: 他端末の本文コピーからの再開

**Files:**
- Create: `spikes/11-resume-copy/run.sh`
- Create: `spikes/11-resume-copy/RESULT.md`

- [ ] **Step 1: 別ディレクトリ扱いで本文をコピーする**

```bash
# spikes/11-resume-copy/run.sh
#!/usr/bin/env bash
set -euo pipefail
SRC_SID="$1"                                           # 既存の短いセッション ID を渡す
SRC_FILE=$(ls ~/.claude/projects/*/"$SRC_SID".jsonl | head -1)
DST_CWD="$HOME/.agent-hangar-spike/resume-copy"; mkdir -p "$DST_CWD"
DST_DIR="$HOME/.claude/projects/$(echo "$DST_CWD" | sed 's#[^A-Za-z0-9]#-#g')"; mkdir -p "$DST_DIR"
cp "$SRC_FILE" "$DST_DIR/$SRC_SID.jsonl"
echo "copied to $DST_DIR/$SRC_SID.jsonl"
echo "now run:  cd $DST_CWD && claude -r $SRC_SID"
echo "then:     cd $DST_CWD && claude -r $SRC_SID --fork-session --session-id $(uuidgen | tr 'A-Z' 'a-z')"
echo "cleanup:  rm -rf $DST_DIR"
```

- [ ] **Step 2: 実行して確かめる**

短いセッション（数ターン）の ID を `~/.claude/history.jsonl` から選び、スクリプトに渡す。
表示されたコマンドを順に実行し、次を確かめる。

1. `claude -r <id>` が、別の cwd にコピーした本文から会話を復元する（行内の `cwd` が元のパスでも問題ないか）。
2. 復元後に 1 ターン送ると、コピー先のファイルに追記される（元のファイルは変わらない）。
3. `--fork-session --session-id <new>` で新しい ID のファイルができ、元は変わらない。
4. `/resume` の一覧にコピーしたセッションが出るかどうか。

- [ ] **Step 3: 片付けて記録する**

Step 1 の出力に表示された `cleanup:` の行を実行する。
削除対象がコピー先のディレクトリだけであることを、実行前にパスで確かめる。

```bash
git add spikes/11-resume-copy && git commit -m "spike(11): resume from copied transcript"
```

---

### Task 12: LM Studio での要約

**Files:**
- Create: `spikes/12-summarize-local/compress.mjs`
- Create: `spikes/12-summarize-local/schema.mjs`
- Create: `spikes/12-summarize-local/summarize.mjs`
- Create: `spikes/12-summarize-local/RESULT.md`

**Interfaces:**
- Consumes: Task 5 の `extractText` の抽出規則。
- Produces: `compress(file) => string` と `schema`。Task 13 が同じ入力とスキーマを使う。

- [ ] **Step 1: 入力を圧縮するスクリプトを書く**

```js
// spikes/12-summarize-local/compress.mjs
import fs from 'node:fs';
export function compress(file, maxChars = 12000) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const items = [];
  for (const l of lines) {
    if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    const content = r.message?.content; if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (r.type === 'user' && c.type === 'text') items.push(`[user] ${c.text.slice(0, 2000)}`);
      if (r.type === 'assistant' && c.type === 'text') items.push(`[assistant] ${c.text.slice(0, 600)}`);
      if (c.type === 'tool_use') items.push(`[tool] ${c.name} ${c.input?.file_path ?? c.input?.command ?? ''}`.slice(0, 200));
    }
  }
  let text = items.join('\n');
  if (text.length > maxChars) {                       // 中盤を間引き、最初と最後を残す
    const head = items.slice(0, Math.floor(items.length * 0.3));
    const tail = items.slice(-Math.floor(items.length * 0.3));
    text = [...head, `[... ${items.length - head.length - tail.length} 件を省略 ...]`, ...tail].join('\n').slice(0, maxChars);
  }
  return text;
}
if (process.argv[1]?.endsWith('compress.mjs')) console.log(compress(process.argv[2]));
```

```js
// spikes/12-summarize-local/schema.mjs
export const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 40 },
    one_liner: { type: 'string', maxLength: 80 },
    body: { type: 'string' },
    state: { type: 'string', enum: ['in_progress', 'done', 'blocked', 'abandoned'] },
    next_steps: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: ['title', 'one_liner', 'body', 'state', 'next_steps'],
};
if (process.argv[1]?.endsWith('schema.mjs')) console.log(JSON.stringify(schema));
```

- [ ] **Step 2: JSON スキーマ付きで LM Studio に投げる**

```js
// spikes/12-summarize-local/summarize.mjs
import { compress } from './compress.mjs';
import { schema } from './schema.mjs';

const [file, model = 'qwen3.6-35b-a3b-mlx'] = process.argv.slice(2);
const input = compress(file);
const t = Date.now();
const res = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model, temperature: 0.2,
    messages: [
      { role: 'system', content: '以下はコーディングエージェントのセッションログの抜粋です。日本語で、指定の JSON だけを返してください。title は名詞句、one_liner は 1 文、body は 2〜3 文、next_steps は具体的な行動。' },
      { role: 'user', content: input },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'session_summary', strict: true, schema } },
  }),
});
const j = await res.json();
const text = j.choices?.[0]?.message?.content ?? '';
console.log({ model, inputChars: input.length, ms: Date.now() - t, usage: j.usage });
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log('NOT JSON:', text.slice(0, 500)); }
```

- [ ] **Step 3: 3 モデルで同じ 3 セッションを要約する**

短い、中くらい、長い（5MB 級）の 3 件を選び、`F` に入れて回す。

```bash
cd spikes/12-summarize-local
F=~/.claude/projects/<proj>/<sid>.jsonl
for m in qwen3.6-35b-a3b-mlx qwen3.8-27b-uncensored-mlx gemma-4-26b-a4b-it-heretic; do node summarize.mjs "$F" "$m"; done
```

記録: モデル別の所要秒（プロンプト処理と生成）、JSON が壊れた回数、要約の妥当性（自分で 3 段階評価）、thinking 系モデルで `<think>` が混ざるかどうか。

- [ ] **Step 4: 記録する**

```bash
git add spikes/12-summarize-local && git commit -m "spike(12): local LLM summarization via LM Studio"
```

---

### Task 13: claude -p での要約

**Files:**
- Create: `spikes/13-summarize-claude/run.sh`
- Create: `spikes/13-summarize-claude/RESULT.md`

**Interfaces:**
- Consumes: Task 12 の `compress.mjs` と `schema.mjs`。

- [ ] **Step 1: 同じ入力を Haiku に投げるスクリプトを書く**

```bash
# spikes/13-summarize-claude/run.sh
#!/usr/bin/env bash
set -euo pipefail
F="$1"
SCHEMA=$(node spikes/12-summarize-local/schema.mjs)
INPUT=$(node spikes/12-summarize-local/compress.mjs "$F")
for i in 1 2 3; do
  START=$(date +%s)
  printf '%s' "$INPUT" | claude -p --model haiku --output-format json --json-schema "$SCHEMA" \
    --append-system-prompt '以下はコーディングエージェントのセッションログの抜粋です。日本語で要約してください。title は名詞句、one_liner は 1 文、body は 2〜3 文。' \
    --no-session-persistence --tools "" > "/tmp/spike13-$i.json"
  echo "run $i: $(( $(date +%s) - START ))s"
  node -e "const j=require('/tmp/spike13-$i.json'); console.log(JSON.stringify(j.structured_output ?? j.result ?? j).slice(0,400))"
done
```

- [ ] **Step 2: 実行して確かめる**

```bash
chmod +x spikes/13-summarize-claude/run.sh
spikes/13-summarize-claude/run.sh ~/.claude/projects/<proj>/<sid>.jsonl
```

次を確かめる。

1. 3 回とも JSON スキーマに沿った出力が得られる（`--json-schema` の出力がどのキーに入るかを記録する）。
2. 所要秒と、出力 JSON にあるトークン数。
3. Task 12 の同じセッションの要約と質を比べる。
4. `--tools ""` と `--no-session-persistence` で、`~/.claude/projects` に新しい jsonl が増えないこと。

- [ ] **Step 3: 記録する**

```bash
rm -f /tmp/spike13-*.json
git add spikes/13-summarize-claude && git commit -m "spike(13): headless haiku summarization with json schema"
```

---

## 完了の条件

13 件すべての `RESULT.md` が揃い、不合格または条件付きの項目について `docs/design.md` の該当箇所を直してから、フェーズ 1 の計画に進む。
