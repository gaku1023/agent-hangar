// 場面 agents と new-session が使う、偽の codex・opencode と、その画面（TUI）の台本を置く道具。
// 本物の codex・opencode は呼ばない。packages/server/test の偽物（app-server、serve）を流用し、hangar が tmux の中で起こす TUI の側だけをここで作る。
// 場面ではない（名前に . を含むので run.ts は読まない）。
import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../env.ts';
import { writeFakeCodex } from '../../../packages/server/test/fake-codex.ts';
import { writeFakeOpencode } from '../../../packages/server/test/fake-opencode.ts';

const E = '\x1b[';
const dim = (s: string) => `${E}2m${s}${E}22m`;
const bold = (s: string) => `${E}1m${s}${E}22m`;
const cyan = (s: string) => `${E}36m${s}${E}39m`;
const green = (s: string) => `${E}32m${s}${E}39m`;
const magenta = (s: string) => `${E}35m${s}${E}39m`;
const addLine = (s: string) => `${E}48;5;22m${E}38;5;120m${s}${E}0m`;
const delLine = (s: string) => `${E}48;5;52m${E}38;5;217m${s}${E}0m`;
const ctxLine = (s: string) => `${E}38;5;245m${s}${E}0m`;

/** TUI の台本の 1 行。gate はその名前のファイルができるまで待つ。typed は打鍵のように 1 文字ずつ出す。 */
export type TuiStep = { gate?: string; ms?: number; out?: string; typed?: boolean };

/** 表示の幅（全角は 2、ANSI の装飾は 0）。 */
const vis = (s: string): number => [...s.replace(/\x1b\[[0-9;]*m/g, '')].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x7f ? 2 : 1), 0);
/** 幅 w の枠で囲む。 */
const box = (lines: string[], w: number): string => [dim('╭' + '─'.repeat(w - 2) + '╮'), ...lines.map((l) => `${dim('│')} ${l}${' '.repeat(Math.max(0, w - 4 - vis(l)))} ${dim('│')}`), dim('╰' + '─'.repeat(w - 2) + '╯')].join('\r\n');

/** 2 つの本文を、行ごとの diff の表示にする。 */
const diff = (rows: [string, number, string][]) => rows.map(([s, n, t]) => {
  const line = `  ${String(n).padStart(3)} ${s} ${t}`.padEnd(36);
  return { ms: 110, out: `${s === '+' ? addLine(line) : s === '-' ? delLine(line) : ctxLine(line)}\r\n` };
});

export type AgentScripts = { codex: TuiStep[]; opencode: TuiStep[] };

/** Codex の TUI の台本。プロンプトの文と、流す出来事を渡す。 */
export function codexScript(o: { gate: string; cwd: string; model?: string; prompt: string; read: string; edit: { file: string; rows: [string, number, string][]; summary: string }; test: { cmd: string; lines: string[] }; done: string }): TuiStep[] {
  const model = o.model ?? 'gpt-5.4';
  return [
    { out: `${box([`${bold('>_ OpenAI Codex')} ${dim('(v0.164.0)')}`, '', `model:  ${model}`, `dir:    ${o.cwd}`], 36)}\r\n` },
    { gate: o.gate },
    { ms: 200, out: `${bold('›')} `, typed: false },
    { out: o.prompt, typed: true },
    { out: '\r\n\r\n' },
    { ms: 700, out: `${dim('• Working (2s • esc to interrupt)')}\r\n\r\n` },
    { ms: 800, out: `${bold('•')} ${bold('Explored')}\r\n  ${dim('└')} Read ${o.read}\r\n\r\n` },
    { ms: 900, out: `${bold('•')} ${bold('Edited')} ${o.edit.file} ${green('(+' + o.edit.rows.filter((r) => r[0] === '+').length + ')')} ${E}31m(-${o.edit.rows.filter((r) => r[0] === '-').length})${E}39m\r\n` },
    ...diff(o.edit.rows),
    { out: '\r\n' },
    { ms: 900, out: `${bold('•')} ${bold('Ran')} ${o.test.cmd}\r\n` },
    ...o.test.lines.map((l, i) => ({ ms: 240, out: `  ${i === 0 ? dim('└') : ' '} ${dim(l)}\r\n` })),
    { out: '\r\n' },
    { ms: 800, out: `${bold('•')} `, typed: false },
    { out: o.done, typed: true },
    { out: `\r\n\r\n${dim('  ⏎ send   ⌃J newline   100% context left')}\r\n` },
  ];
}

