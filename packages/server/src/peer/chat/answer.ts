import type { PeerChatAsk, PeerChatRefusal } from '@agent-hangar/shared';
import type { PaneKey, PaneOps } from '../../tmux/pane.ts';

/**
 * ほかの PC からの答えと割り込みを、この PC の Claude Code の画面（tmux か psmux のペイン）へ打つ。
 *
 * 方式はペインへのキー入力である。
 * PermissionRequest hook で決定を返す方式も実機で確かめた（PR の説明を見る）。
 * こちらを選んだのは、どの会話にも効き（hook は起動時の設定にしか載らない）、hook の作りを変えずに済み、画面の札を消さないからである。
 * 札は 1 つの事実で、先に打った方が勝つ。
 * 利用者が手元で先に答えれば、画面の札は変わり、ここは打たずに断る。
 *
 * 安全のために、打つ前に必ず画面を取り込む。
 * 出ている札が ask と同じか（許可はツールと主な引数、質問は質問の文と選択肢のラベル）を確かめ、違えば何も打たずに ask-mismatch を返す。
 * 行は番号でなくラベルで当てる。
 * 番号は固定でない（自動のモードの行があるかで変わる）。
 * 打った後はもう一度取り込み、札が閉じたことを確かめる。
 * 数字は押した瞬間に効くので、許可の答えは 1 回のキーで済む。
 * 複数の手順にわたる答え（自由入力、複数選択）は、手順の間で画面を確かめる。
 *
 * 同じ askId への 2 度目は already-answered で、キーを打たない。
 * 答えは run ごとに 1 つずつ流すので、2 台から同時に来ても 1 回しか打たれない。
 *
 * PeerChatAsk の kind が question のとき、input は質問の文である（許可のときは主な引数）。
 * 数字と本文は sendText で、Enter と Escape と Down は sendKey で送る。
 * tmux と psmux は同じキー名で通る。
 */

/**
 * 打った後に札が閉じるのを待つ長さと間隔。
 * */
const CLOSE_WAIT_MS = 4000;
const CLOSE_STEP_MS = 100;
/**
 * 複数選択で、確認の画面が出るのを待つ長さ。
 * */
const REVIEW_WAIT_MS = 2000;
/**
 * 答えた askId を覚えておく長さと数。
 * */
export const ANSWERED_TTL_MS = 10 * 60_000;
export const ANSWERED_MAX = 256;
/**
 * 引数の照合に使う長さ（空白を除いた文字数）。
 * 画面が長い命令を省くときがあるので、頭だけを見る。
 */
const INPUT_COMPARE_MAX = 600;

export type AnswerPane = {
  capture(): string;
  sendKey(key: PaneKey): void;
  sendText(text: string): void;
};

export type AnswerRefusal = Extract<PeerChatRefusal, 'ask-mismatch' | 'already-answered' | 'session-unknown'>;
export type AnswerResult = { ok: true; label: string } | { ok: false; reason: AnswerRefusal };
/**
 * sent が偽は、止める相手（走っているターン）がいなかったこと。
 * */
export type InterruptResult = { ok: true; sent: boolean } | { ok: false; reason: Extract<AnswerRefusal, 'ask-mismatch' | 'session-unknown'> };

export type PeerAnswererDeps = {
  /**
   * run の画面。
   * run が無い、終わっている、画面が無いときは null。
   */
  pane: (runId: string) => AnswerPane | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  answeredTtlMs?: number;
  maxAnswered?: number;
};

export type PeerAnswerer = {
  /**
   * 画面の札が ask と同じと確かめてから、keys（ask.options の key）と text で答える。
   * */
  answerAsk(runId: string, ask: PeerChatAsk, keys: string[], text?: string): Promise<AnswerResult>;
  /**
   * 走っているターンにだけ Escape を打つ。
   * 札が出ているときの Escape は断りになるので、打たずに断る。
   */
  interruptRun(runId: string): Promise<InterruptResult>;
};

/**
 * PaneOps の tmuxName の画面を、AnswerPane として見る。
 * */
export function answerPaneOf(panes: Pick<PaneOps, 'capture' | 'sendKey' | 'sendText'>, tmuxName: string): AnswerPane {
  return {
    capture: () => panes.capture(tmuxName),
    sendKey: (key) => panes.sendKey(tmuxName, key),
    sendText: (text) => panes.sendText(tmuxName, text),
  };
}

// ---- 画面の読み取り ----

export type DialogOption = {
  /**
   * 画面の番号。
   * */
  n: number;
  /**
   * 1 行目のラベル（チェックの箱は除く）。
   * */
  first: string;
  /**
   * 折り返した続きの行をつないだラベル。
   * */
  full: string;
  /**
   * 複数選択の箱の印。
   * 箱の無い行は null。
   */
  checked: boolean | null;
};

