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
const scenario = Object.values(live).find((s) => s.name === name);

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
function register(status) {
  fs.mkdirSync(path.dirname(regFile), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(regFile, JSON.stringify({
    pid: process.pid, sessionId, cwd, startedAt, procStart: new Date(startedAt).toString(), version: CLAUDE_VERSION,
    peerProtocol: 1, kind: 'interactive', entrypoint: 'cli', name: name || undefined, nameSource: 'user', nameSince: startedAt,
    updatedAt: now, status, statusUpdatedAt: now,
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

const tfile = transcriptPath(claudeDir, cwd, sessionId);
const tw = new TranscriptWriter({ file: tfile, sessionId, cwd, title: name || undefined });

async function type(text, ms = 16) {
  for (const ch of text) { out(ch); await sleep(ms); }
}

async function waitGate(g) {
  const f = path.join(gateDir, g);
  while (!fs.existsSync(f)) await sleep(100);
}

const prompt = () => out(`\r\n${c.dim('─'.repeat(Math.min(process.stdout.columns || 80, 100)))}\r\n> `);

register('idle');
out(`${c.orange('✻')} ${c.bold('Welcome to Claude Code')}\r\n${c.dim('  /help for help')}\r\n\r\n`);

if (!scenario) {
  prompt();
} else {
  for (const step of scenario.steps) {
    if (step.gate) { prompt(); await waitGate(step.gate); out('\r\n'); continue; }
    if (step.ms) await sleep(step.ms);
    if (step.intent) void intent(step.intent);
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
