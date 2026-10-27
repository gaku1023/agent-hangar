// README の画像を撮るための偽の claude。本物の claude は呼ばない。
// HANGAR_CLAUDE_BIN で差され、hangar の tmux の中で動く。
// 台本（場面の seed.live()。READMESHOTS_LIVE の JSON）を -n の名前で選び、それらしい出力を端末へゆっくり流しながら、
// transcript と登録（<claude の置き場>/sessions/<pid>.json）を本物と同じ形で書く。
// gate の行では、gate ディレクトリに同じ名前のファイルができるまで待つ（録画の開始の合図）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_VERSION, TranscriptWriter, transcriptPath } from './transcript.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const sessionId = opt('--session-id') ?? opt('-r') ?? crypto.randomUUID();
const name = opt('-n') ?? '';
const claudeDir = process.env.HANGAR_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const gateDir = process.env.READMESHOTS_GATES ?? '';
const cwd = process.cwd();
// 台本は撮影側が場面の seed.live() を集めて書いた JSON。
const live = process.env.READMESHOTS_LIVE ? JSON.parse(fs.readFileSync(process.env.READMESHOTS_LIVE, 'utf8')) : {};
// 初期プロンプト（引数の末尾）で台本を選ぶ道（新しいセッションの場面）。場面が READMESHOTS_LIVE の隣の by-prompt.json に [{ prompt, steps }] を書く。
const initialPrompt = (() => {
  const sp = argv.indexOf('--append-system-prompt');
  if (sp < 0) return '';
  const tail = argv.slice(sp + 2);
  while (tail.length > 1 && tail[0].startsWith('-')) tail.splice(0, 2);
  return tail.length === 1 && !tail[0].startsWith('-') ? tail[0] : '';
})();
const byPrompt = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.READMESHOTS_LIVE ?? ''), 'by-prompt.json'), 'utf8')); } catch { return []; }
})();
const scenario = Object.values(live).find((s) => s.name === name) ?? (initialPrompt ? byPrompt.find((s) => s.prompt.trim() === initialPrompt.trim()) : undefined);

const E = '\x1b[';
const c = {
  dim: (s) => `${E}2m${s}${E}22m`,
  bold: (s) => `${E}1m${s}${E}22m`,
  green: (s) => `${E}32m${s}${E}39m`,
  orange: (s) => `${E}38;5;173m${s}${E}39m`,
  addLine: (s) => `${E}48;5;22m${E}38;5;120m${s}${E}0m`,
  delLine: (s) => `${E}48;5;52m${E}38;5;217m${s}${E}0m`,
  ctxLine: (s) => `${E}38;5;245m${s}${E}0m`,
};
// 録画が長くならないよう、台本の間と打鍵の間をこの倍率で詰める。
const K = 0.6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * K));
const out = (s) => process.stdout.write(s);