export type Dialog = {
  kind: 'permission' | 'question';
  options: DialogOption[];
  /**
   * 選択肢の上の行（質問の文、または Do you want…）。
   * */
  question: string;
  /**
   * 札の上の一続きの文字（空白を除く）。
   * 引数の照合に使う。
   */
  above: string;
  /**
   * 札の頭の見出し（ツールの題名を含む行）の文字。
   * 小文字。
   */
  header: string;
  /**
   * 1 回の呼び出しに質問が複数ある札か。
   * */
  manyQuestions: boolean;
  /**
   * 選択肢に箱がある（複数選択）か。
   * */
  multi: boolean;
};

const OPTION_RE = /^\s*(?:[❯>›]\s*)?(\d{1,2})\.\s+(?:\[([ ✔✓xX]?)\]\s*)?(\S.*?)\s*$/;
const RULE_RE = /^\s*[╌─┄━]{8,}\s*$/;
const FOOTER_RE = /esc to cancel|enter to (?:select|confirm)/i;
const CHIP_RE = /[☐☒☑✔✓]/g;
/**
 * 見出しの窓の行数（札の最初の罫線の上）。
 * */
const HEADER_WINDOW = 4;
/**
 * 札の上を読む行数。
 * */
const ABOVE_LINES = 40;

export const strip = (s: string): string => s.replace(/\s+/g, '');

/**
 * 画面から、出ている札（番号つきの選択肢と下の案内の行がある塊）を読む。
 * 無ければ null。
 */
