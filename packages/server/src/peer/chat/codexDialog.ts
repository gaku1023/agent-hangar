/**
 * Codex の TUI の札を、画面（capture-pane -p -e）から読む純粋な関数と、決定からキーを決める純粋な関数。
 * API で答えられないとき（AgentAskPort.answer が 'unreachable'、または api が null）の、画面の道である。
 *
 * 見本は dialogs.codex.fixtures.ts（Codex 0.171.0、macOS の tmux、120 桁と 80 桁）。
 * 札は 3 種類。
 * - 命令の承認：`Would you like to run the following command?`、`$ 命令`、選択肢 `1. Yes, proceed (y)` ほか。
 * - ファイルの変更の承認：`Would you like to make the following edits?`、`Destination:`、選択肢 `(y)` `(a)` `(esc)`。
 * - requestUserInput：`Question 1/2`、問いの文、`› 1. label  description`、足の行 `tab to add notes | enter to submit answer …`。
 *
 * 色には頼らない。釦の見分けは文字だけでする（`(y)` `(a)` `(esc)`、番号）。
 * 画面に該当の選択肢が無ければ、キーは null を返す（命令の session と deny は画面に無い）。
 * 画面の道で答えるのは、許可と、選択肢 1 つを選ぶだけの質問（問いが 1 つ）に限る。
 */

import type { AgentAskReply, AgentPendingAsk } from '../../agent/pendingAsk.ts';
import { chosenOption, commandKey, isSingleChoiceQuestion, labelKey, lastNonBlankIndexes, plainLines, squash, type ScreenKey } from './dialogScreen.ts';

export type CodexScreenOption = { number: number; label: string; /** 括弧の中のキー（y、p、a、esc）。無ければ null。 */ hotkey: string | null };

export type CodexDialog =
  | { kind: 'exec'; command: string; reason: string | null; options: CodexScreenOption[] }
  | { kind: 'patch'; destination: string; description: string | null; options: CodexScreenOption[] }
  | {
      kind: 'question';
      /** 1 から数える。「Question 1/2」の見出しが無ければ 1 と 1。 */
      index: number;
      total: number;
      /** 最後の問いか（足の行が submit all）。 */
      last: boolean;
      text: string;
      /** 選べる選択肢（None of the above は含まない）。 */
      options: { number: number; label: string; description: string | null }[];
      /** None of the above（isOther）の番号。 */
      otherNumber: number | null;
    };

const EXEC_HEAD = /^\s*Would you like to run the following command\?/;
const PATCH_HEAD = /^\s*Would you like to make the following edits\?/;
const CONFIRM_FOOT = /^\s*Press enter to confirm or esc to cancel/;
const APPROVAL_OPTION = /^\s*[›>]?\s*(\d+)\.\s+(.*?)\s*\(([A-Za-z]+)\)\s*$/;
const QUESTION_HEAD = /^\s*Question (\d+)\/(\d+)\b/;
const QUESTION_FOOT = /tab to add notes|enter to submit (?:answer|all)/;
const QUESTION_OPTION = /^\s*[›>]?\s*(\d+)\.\s+(\S.*?)\s*$/;
const FIELD_HEAD = /^\s*(?:Description|Destination|Reason):/;
const OTHER_LABEL = /^None of the above\b/;

/** 札の下端が画面の末尾にあるか（上のほうの行に残った古い字を札と取り違えない）。 */
function nearBottom(lines: string[], idx: number, within: number): boolean {
  return lastNonBlankIndexes(lines, within).some((i) => i >= idx);
}

function approvalOptions(lines: string[], from: number): CodexScreenOption[] {
  const out: CodexScreenOption[] = [];
  for (let i = from; i < lines.length; i++) {
    const m = APPROVAL_OPTION.exec(lines[i]!);
    if (m) out.push({ number: Number(m[1]), label: m[2]!.trim(), hotkey: m[3]!.toLowerCase() });
  }
  return out;
}

/** 行 from から、空行までを 1 つの文として読む（折り返しで続く行を足す）。 */
function block(lines: string[], from: number, join: string): string {
  const parts: string[] = [];
  for (let i = from; i < lines.length && lines[i]!.trim() !== '' && (i === from || !FIELD_HEAD.test(lines[i]!)); i++) parts.push(lines[i]!.trim());
  return parts.join(join);
}