/** opencode の TUI の台本。 */
export function opencodeScript(o: { gate: string; model?: string; prompt: string; read: string; edit: { file: string; rows: [string, number, string][] }; test: { cmd: string; lines: string[] }; done: string }): TuiStep[] {
  const model = o.model ?? 'Qwen3 Coder 30B';
  const bar = magenta('┃');
  return [
    { out: `\r\n  ${bold('opencode')} ${dim('2.1.4')}\r\n\r\n` },
    { gate: o.gate },
    { ms: 200, out: `  ${bar} ` },
    { out: o.prompt, typed: true },
    { out: `\r\n  ${bar} ${dim('build · ' + model)}\r\n\r\n` },
    { ms: 800, out: `  ${cyan('→')} Read ${o.read}\r\n` },
    { ms: 900, out: `  ${cyan('←')} Edit ${o.edit.file}\r\n` },
    ...diff(o.edit.rows),
    { ms: 800, out: `\r\n  ${cyan('$')} ${o.test.cmd}\r\n` },
    ...o.test.lines.map((l) => ({ ms: 240, out: `    ${dim(l)}\r\n` })),
    { ms: 800, out: '\r\n  ' },
    { out: o.done, typed: true },
    { out: `\r\n\r\n  ${dim('tab agents   ctrl+p commands')}\r\n` },
  ];
}

/** TUI を動かす Node の台本。steps を JSON で読み、ゆっくり端末へ流す。 */
const PLAYER = `
import fs from 'node:fs';
import path from 'node:path';
const [steps, gates] = [JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3]];
const K = 0.6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * K));
const out = (s) => process.stdout.write(s);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
for (const s of steps) {
  if (s.gate) { while (!fs.existsSync(path.join(gates, s.gate))) await sleep(100); continue; }
  if (s.ms) await sleep(s.ms);
  if (s.typed) { for (const ch of s.out) { out(ch); await sleep(16); } } else out(s.out ?? '');
}
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`;

export type Fakes = { codexBin: string; opencodeBin: string };

/**
 * 偽の codex・opencode を root/bin に置く（env.ts が PATH の先頭に root/bin を足す）。
 * app-server・serve の相手は test の偽物。TUI として起こされたとき（codex は --remote、opencode は --server）だけ、台本を流す player に替える。
 * codexTurnMs は偽の app-server が 1 ターンを終えるまでの時間（動いている間、会話は実行中になる）。
 */
export function installAgentFakes(e: Env, scripts: AgentScripts, codexTurnMs = 120_000): Fakes {
  const dir = path.join(e.root, 'fakes');
  fs.mkdirSync(dir, { recursive: true });
  // codex の置き場（~/.codex）が無いと、hangar は login status を打たずに未ログインと見る。
  fs.mkdirSync(path.join(e.home, '.codex'), { recursive: true });
  const player = path.join(dir, 'tui-player.mjs');
  fs.writeFileSync(player, PLAYER);
  const cxSteps = path.join(dir, 'codex-steps.json');
  const ocSteps = path.join(dir, 'opencode-steps.json');
  fs.writeFileSync(cxSteps, JSON.stringify(scripts.codex));
  fs.writeFileSync(ocSteps, JSON.stringify(scripts.opencode));
  const realCodex = writeFakeCodex(path.join(dir, 'cx'), { turnMs: codexTurnMs });
  const realOpencode = writeFakeOpencode(path.join(dir, 'oc')).bin;
  const bin = path.join(e.root, 'bin');
  const node = process.execPath;
  const codexBin = path.join(bin, 'codex');
  const opencodeBin = path.join(bin, 'opencode');
  fs.writeFileSync(codexBin, `#!/bin/sh\ncase " $* " in\n  *" --remote "*) exec "${node}" "${player}" "${cxSteps}" "${e.gates}" ;;\n  *) exec "${realCodex}" "$@" ;;\nesac\n`, { mode: 0o755 });
  fs.writeFileSync(opencodeBin, `#!/bin/sh\ncase " $* " in\n  *" --version "*) echo 2.1.4 ;;\n  *" --server "*) exec "${node}" "${player}" "${ocSteps}" "${e.gates}" ;;\n  *) exec "${realOpencode}" "$@" ;;\nesac\n`, { mode: 0o755 });
  return { codexBin, opencodeBin };
}
