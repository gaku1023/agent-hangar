/**
 * opencode の TUI の札を、画面（capture-pane -p -e）から読む純粋な関数と、決定からキーを決める純粋な関数。
 * API で答えられないとき（AgentAskPort.answer が 'unreachable'、または api が null）の、画面の道である。
 *
 * 見本は dialogs.opencode.fixtures.ts（opencode 2.2.0、macOS の tmux、120 桁と 80 桁）。
 * 札は 2 種類。
 * - 許可：`△ Permission required`、`$ 命令`、釦の行 ` Allow once   Always allow   Reject `（横並び）。
 *   → で次の釦へ、Enter で確定する（確認の段は無い）。Always allow を選ぶと本文が「This will always allow the following patterns …」に変わる。
 * - form（question の道具）：`Questions`、タブの行 `Language  Toppings  Submit`、問いの文、`1. label` と下の行の説明、最後が `Type your own answer`。
 *   複数選択は `1. [ ] label`。
 *
 * 色に頼る所：どの釦が選ばれているか（背景色 48;2;250;178;131 で塗られる）。
 * 既定が Allow once であることを、この塗りで確かめてからキーを打つ。塗りが見つからなければ null（打たない）。
 * Windows（psmux）の見本は無い。色の出方が違えば、釦の選びが読めず、許可は null になる（安全側）。
 * 画面の道で答えるのは、許可と、欄が 1 つで選択肢 1 つを選ぶだけの form に限る。
 */

import type { AgentAskReply, AgentPendingAsk } from '../../agent/pendingAsk.ts';
import { chosenOption, commandKey, isSingleChoiceQuestion, labelKey, lastNonBlankIndexes, squash, stripSgr, type ScreenKey } from './dialogScreen.ts';

export type OpencodeButton = 'Allow once' | 'Always allow' | 'Reject';
const BUTTONS: OpencodeButton[] = ['Allow once', 'Always allow', 'Reject'];

export type OpencodeDialog =
  | {
      kind: 'permission';
      /** `$ 命令` の命令。本文が命令でない（Always allow を選んだ後の説明など）ときは null。 */
      command: string | null;
      /** Always allow を選んだ後の説明の本文か。 */
      alwaysPreview: boolean;
      /** 選ばれている釦（塗りの色から）。読めなければ null。 */
      selected: OpencodeButton | null;
    }
  | {
      kind: 'form';
      /** タブの行の欄の数（Submit を除く）。タブの行が無ければ 1。 */
      fields: number;
      /** タブの行に Submit が並ぶか。 */
      hasSubmitTab: boolean;
      text: string;
      multi: boolean;
      /** 選べる選択肢（Type your own answer は含まない）。 */
      options: { number: number; label: string }[];
      allowText: boolean;
    };

/** 選ばれている釦の塗り（背景色）。 */
const SELECTED_FILL = /\x1b\[48;2;250;178;131m[ ]*(?:\x1b\[[0-9;:]*m)*(Allow once|Always allow|Reject)/;
const BAR = /^\s*[┃│]\s?/;
const FORM_OPTION = /^(\d+)\.\s+(?:\[([ ✓xX*])\]\s+)?(\S.*)$/;

/** 左の ┃ を落とした行。 */
const cleanLine = (l: string): string => stripSgr(l).replace(BAR, '').replace(/[\s\r]+$/, '').trim();

function readPermission(raw: string[], cleaned: string[]): OpencodeDialog | null {
  let title = -1;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (/Permission required/.test(cleaned[i]!)) {
      title = i;
      break;
    }
  }
  if (title < 0) return null;
  let buttons = -1;
  for (let i = title + 1; i < cleaned.length; i++) {
    if (BUTTONS.every((b) => cleaned[i]!.includes(b))) {
      buttons = i;
      break;
    }
  }
  // 釦の行は札の一番下（足の行は同じ行の右にある）。その下に本文が続く画面は、古い札の残りとみなす。
  if (buttons < 0 || !lastNonBlankIndexes(cleaned, 2).some((i) => i >= buttons)) return null;
  const body = cleaned.slice(title + 1, buttons);
  const alwaysPreview = body.some((l) => /always allow the following/i.test(l));
  let command: string | null = null;
  const at = body.findIndex((l) => l.startsWith('$ '));
  if (at >= 0) {
    const parts: string[] = [];
    for (let i = at; i < body.length && body[i] !== ''; i++) parts.push(body[i]!);
    command = parts.join(' ').replace(/^\$\s+/, '');
  }
  const fill = SELECTED_FILL.exec(raw[buttons]!);
  return { kind: 'permission', command, alwaysPreview, selected: fill ? (fill[1] as OpencodeButton) : null };
}

function readForm(cleaned: string[]): OpencodeDialog | null {
  let head = -1;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (cleaned[i] === 'Questions') {
      head = i;
      break;
    }
  }
  if (head < 0) return null;
  let foot = -1;
  for (let i = cleaned.length - 1; i > head; i--) {
    if (/esc dismiss/.test(cleaned[i]!)) {
      foot = i;
      break;
    }
  }
  if (foot < 0 || !lastNonBlankIndexes(cleaned, 2).some((i) => i >= foot)) return null;
  const body = cleaned.slice(head + 1, foot);
  let i = 0;
  while (i < body.length && body[i] === '') i++;
  let fields = 1;
  let hasSubmitTab = false;
  // タブの行は、空白 2 つ以上で区切られた短い語の並びで、最後が Submit。
  if (i < body.length && /(?:^|\s{2})Submit$/.test(body[i]!) && body[i]!.split(/\s{2,}/).length >= 2) {
    const tabs = body[i]!.split(/\s{2,}/);
    fields = tabs.length - 1;
    hasSubmitTab = true;
    i++;
  }
  const textParts: string[] = [];
  while (i < body.length && !FORM_OPTION.test(body[i]!)) {
    if (body[i] !== '') textParts.push(body[i]!);
    i++;
  }
  const options: { number: number; label: string }[] = [];
  let multi = false;
  let allowText = false;
  for (; i < body.length; i++) {
    const m = FORM_OPTION.exec(body[i]!);
    if (!m) continue; // 選択肢の下の説明の行
    if (m[2] !== undefined) multi = true;
    if (/^Type your own answer\b/.test(m[3]!)) {
      allowText = true;
      continue;
    }
    options.push({ number: Number(m[1]), label: m[3]!.trim() });
  }
  if (options.length === 0 || textParts.length === 0) return null;
  return { kind: 'form', fields, hasSubmitTab, text: textParts.join(' '), multi, options, allowText };
}