function readApproval(lines: string[], head: number, kind: 'exec' | 'patch'): CodexDialog | null {
  let foot = -1;
  for (let i = lines.length - 1; i > head; i--) {
    if (CONFIRM_FOOT.test(lines[i]!)) {
      foot = i;
      break;
    }
  }
  if (foot < 0 || !nearBottom(lines, foot, 1)) return null;
  const options = approvalOptions(lines.slice(0, foot), head + 1);
  if (options.length === 0) return null;
  if (kind === 'exec') {
    const cmdAt = lines.findIndex((l, i) => i > head && i < foot && /^\s*\$ /.test(l));
    if (cmdAt < 0) return null;
    const command = block(lines, cmdAt, ' ').replace(/^\$\s+/, '');
    const reasonAt = lines.findIndex((l, i) => i > head && i < cmdAt && /^\s*Reason:/.test(l));
    return { kind: 'exec', command, reason: reasonAt < 0 ? null : block(lines, reasonAt, ' ').replace(/^Reason:\s*/, ''), options };
  }
  const destAt = lines.findIndex((l, i) => i > head && i < foot && /^\s*Destination:/.test(l));
  // 折り返しは単語の途中でも起きる（長いパス）。空白で続けると別の文字列になるので、つなぐときは空白を入れない。
  const destination = destAt < 0 ? '' : (lines[destAt]!.trim().replace(/^Destination:\s*/, '') + block(lines, destAt + 1, '')).trim();
  const descAt = lines.findIndex((l, i) => i > head && i < foot && /^\s*Description:/.test(l));
  return { kind: 'patch', destination, description: descAt < 0 ? null : block(lines, descAt, ' ').replace(/^Description:\s*/, ''), options };
}

function readQuestion(lines: string[]): CodexDialog | null {
  let foot = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION_FOOT.test(lines[i]!)) {
      foot = i;
      break;
    }
  }
  // 足の行は、80 桁で折り返すと 2 行になる。
  if (foot < 0 || !nearBottom(lines, foot, 3)) return null;
  const footText = lines.slice(foot, foot + 2).join(' ');
  // 選択肢の並び（足の行の上の、空行で区切られた 1 つの塊）。
  let end = foot - 1;
  while (end >= 0 && lines[end]!.trim() === '') end--;
  let start = end;
  while (start - 1 >= 0 && lines[start - 1]!.trim() !== '') start--;
  const options: { number: number; label: string; description: string | null }[] = [];
  let otherNumber: number | null = null;
  for (let i = start; i <= end; i++) {
    const m = QUESTION_OPTION.exec(lines[i]!);
    if (!m) return null;
    const [label, ...rest] = m[2]!.split(/\s{2,}/);
    if (OTHER_LABEL.test(label!)) {
      otherNumber = Number(m[1]);
      continue;
    }
    options.push({ number: Number(m[1]), label: label!.trim(), description: rest.length ? rest.join(' ').trim() : null });
  }
  if (options.length === 0) return null;
  // 問いの文は、選択肢の塊の上の塊。見出し（Question 1/2）が上にあれば読む。
  let tEnd = start - 1;
  while (tEnd >= 0 && lines[tEnd]!.trim() === '') tEnd--;
  let tStart = tEnd;
  while (tStart - 1 >= 0 && lines[tStart - 1]!.trim() !== '') tStart--;
  if (tEnd < 0) return null;
  let index = 1;
  let total = 1;
  let textFrom = tStart;
  const head = QUESTION_HEAD.exec(lines[tStart]!);
  if (head) {
    index = Number(head[1]);
    total = Number(head[2]);
    textFrom = tStart + 1;
  }
  const text = lines
    .slice(textFrom, tEnd + 1)
    .map((l) => l.trim())
    .join(' ');
  if (text === '') return null;
  return { kind: 'question', index, total, last: /enter to submit all/.test(footText), text, options, otherNumber };
}