export function parseDialog(screen: string): Dialog | null {
  const lines = screen.replace(/\r/g, '').split('\n');
  const optionAt: { i: number; n: number; text: string; checked: boolean | null }[] = [];
  lines.forEach((line, i) => {
    const m = OPTION_RE.exec(line);
    if (m) optionAt.push({ i, n: Number(m[1]), text: m[3]!, checked: m[2] === undefined ? null : m[2].trim() !== '' });
  });
  // 最後の 1 番から、番号が 1 つずつ増える行を選択肢とする。
  // 罫線や説明の行が間に入ってもよい。
  let start = -1;
  for (let k = optionAt.length - 1; k >= 0; k--) if (optionAt[k]!.n === 1) { start = k; break; }
  if (start < 0) return null;
  const group = [optionAt[start]!];
  for (let k = start + 1; k < optionAt.length; k++) {
    if (optionAt[k]!.n !== group[group.length - 1]!.n + 1) break;
    group.push(optionAt[k]!);
  }
  const last = group[group.length - 1]!;
  // アシスタントの番号つきの箇条書きと見分ける。
  // 札の下には、必ず案内の行（Esc to cancel など）がある。
  if (!lines.slice(last.i + 1, last.i + 9).some((l) => FOOTER_RE.test(l))) return null;

  const first = group[0]!;
  const options: DialogOption[] = group.map((g, k) => {
    const end = k + 1 < group.length ? group[k + 1]!.i : lines.length;
    let full = g.text;
    for (let j = g.i + 1; j < end; j++) {
      const l = lines[j]!;
      if (!/^ {3,}\S/.test(l) || RULE_RE.test(l) || FOOTER_RE.test(l)) break;
      full += ' ' + l.trim();
    }
    return { n: g.n, first: g.text, full, checked: g.checked };
  });

  let q = first.i - 1;
  while (q >= 0 && (lines[q]!.trim() === '' || RULE_RE.test(lines[q]!))) q--;
  const question = q >= 0 ? lines[q]!.trim() : '';
  const aboveLines = lines.slice(Math.max(0, first.i - ABOVE_LINES), first.i);
  // 札の最初の罫線（許可の札は命令を 2 本の罫線で挟む）の上の数行を、見出しの窓にする。
  const rules = aboveLines.map((l, i) => (RULE_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  const top = rules.length >= 2 ? rules[rules.length - 2]! : aboveLines.length;
  const headerLines = aboveLines.slice(Math.max(0, top - HEADER_WINDOW), top).filter((l) => l.trim() !== '');
  const body = rules.length >= 2 ? aboveLines.slice(Math.max(0, top - HEADER_WINDOW)) : aboveLines;

  // 質問の札の頭の「← ☐ 質問 ✔ Submit →」の行。
  // Submit の印を除いた箱の数が 2 以上なら、質問が複数ある。
  const chipLine = aboveLines.find((l) => (l.match(CHIP_RE)?.length ?? 0) > 0 && !OPTION_RE.test(l));
  const chips = chipLine ? (chipLine.match(CHIP_RE)?.length ?? 0) - (/submit/i.test(chipLine) ? 1 : 0) : 0;

  return {
    kind: /^do you want\b/i.test(question) ? 'permission' : 'question',
    options,
    question,
    above: strip(body.join('\n')),
    header: headerLines.join(' ').toLowerCase(),
    manyQuestions: chips > 1,
    multi: options.some((o) => o.checked !== null),
  };
}

/**
 * ツール名の題名への現れ方。
 * 見出しがこの語のどれかを含めば、同じツールとみなす。
 */
const TOOL_WORDS: Record<string, string[]> = {
  Bash: ['bash'],
  Edit: ['edit'],
  MultiEdit: ['edit'],
  Write: ['write', 'create', 'overwrite'],
  Read: ['read'],
  NotebookEdit: ['notebook'],
  WebFetch: ['fetch'],
  WebSearch: ['search'],
  Glob: ['glob', 'search'],
  Grep: ['grep', 'search'],
};

function toolMatches(ask: PeerChatAsk, d: Dialog): boolean {
  // 質問の札のツールは AskUserQuestion で、題名がない。
  // MCP のツールは題名の形が決まらないので、引数の照合に任せる。
  if (!ask.tool || ask.kind !== 'permission' || ask.tool.startsWith('mcp__')) return true;
  const words = TOOL_WORDS[ask.tool] ?? [ask.tool.toLowerCase()];
  return words.some((w) => d.header.includes(w));
}

function inputMatches(ask: PeerChatAsk, d: Dialog): boolean {
  if (!ask.input) return true;
  const want = strip(ask.input).slice(0, INPUT_COMPARE_MAX);
  return want === '' || d.above.includes(want);
}

/**
 * 画面の札が ask と同じか（種類、ツールと主な引数または質問の文、複数選択か）。
 * 選択肢のラベルは行を当てるときに見る。
 */
export function dialogMatches(ask: PeerChatAsk, d: Dialog): boolean {
  return d.kind === ask.kind && d.multi === ask.multi && !d.manyQuestions && toolMatches(ask, d) && inputMatches(ask, d);
}

/**
 * ラベルが完全に一致する行。
 * ちょうど 1 つのときだけ返す（0 や複数は null）。
 */
function rowByLabel(d: Dialog, label: string): DialogOption | null {
  const want = strip(label);
  const hits = d.options.filter((o) => strip(o.first) === want || strip(o.full) === want);
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * 自由入力の行（「Type something.」か「Other」）。
 * */
function otherRow(d: Dialog): DialogOption | null {
  const hits = d.options.filter((o) => /^(?:type something|other)\b/i.test(o.first));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * 走っているターンの印（案内に「esc to interrupt」が出る）。
 * */
const RUNNING_RE = /esc to interrupt/i;

// ---- 答える ----

/**
 * 答える手順の途中で、画面が思っていた形でなくなったことを表す。
 * それ以上は打たない。
 */
class Stop extends Error {}

export function createPeerAnswerer(deps: PeerAnswererDeps): PeerAnswerer {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ttl = deps.answeredTtlMs ?? ANSWERED_TTL_MS;
  const max = deps.maxAnswered ?? ANSWERED_MAX;
  /**
   * 答えた askId と、覚えておく期限。
   * Map は入れた順なので、古い順に捨てられる。
   */
  const answered = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();

  const remember = (askId: string): void => {
    answered.delete(askId);
    answered.set(askId, now() + ttl);
    while (answered.size > max) answered.delete(answered.keys().next().value!);
  };
  const isAnswered = (askId: string): boolean => {
    const t = now();
    for (const [id, until] of answered) if (until <= t) answered.delete(id);
    return answered.has(askId);
  };

  /**
   * run ごとに 1 つずつ流す。
   * 2 台からの答えや、答えと割り込みが、キーを混ぜない。
   */
  function queued<T>(runId: string, op: () => Promise<T>): Promise<T> {
    const next = (queues.get(runId) ?? Promise.resolve()).catch(() => {}).then(op);
    queues.set(runId, next);
    void next.finally(() => { if (queues.get(runId) === next) queues.delete(runId); }).catch(() => {});
    return next;
  }

  async function waitUntil(pane: AnswerPane, ok: (screen: string) => boolean, ms: number): Promise<boolean> {
    for (let waited = 0; ; waited += CLOSE_STEP_MS) {
      if (ok(pane.capture())) return true;
      if (waited >= ms) return false;
      await sleep(CLOSE_STEP_MS);
    }
  }

  /**
   * ask の札が、もう画面に無いこと。
   * 別の札に替わっていても、ask の札は閉じたとみなす。
   */
  const closed = (ask: PeerChatAsk) => (screen: string): boolean => {
    const d = parseDialog(screen);
    return d === null || !dialogMatches(ask, d);
  };

  async function answer(runId: string, ask: PeerChatAsk, keys: string[], text: string | undefined): Promise<AnswerResult> {
    const refuse = (reason: AnswerRefusal): AnswerResult => ({ ok: false, reason });
    if (isAnswered(ask.askId)) return refuse('already-answered');
    const pane = deps.pane(runId);
    if (!pane) return refuse('session-unknown');

    const hasText = text !== undefined && text !== '';
    // 入力の形そのものが、札の種類と合わなければ、画面を見るまでもなく断る。
    if (ask.kind === 'permission' && (keys.length !== 1 || hasText)) return refuse('ask-mismatch');
    if (ask.kind === 'question' && !ask.multi && (hasText ? keys.length !== 0 : keys.length !== 1)) return refuse('ask-mismatch');
    if (ask.kind === 'question' && ask.multi && keys.length === 0 && !hasText) return refuse('ask-mismatch');
    if (hasText && !ask.allowText) return refuse('ask-mismatch');
    if (new Set(keys).size !== keys.length) return refuse('ask-mismatch');
    const chosen = keys.map((k) => ask.options.find((o) => o.key === k));
    if (chosen.some((o) => !o)) return refuse('ask-mismatch');
    const labels = chosen.map((o) => o!.label);

    const dialog = parseDialog(pane.capture());
    if (!dialog || !dialogMatches(ask, dialog)) return refuse('ask-mismatch');
    // 質問の札は、ask が見せた選択肢がすべて画面にあるときだけ通す（別の質問に取り違えない）。
    if (ask.kind === 'question' && ask.options.some((o) => !rowByLabel(dialog, o.label))) return refuse('ask-mismatch');
    const rows = labels.map((l) => rowByLabel(dialog, l));
    if (rows.some((r) => !r)) return refuse('ask-mismatch');
    const other = hasText ? otherRow(dialog) : null;
    if (hasText && !other) return refuse('ask-mismatch');

    // ここから先は打つ。
    // 途中で止まっても、同じ札に 2 度は打たせない。
    remember(ask.askId);
    try {
      if (ask.kind === 'permission' || !ask.multi) {
        if (hasText) {
          pane.sendText(String(other!.n));
          pane.sendText(text!);
          pane.sendKey('enter');
        } else {
          pane.sendText(String(rows[0]!.n));
        }
      } else {
        for (const r of rows) pane.sendText(String(r!.n));
        const stepsToOther = other ? other.n - 1 : null;
        const otherRowN = otherRow(dialog)?.n;
        if (stepsToOther !== null) {
          for (let i = 0; i < stepsToOther; i++) pane.sendKey('down');
          pane.sendText(text!);
          pane.sendKey('down');
        } else {
          // Submit の行は Other の次にある。
          // Other の行までの数だけ下ると着く。
          if (otherRowN === undefined) throw new Stop();
          for (let i = 0; i < otherRowN; i++) pane.sendKey('down');
        }
        pane.sendKey('enter');
        // 確認の画面（Submit answers と Cancel）を確かめてから、もう一度 Enter で確定する。
        if (!(await waitUntil(pane, (s) => /submit answers/i.test(s), REVIEW_WAIT_MS))) throw new Stop();
        pane.sendKey('enter');
      }
    } catch (e) {
      if (e instanceof Stop) return refuse('ask-mismatch');
      throw e;
    }
    // 札が閉じたことを確かめる。
    // 閉じなければ、打ったキーは受け付けられていない。
    if (!(await waitUntil(pane, closed(ask), CLOSE_WAIT_MS))) return refuse('ask-mismatch');
    return { ok: true, label: [...labels, ...(hasText ? [text!] : [])].join(', ') };
  }

  async function interrupt(runId: string): Promise<InterruptResult> {
    const pane = deps.pane(runId);
    if (!pane) return { ok: false, reason: 'session-unknown' };
    const screen = pane.capture();
    // 札が出ているときの Escape は、断ると同じ。
    // 答えのつもりのない断りを打たない。
    if (parseDialog(screen)) return { ok: false, reason: 'ask-mismatch' };
    if (!RUNNING_RE.test(screen)) return { ok: true, sent: false };
    pane.sendKey('escape');
    return { ok: true, sent: true };
  }

  return {
    answerAsk: (runId, ask, keys, text) => queued(runId, () => answer(runId, ask, keys, text)),
    interruptRun: (runId) => queued(runId, () => interrupt(runId)),
  };
}