/** 画面から、いま出ている札を読む。札が無ければ null。 */
export function readOpencodeDialog(screen: string): OpencodeDialog | null {
  const raw = screen.split('\n');
  const cleaned = raw.map(cleanLine);
  return readPermission(raw, cleaned) ?? readForm(cleaned);
}

// ---- キー ----

/**
 * 許可の scope から、打つキー。once は Enter、always（scope の session）は Right Enter、Reject（deny と deny-stop）は Right Right Enter。
 * 既定の選びが Allow once であることを塗りの色で確かめられなければ null。
 * Always allow は、同じ種類の命令を以後（別の会話でも）聞かない長く効く規則になる。
 */
export function opencodePermissionKeys(d: OpencodeDialog, scope: 'once' | 'session' | 'deny' | 'deny-stop'): ScreenKey[] | null {
  if (d.kind !== 'permission' || d.selected !== 'Allow once') return null;
  switch (scope) {
    case 'once':
      return ['enter'];
    case 'session':
      return ['right', 'enter'];
    case 'deny':
    case 'deny-stop':
      return ['right', 'right', 'enter'];
  }
}

/**
 * form の選択肢 1 つ（label）から、打つキー。欄が 1 つで選択肢 1 つを選ぶ form だけ。
 * 番号キーで選ぶと次のタブへ進む。タブの行に Submit があれば、最後に Enter で送る。
 * 欄が 1 つだけの form の実物は未採取で、この Enter は 2 つの欄の見本（Submit のタブで enter submit）からの推定である。
 */
export function opencodeFormKeys(d: OpencodeDialog, label: string): ScreenKey[] | null {
  if (d.kind !== 'form' || d.fields !== 1 || d.multi) return null;
  const hit = d.options.find((o) => labelKey(o.label) === labelKey(label));
  if (!hit || hit.number > 9) return null;
  return d.hasSubmitTab ? [String(hit.number), 'enter'] : [String(hit.number)];
}

// ---- 照合 ----

/** 札が ask と同じものか。許可は命令の文、form は問いの文と選択肢の label。 */
export function matchOpencodeAsk(d: OpencodeDialog, ask: AgentPendingAsk): boolean {
  if (d.kind === 'permission') {
    if (ask.kind !== 'permission' || d.command === null || !ask.input || ask.input.includes('\n')) return false;
    return commandKey(ask.input) === commandKey(d.command);
  }
  if (ask.kind !== 'question' || ask.questions.length !== 1 || d.fields !== 1) return false;
  const q = ask.questions[0]!;
  if (!isSingleChoiceQuestion(q) || d.multi) return false;
  if (squash(q.text) !== squash(d.text)) return false;
  if (q.options.length !== d.options.length) return false;
  return q.options.every((o, i) => labelKey(o.label) === labelKey(d.options[i]!.label));
}

/**
 * 画面と ask と答えから、打つキーを決める。照合できない、画面にその選択肢が無い、画面の道で答えない種類なら null。
 * capture を受け、キー列か null を返す（配線の screenAnswer の口に差し込める形）。
 */
export function opencodeScreenKeys(screen: string, ask: AgentPendingAsk, reply: AgentAskReply): ScreenKey[] | null {
  const d = readOpencodeDialog(screen);
  if (!d || !matchOpencodeAsk(d, ask)) return null;
  if (reply.kind === 'permission') {
    return d.kind === 'permission' && reply.choice ? opencodePermissionKeys(d, reply.choice) : null;
  }
  if (d.kind !== 'form') return null;
  const q = ask.questions[0]!;
  const chosen = chosenOption(q, reply.answers[q.id]);
  return chosen ? opencodeFormKeys(d, chosen.label) : null;
}