/** 画面から、いま出ている札を読む。札が無ければ null。一番下にある札を採る。 */
export function readCodexDialog(screen: string): CodexDialog | null {
  const lines = plainLines(screen);
  let exec = -1;
  let patch = -1;
  for (let i = lines.length - 1; i >= 0 && (exec < 0 || patch < 0); i--) {
    if (exec < 0 && EXEC_HEAD.test(lines[i]!)) exec = i;
    if (patch < 0 && PATCH_HEAD.test(lines[i]!)) patch = i;
  }
  const head = Math.max(exec, patch);
  if (head >= 0) return readApproval(lines, head, exec > patch ? 'exec' : 'patch');
  return readQuestion(lines);
}

// ---- キー ----

/** 許可の scope から、打つキー。画面にその選択肢が無ければ null。 */
export function codexPermissionKeys(d: CodexDialog, scope: 'once' | 'session' | 'deny' | 'deny-stop'): ScreenKey[] | null {
  if (d.kind === 'question') return null;
  const has = (hotkey: string, labelRe: RegExp): boolean => d.options.some((o) => o.hotkey === hotkey && labelRe.test(o.label));
  switch (scope) {
    case 'once':
      return has('y', /^Yes, proceed/i) ? ['y'] : null;
    case 'session':
      // 命令には「今回の会話の間」の行が無い（p は永続の規則なので使わない）。ファイルの変更だけに (a) がある。
      return d.kind === 'patch' && has('a', /don't ask again/i) ? ['a'] : null;
    case 'deny':
      // 断って続ける（decline）の行は画面に無い。
      return null;
    case 'deny-stop':
      return has('esc', /^No,/i) ? ['escape'] : null;
  }
}

/** 質問の選択肢 1 つ（label）から、打つキー。画面に無ければ null。番号キーで選び、最後の問いなら全体を送る。 */
export function codexQuestionKeys(d: CodexDialog, label: string): ScreenKey[] | null {
  if (d.kind !== 'question') return null;
  const hit = d.options.find((o) => labelKey(o.label) === labelKey(label));
  if (!hit || hit.number > 9) return null;
  return [String(hit.number)];
}

// ---- 照合 ----

/** 札が ask と同じものか。命令の文、ファイルの場所、問いの文と選択肢の label で見る。 */
export function matchCodexAsk(d: CodexDialog, ask: AgentPendingAsk): boolean {
  if (d.kind === 'question') {
    if (ask.kind !== 'question' || ask.questions.length !== 1 || d.total !== 1) return false;
    const q = ask.questions[0]!;
    if (!isSingleChoiceQuestion(q)) return false;
    if (squash(q.text) !== squash(d.text) && !(q.header && squash(`${q.header}${q.text}`) === squash(d.text))) return false;
    if (q.options.length !== d.options.length) return false;
    return q.options.every((o, i) => labelKey(o.label) === labelKey(d.options[i]!.label));
  }
  if (ask.kind !== 'permission') return false;
  if (d.kind === 'exec') {
    return ask.tool === 'Bash' && !!ask.input && commandKey(ask.input) === commandKey(d.command);
  }
  // ファイルの変更：input は grantRoot で、空のことがある。入っていれば、画面の場所がその下にあるかを見る。
  if (ask.tool !== 'Edit') return false;
  if (!ask.input) return d.destination !== '';
  return squash(d.destination).startsWith(squash(ask.input));
}

/**
 * 画面と ask と答えから、打つキーを決める。照合できない、画面にその選択肢が無い、画面の道で答えない種類なら null。
 * capture を受け、キー列か null を返す（配線の screenAnswer の口に差し込める形）。
 */
export function codexScreenKeys(screen: string, ask: AgentPendingAsk, reply: AgentAskReply): ScreenKey[] | null {
  const d = readCodexDialog(screen);
  if (!d || !matchCodexAsk(d, ask)) return null;
  if (reply.kind === 'permission') {
    if (d.kind === 'question' || !reply.choice) return null;
    return codexPermissionKeys(d, reply.choice);
  }
  if (d.kind !== 'question') return null;
  const q = ask.questions[0]!;
  const chosen = chosenOption(q, reply.answers[q.id]);
  return chosen ? codexQuestionKeys(d, chosen.label) : null;
}