// 登録。status は busy / idle / waiting。
const startedAt = Date.now();
const regFile = path.join(claudeDir, 'sessions', `${process.pid}.json`);
function register(status, waitingFor) {
  fs.mkdirSync(path.dirname(regFile), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(regFile, JSON.stringify({
    pid: process.pid, sessionId, cwd, startedAt, procStart: new Date(startedAt).toString(), version: CLAUDE_VERSION,
    peerProtocol: 1, kind: 'interactive', entrypoint: 'cli', name: name || undefined, nameSource: 'user', nameSince: startedAt,
    updatedAt: now, status, statusUpdatedAt: now,
    ...(waitingFor ? { waitingFor } : {}),
  }));
}
function bye() { try { fs.rmSync(regFile, { force: true }); } catch { /* 無くてよい */ } process.exit(0); }
process.on('SIGTERM', bye);
process.on('SIGHUP', bye);
process.on('SIGINT', bye);

// MCP の設定（--mcp-config のファイル）から、hangar の MCP へ set_turn_intent を送る。本物の claude が意図を書くのと同じ経路である。
const mcp = (() => {
  try { return JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8')).mcpServers.hangar; } catch { return null; }
})();
async function intent(text) {
  if (!mcp) return;
  try {
    await fetch(mcp.url, {
      method: 'POST',
      headers: { ...mcp.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_turn_intent', arguments: { text } } }),
    });
  } catch { /* 書けなくても台本は進める */ }
}

// 任意の MCP の道具を呼ぶ（step の { mcp: { tool, args } }）。応答の本文（JSON）を返す。
// args の文字列 '@todo:<文言>' は、get_project で引いた、その文言を含む TODO の id に置き換える。
async function callTool(tool, args) {
  if (!mcp) return null;
  // project_id が要る道具は、省いたら、会話のプロジェクトを list_projects（会話別の URL では 1 件）から引く。
  if ((tool === 'get_project' || tool === 'update_project') && !args.project_id) {
    const ps = await callTool('list_projects', {});
    const id = (Array.isArray(ps) ? ps : ps?.projects)?.[0]?.id;
    if (id) args = { ...args, project_id: id };
  }
  try {
    const r = await fetch(mcp.url, {
      method: 'POST',
      headers: { ...mcp.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    const raw = await r.text();
    const data = raw.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? raw;
    return JSON.parse(JSON.parse(data).result.content[0].text);
  } catch { return null; }
}
async function resolveTodoRefs(v) {
  if (typeof v === 'string' && v.startsWith('@todo:')) {
    const want = v.slice(6);
    const p = await callTool('get_project', {});
    return p?.todos?.find((t) => t.text.includes(want))?.id ?? want;
  }
  if (Array.isArray(v)) return Promise.all(v.map(resolveTodoRefs));
  if (v && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await resolveTodoRefs(x)])));
  return v;
}

const tfile = transcriptPath(claudeDir, cwd, sessionId);
const tw = new TranscriptWriter({ file: tfile, sessionId, cwd, title: name || undefined });

async function type(text, ms = 16) {
  for (const ch of text) { out(ch); await sleep(ms); }
}

async function waitGate(g) {
  const f = path.join(gateDir, g);
  while (!fs.existsSync(f)) await sleep(100);
}

// 端末に打たれた 1 行（Enter まで）を、自分で表示しながら読む。貼り付けたパスもここに入る。
function readLine() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    const onData = (d) => {
      for (const ch of d) {
        if (ch === '\r' || ch === '\n') { process.stdin.off('data', onData); resolve(buf); return; }
        if (ch === '\x03') bye();
        if (ch === '\x7f') { const g = [...buf]; const last = g.pop(); buf = g.join(''); if (last) out('\b \b'.repeat(/[^\x00-\x7f]/.test(last) ? 2 : 1)); continue; }
        if (ch < ' ') continue;
        buf += ch; out(ch);
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

// 許可の問い（step の { ask: { tool, input, question, ... } }）。hangar へ PermissionRequest の hook と同じ本文を送り、
// 登録を waiting（permission prompt）にして、端末に選択肢を出す。1 か Enter で許可、2 で断る。選ぶまで待つ。
async function askPermission(a) {
  if (mcp) {
    try {
      await fetch(`${mcp.url}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: mcp.headers.Authorization },
        body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: sessionId, tool_name: a.tool, tool_input: { command: a.input, description: a.description } }),
      });
    } catch { /* 送れなくても台本は進める */ }
  }
  const opts = ['Yes', a.always ?? "Yes, and don't ask again this session", 'No, and tell Claude what to do differently'];
  let sel = 0;
  const draw = (first) => {
    if (!first) out(`${E}${opts.length}A`);
    opts.forEach((o, i) => out(`\r${E}2K ${i === sel ? c.orange('❯') : ' '} ${i + 1}. ${i === sel ? c.bold(o) : o}\r\n`));
  };
  out(`${c.dim('╭' + '─'.repeat(70))}\r\n${c.dim('│')} ${c.bold(a.tool)} ${c.dim('command')}\r\n${c.dim('│')}   ${a.input}\r\n`);
  if (a.description) out(`${c.dim('│')}   ${c.dim(a.description)}\r\n`);
  out(`${c.dim('╰' + '─'.repeat(70))}\r\n${a.question ?? 'Do you want to proceed?'}\r\n`);
  draw(true);
  register('waiting', 'permission prompt');
  const choice = await new Promise((resolve) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    const onData = (d) => {
      if (d === '\x03') bye();
      if (d === '\x1b[B') { sel = Math.min(opts.length - 1, sel + 1); draw(false); return; }
      if (d === '\x1b[A') { sel = Math.max(0, sel - 1); draw(false); return; }
      const n = Number(d);
      if (n >= 1 && n <= opts.length) sel = n - 1;
      else if (d !== '\r' && d !== '\n') return;
      draw(false);
      process.stdin.off('data', onData);
      resolve(sel);
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
  register('busy');
  out('\r\n');
  return choice;
}

const prompt = () => out(`\r\n${c.dim('─'.repeat(Math.min(process.stdout.columns || 80, 100)))}\r\n> `);

register('idle');
out(`${c.orange('✻')} ${c.bold('Welcome to Claude Code')}\r\n${c.dim('  /help for help')}\r\n\r\n`);

if (!scenario) {
  prompt();
} else {
  for (const step of scenario.steps) {
    if (step.typed) {
      prompt();
      const line = await readLine();
      register('busy');
      out('\r\n\r\n');
      tw.user(line);
      continue;
    }
    if (step.gate) { prompt(); await waitGate(step.gate); out('\r\n'); continue; }
    if (step.ms) await sleep(step.ms);
    if (step.intent) void intent(step.intent);
    if (step.ask) { await askPermission(step.ask); continue; }
    if (step.mcp) await callTool(step.mcp.tool, await resolveTodoRefs(step.mcp.args ?? {}));
    if (step.user !== undefined) {
      register('busy');
      out(`\r${c.dim('>')} `);
      await type(step.user, 14);
      out('\r\n\r\n');
      tw.user(step.user);
    } else if (step.say) {
      out(`${c.green('●')} `);
      await type(step.say, 18);
      out('\r\n');
      tw.text(step.say, Date.now(), !!step.final);
    } else if (step.tool) {
      out(`${c.green('●')} ${c.bold(step.tool)}(${step.arg})\r\n`);
      const id = tw.toolUse(step.tool === 'Update' ? 'Edit' : step.tool, step.input);
      await sleep(450);
      if (step.diff) {
        out(`  ${c.dim('⎿')}  ${step.summary}\r\n`);
        for (const [sign, no, text] of step.diff) {
          const line = `      ${String(no).padStart(3)} ${sign} ${text.trimEnd()}`.padEnd(78);
          out((sign === '+' ? c.addLine(line) : sign === '-' ? c.delLine(line) : c.ctxLine(line)) + '\r\n');
          await sleep(120);
        }
        tw.toolResult(id, `The file ${step.arg} has been updated.`);
      } else {
        let first = true;
        for (const l of step.out) {
          out(`  ${first ? c.dim('⎿') : ' '}  ${c.dim(l)}\r\n`);
          first = false;
          await sleep(step.lineMs ?? 80);
        }
        tw.toolResult(id, step.out.join('\n'));
      }
      out('\r\n');
    }
    if (step.final) {
      register('idle');
      prompt();
    }
  }
}

register('idle');
process.stdin.resume();
setInterval(() => {}, 1 << 30);
