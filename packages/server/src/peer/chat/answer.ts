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
 */
const CLOSE_WAIT_MS = 4000;
const CLOSE_STEP_MS = 100;
/**
 * 複数選択で、確認の画面が出るのを待つ長さ。
 */
const REVIEW_WAIT_MS = 2000;
/**
 * 答えた askId を覚えておく長さと数。
 */
export const ANSWERED_TTL_MS = 10 * 60_000;
export const ANSWERED_MAX = 256;
/** 走っているターンの印を探す、画面の末尾の行数。 */
const RUNNING_TAIL_LINES = 8;

export type AnswerPane = {
  capture(): string;
  sendKey(key: PaneKey): void;
  sendText(text: string): void;
};

export type AnswerRefusal = Extract<PeerChatRefusal, 'ask-mismatch' | 'already-answered' | 'session-unknown'>;
/**
 * 断りの理由は計画の一覧のままにし、sent だけを足す。
 * sent が真は、キーを打った後に断ったこと（札が閉じなかった、確認の画面が出なかった）。
 * 偽か無しは、何も打っていないこと。
 * sent が真の断りは、答えが画面に届いたかもしれない。呼び手は「打っていない断り」と同じに扱わない。
 * 残る危険：古い ask への答えが、同じ見た目の新しい札に当たりうる。
 * 照合は画面の文字だけなので、同じ命令の札が続けて出れば区別できない。
 * この窓は、頼みの期限（60 秒）と、答えた askId の記録（ANSWERED_TTL_MS）で抑える。
 */
export type AnswerResult = { ok: true; label: string } | { ok: false; reason: AnswerRefusal; sent?: boolean };
/**
 * sent が偽は、止める相手（走っているターン）がいなかったこと。
 */
export type InterruptResult = { ok: true; sent: boolean } | { ok: false; reason: Extract<AnswerRefusal, 'ask-mismatch' | 'session-unknown'> };

export type PeerAnswererDeps = {
  /**
   * run の画面。
   * run が無い、終わっている、画面が無いときは null。
   */
  pane: (runId: string) => AnswerPane | null;
  /**
   * run の作業ディレクトリ（Claude Code を起こした場所）。
   * ファイルの道具の札は、cwd からの相対のパスを出すので、絶対の ask と突き合わせるのに使う。
   * 分からなければ null（相対と絶対は突き合わせられず、同じ文字のときだけ通す）。
   */
  cwd?: (runId: string) => string | null;
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
 */
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

export type DialogFile = {
  /**
   * 題がさす道具。
   * Edit file は Edit と MultiEdit、Create file と Overwrite file は Write。
   */
  tools: string[];
  /**
   * 画面に出ているパス。
   * cwd からの相対のことがあり、長いと左が … で切れる。
   * 読めなければ空。
   */
  path: string;
  /**
   * 問いの文の頭（ファイル名の前まで）。
   * 問いがファイル名を含まない札（Read）は null。
   */
  lead: string | null;
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
   * 許可の札の、2 本の罫線に挟まれた文字（命令や引数の本体）。
   * 罫線が 2 本見つからなければ null。
   */
  ruled: string | null;
  /**
   * 札の頭の見出し（ツールの題名を含む行）の文字。
   * 小文字。
   */
  header: string;
  /**
   * 札の題（罫線で挟んだ本体の上の見出しの 1 行目）。
   * 小文字で、空白の連なりは 1 つにする。
   * 罫線で挟んだ本体が読めなければ null。
   */
  title: string | null;
  /**
   * ファイルの道具（Edit、Write、NotebookEdit、Read）の札のとき、その中身。
   * 見出しの題で決める（Bash などの命令の札は null）。
   * 罫線の間は差分で引数ではないので、パスは見出しの 2 行目（Read は罫線の間の Read(パス)）から読む。
   */
  file: DialogFile | null;
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
/**
 * 罫線の行。
 * 本物の罫線は左端（列 0）から始まる。
 * 命令や差分の本文の行は、先頭に空白か行番号が付くので、本文に罫線の文字を並べても罫線とは読まない。
 */
const RULE_RE = /^[╌─┄━]{8,}\s*$/;
/**
 * 罫線の幅。
 * 画面の幅いっぱいなので、同じ札の罫線は同じ幅になる。
 */
const ruleWidth = (l: string): number => l.trimEnd().length;
const FOOTER_RE = /esc to cancel|enter to (?:select|confirm)/i;
const CHIP_RE = /[☐☒☑✔✓]/g;
const CHIP_ONE_RE = /[☐☒☑✔✓]/;
const DO_YOU_WANT_RE = /^\s*do you want\b/i;
/**
 * 下の破線と問いの間に出る、決まった案内の行（2.1.319 の命令の札）。
 * 決まった文だけを許し、ほかの行が挟まれば本体を読まない。
 */
const GAP_NOTICE_RE = /^\s*this command requires approval\s*$/i;
/**
 * 札の見出しは、画面いっぱいの実線（─）の下に始まり、差分や引数を挟む破線（╌）の上で終わる。
 * 3 本の罫線は左端から始まり、同じ幅である。
 */
const SOLID_RE = /^─{8,}\s*$/;
const DASHED_RE = /^╌{8,}\s*$/;
/** 折り返した問いの上の行を探す行数。 */
const WRAP_LINES = 3;
/** 見出しの塊の行数の上限（題とパスと、NotebookEdit の説明の行）。 */
const HEAD_MAX = 5;
/** 題を探す行数の上限（題、Tip、モデルの書いた説明の行）。 */
const TITLE_LINES = 8;
/**
 * 命令の札の題。
 * hook の許可が無いとき、答えてよいのはこの題の札だけである（ほかの札は、画面の本体を input にして答えさせない）。
 * 2.1.319 の実機で確かめたのは Bash command だけ。
 */
const COMMAND_TITLES = new Set(['bash command']);
export const isCommandTitle = (title: string): boolean => COMMAND_TITLES.has(title);
/**
 * 見出しの窓の行数（札の最初の罫線の上）。
 */
const HEADER_WINDOW = 4;
/**
 * 札の上を読む行数。
 */
const ABOVE_LINES = 40;

export const strip = (s: string): string => s.replace(/\s+/g, '');
/**
 * 端末に打つ本文を整える。
 * 改行とタブ（CR、LF、TAB）は空白 1 つにし、ほかの制御文字（C0 と DEL）は除く。
 * 通常の文字（日本語を含む）は変えない。
 */
export const stripControl = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');

/**
 * ファイルの道具の札の題。
 * 見出しの 1 行目がこれと等しいときだけ、ファイルの札と読む（知らない題は読まず、照合は断る）。
 * lead は問いの文の頭で、null は問いが Do you want to proceed? の札（罫線の間が ツール名(引数) の 1 行になる Read）。
 * 2.1.319 の実機で確かめた（fileDialogs.fixtures.ts）。
 * MultiEdit の道具はこの版には無く、Edit file に MultiEdit の名も当てておく。
 */
const FILE_TITLES: Record<string, { tools: string[]; lead: string | null }> = {
  'edit file': { tools: ['Edit', 'MultiEdit'], lead: 'Do you want to make this edit to ' },
  'create file': { tools: ['Write'], lead: 'Do you want to create ' },
  'overwrite file': { tools: ['Write'], lead: 'Do you want to overwrite ' },
  'edit notebook': { tools: ['NotebookEdit'], lead: 'Do you want to make this edit to ' },
  'read file': { tools: ['Read'], lead: null },
};
const CALL_RE = /^([A-Za-z_]\w*)\(([\s\S]*)\)$/;

/**
 * 問い（qTop 行から）の上にある、実線、見出し、破線、中身、破線の札を、ファイルの札として読む。
 * 実線、題、パス、（説明の行）、破線、差分、破線、問いの順でなければ null。
 * 3 本の罫線は左端から始まり、同じ幅でなければならない。
 * 本文の行は先頭に空白か行番号が付くので、見出しや罫線の偽物は作れない。
 * Read は、罫線の間が Read(パス) の 1 行だけであること。
 */
function fileDialogOf(lines: string[], qTop: number): DialogFile | null {
  let bottom = qTop - 1;
  while (bottom >= 0 && lines[bottom]!.trim() === '') bottom--;
  if (bottom < 0 || !DASHED_RE.test(lines[bottom]!)) return null;
  let top = bottom - 1;
  while (top >= 0 && !RULE_RE.test(lines[top]!)) top--;
  if (top < 0 || !DASHED_RE.test(lines[top]!) || ruleWidth(lines[top]!) !== ruleWidth(lines[bottom]!)) return null;
  const head: string[] = [];
  let solid = -1;
  for (let k = top - 1; k >= 0 && head.length <= HEAD_MAX; k--) {
    const l = lines[k]!;
    if (RULE_RE.test(l)) {
      if (SOLID_RE.test(l) && ruleWidth(l) === ruleWidth(lines[top]!)) solid = k;
      break;
    }
    if (l.trim() !== '') head.unshift(l.trim());
  }
  if (solid < 0 || head.length === 0) return null;
  const spec = FILE_TITLES[head[0]!.toLowerCase().replace(/\s+/g, ' ')];
  if (!spec) return null;
  if (spec.lead === null) {
    const body = lines.slice(top + 1, bottom).filter((l) => l.trim() !== '');
    const m = body.length === 1 ? CALL_RE.exec(body[0]!.trim()) : null;
    return { tools: spec.tools, lead: null, path: m && m[1] === spec.tools[0] ? m[2]!.trim() : '' };
  }
  return { tools: spec.tools, lead: spec.lead, path: head[1] ?? '' };
}

/**
 * 上の罫線（topAbs 行）の上にある見出しの 1 行目を、札の題として返す。
 * 左端の罫線（札の頭の実線）か画面の頭までを見出しとし、行が多すぎるときは null にする。
 */
function titleAbove(lines: string[], topAbs: number): string | null {
  const head: string[] = [];
  for (let k = topAbs - 1; k >= 0; k--) {
    const l = lines[k]!;
    if (RULE_RE.test(l)) break;
    if (l.trim() === '') continue;
    head.unshift(l.trim());
    if (head.length > TITLE_LINES) return null;
  }
  return head.length > 0 ? head[0]!.replace(/\s+/g, ' ').toLowerCase() : null;
}

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
  // 長いファイル名の問い（Do you want to create …）は 2 行に折り返す。
  // 最後の行は文の続きなので、すぐ上に続く行に Do you want… の頭があるときは、つないで 1 つの問いとして読む。
  // つなぐのは、その問いがファイルの札として読めるときだけにする（質問の札を許可の札に変えない）。
  let qTop = q;
  let file = fileDialogOf(lines, q);
  if (q >= 0 && !DO_YOU_WANT_RE.test(lines[q]!)) {
    for (let k = q - 1; k >= 0 && q - k <= WRAP_LINES; k--) {
      const l = lines[k]!;
      if (l.trim() === '' || RULE_RE.test(l) || CHIP_ONE_RE.test(l)) break;
      if (DO_YOU_WANT_RE.test(l)) {
        const f = fileDialogOf(lines, k);
        if (f) { qTop = k; file = f; }
        break;
      }
    }
  }
  const question = q >= 0 ? lines.slice(qTop, q + 1).map((l) => l.trim()).join(' ') : '';
  const aboveLines = lines.slice(Math.max(0, first.i - ABOVE_LINES), first.i);
  // 札の最初の罫線（許可の札は命令を 2 本の罫線で挟む）の上の数行を、見出しの窓にする。
  const rules = aboveLines.map((l, i) => (RULE_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  const top = rules.length >= 2 ? rules[rules.length - 2]! : aboveLines.length;
  // 罫線で挟んだ本体は、2 本が同じ幅で、下の罫線のすぐ下が問いの行（間は空行か決まった案内の行だけ）のときだけ読む。
  // 命令の本文に罫線の文字を並べても、本文の行は左端から始まらないので罫線にならない。
  let ruled: string | null = null;
  if (rules.length >= 2) {
    const rt = rules[rules.length - 2]!;
    const rb = rules[rules.length - 1]!;
    const base = Math.max(0, first.i - ABOVE_LINES);
    const gap = lines.slice(base + rb + 1, qTop);
    if (ruleWidth(aboveLines[rt]!) === ruleWidth(aboveLines[rb]!) && gap.every((l) => l.trim() === '' || GAP_NOTICE_RE.test(l))) {
      ruled = aboveLines.slice(rt + 1, rb).join('\n');
    }
  }
  const title = ruled === null ? null : titleAbove(lines, Math.max(0, first.i - ABOVE_LINES) + top);
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
    ruled,
    file,
    header: headerLines.join(' ').toLowerCase(),
    title,
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

/**
 * 主な引数（許可）か質問の文（質問）が、画面と同じか。
 * input が無い、または空なら、何とも照合できないので通さない（どの札にも当たってしまう）。
 * 許可は、2 本の罫線に挟まれた文字と、空白を除いて等しいことを求める。
 * 部分一致にしない（短い ask が長い命令に当たる）。
 * モデルが書く説明の行は罫線の外なので、照合に入らない。
 * 画面が長い命令を省略記号（… か ...）で切っているときだけ、見えている頭が ask の頭と同じなら通す。
 */
function inputMatches(ask: PeerChatAsk, d: Dialog): boolean {
  const want = strip(ask.input ?? '');
  if (want === '') return false;
  if (ask.kind === 'question') return d.above.includes(want);
  if (d.ruled === null) return false;
  const got = strip(d.ruled);
  if (got === want) return true;
  const elided = /(?:…|\.\.\.)$/.test(got);
  const head = got.replace(/(?:…|\.\.\.)$/, '');
  return elided && head !== '' && want.startsWith(head);
}

// ---- ファイルのパス ----

const TRUNC_RE = /^(?:…|\.\.\.)/;
/**
 * パスの比較用の形。
 * 前後の空白だけを除き、内側の空白は残す（my file.txt と myfile.txt は別のファイルである）。
 * 区切りは / にそろえる。
 */
const slashed = (p: string): string => p.trim().replace(/\\/g, '/');
const isAbsolute = (p: string): boolean => /^(?:[A-Za-z]:)?\//.test(p);
/** 空白の連なりを 1 つにする（折り返した問いの文の比較に使う）。 */
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * パスを、cwd を根にした絶対のパス（区切りは /、. と .. は畳む）にする。
 * ドライブ文字つきは大小を無視する（Windows）。
 * 相対なのに cwd が無いとき、左が … で切れているとき、~ で始まるとき、.. が根より上へ出るときは null。
 */
export function resolvePath(p: string, cwd: string | null): string | null {
  const s = slashed(p);
  if (s === '' || TRUNC_RE.test(s) || s.startsWith('~')) return null;
  let full = s;
  if (!isAbsolute(s)) {
    if (cwd === null || cwd === '') return null;
    full = `${slashed(cwd)}/${s}`;
    if (!isAbsolute(full)) return null;
  }
  const drive = /^[A-Za-z]:/.exec(full)?.[0] ?? '';
  const segs: string[] = [];
  for (const seg of full.slice(drive.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length === 0) return null;
      segs.pop();
    } else segs.push(seg);
  }
  const out = `${drive}/${segs.join('/')}`;
  return drive ? out.toLowerCase() : out;
}

/**
 * ask のパス（hook が届けた絶対パス）が、札に出ているパスと同じファイルか。
 * 札のパスは cwd からの相対で出ることがあるので、cwd を根にして絶対にしてから比べる。
 * 札のパスは長いと左が … で切れる。
 * 切れていれば、ask の絶対パスがその末尾で終わることを求める（切れ目は区切りの途中でもよい）。
 * ask も切れていれば、同じ文字であることだけを求める。
 * 内側の空白は残して比べる。
 */
export function samePath(want: string, shown: string, cwd: string | null): boolean {
  const w = slashed(want);
  const s = slashed(shown);
  if (w === '' || s === '') return false;
  if (w === s) return true;
  const wCut = TRUNC_RE.test(w);
  const sCut = TRUNC_RE.test(s);
  if (wCut && sCut) return false;
  if (!wCut && !sCut) {
    const rw = resolvePath(w, cwd);
    return rw !== null && rw === resolvePath(s, cwd);
  }
  const full = resolvePath(wCut ? s : w, cwd);
  const tail = (wCut ? w : s).replace(TRUNC_RE, '');
  if (full === null || tail === '') return false;
  return full.endsWith(/^[A-Za-z]:/.test(full) ? tail.toLowerCase() : tail);
}

const baseName = (p: string): string => slashed(p).split('/').filter(Boolean).pop() ?? '';

/**
 * ファイルの札が ask と同じか。
 * ask のツールが題のさすツールで、パスが同じファイルで、問いの文が期待どおりであること。
 * 問いの文は、題ごとの決まった形に ask のファイル名を入れたものと、空白の連なりを 1 つにして等しいことを求める。
 * Read の問いは Do you want to proceed? に等しいこと。
 * 罫線の間の差分は見ない（ask は差分を持たない）。
 */
function fileMatches(ask: PeerChatAsk, f: DialogFile, d: Dialog, cwd: string | null): boolean {
  if (!ask.tool || !f.tools.includes(ask.tool)) return false;
  if (!ask.input || f.path === '' || !samePath(ask.input, f.path, cwd)) return false;
  if (f.lead === null) return collapse(d.question) === 'Do you want to proceed?';
  const base = baseName(ask.input);
  if (base === '' || TRUNC_RE.test(base)) return false;
  return collapse(d.question) === collapse(`${f.lead}${base}?`);
}

/**
 * 画面の札が ask と同じか（種類、ツールと主な引数または質問の文、複数選択か）。
 * 選択肢のラベルは行を当てるときに見る。
 * ファイルの道具の札は、差分でなくパスで照合する（cwd は相対のパスを絶対にするのに使う）。
 */
export function dialogMatches(ask: PeerChatAsk, d: Dialog, cwd: string | null = null): boolean {
  if (d.kind !== ask.kind || d.multi !== ask.multi || d.manyQuestions) return false;
  if (d.file) return ask.kind === 'permission' && fileMatches(ask, d.file, d, cwd);
  // hook の許可が無い ask（ツールが無い）は、命令の札にだけ当てる。
  // 知らない題の札は、画面の本体を input にしても答えさせない。
  if (ask.kind === 'permission' && !ask.tool && !(d.title !== null && isCommandTitle(d.title))) return false;
  return toolMatches(ask, d) && inputMatches(ask, d);
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
 */
function otherRow(d: Dialog): DialogOption | null {
  const hits = d.options.filter((o) => /^(?:type something|other)\b/i.test(o.first));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * 走っているターンの印（案内に「esc to interrupt」が出る）。
 */
const RUNNING_RE = /esc to interrupt/i;
/**
 * 走っているターンのもう一つの印（動いている間の行。`✢ Roosting… (9s · ↓ 451 tokens)`）。
 * 案内の行を自前の表示（statusline や mode の行）が占めると、「esc to interrupt」は出ない（2.1.319 の実機）。
 * 終わったあとの行（`✻ Brewed for 15s · done 17:46`）は … と括弧を持たないので当たらない。
 */
const SPINNER_RE = /^[·✢✳✶✻✽*]\s+\S[^(\n]*…\s+\(\d/m;

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
  const closed = (ask: PeerChatAsk, cwd: string | null) => (screen: string): boolean => {
    const d = parseDialog(screen);
    return d === null || !dialogMatches(ask, d, cwd);
  };

  async function answer(runId: string, ask: PeerChatAsk, keys: string[], rawText: string | undefined): Promise<AnswerResult> {
    // 本文は send-keys -l で打つので、制御文字（CR、ESC など）が入ると、途中で確定したり次の入力に落ちたりする。
    // 改行とタブは空白にし、ほかの制御文字は除く（stripControl）。
    // 空白しか残らない本文は、何も打たずに断る。
    const text = rawText === undefined ? undefined : stripControl(rawText);
    if (text !== undefined && rawText !== '' && text.trim() === '') return { ok: false, reason: 'ask-mismatch' };
    const refuse = (reason: AnswerRefusal, sent = false): AnswerResult => (sent ? { ok: false, reason, sent: true } : { ok: false, reason });
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
    const cwd = deps.cwd?.(runId) ?? null;
    if (!dialog || !dialogMatches(ask, dialog, cwd)) return refuse('ask-mismatch');
    // 質問の札は、ask が見せた選択肢がすべて画面にあるときだけ通す（別の質問に取り違えない）。
    if (ask.kind === 'question' && ask.options.some((o) => !rowByLabel(dialog, o.label))) return refuse('ask-mismatch');
    const rows = labels.map((l) => rowByLabel(dialog, l));
    if (rows.some((r) => !r)) return refuse('ask-mismatch');
    const other = hasText ? otherRow(dialog) : null;
    if (hasText && !other) return refuse('ask-mismatch');
    // 番号は数字 1 つで打つ。2 桁の行は 2 回のキーになり、別の行に当たるので断る。
    if (rows.some((r) => r!.n > 9) || (other && other.n > 9)) return refuse('ask-mismatch');

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
      if (e instanceof Stop) return refuse('ask-mismatch', true);
      throw e;
    }
    // 札が閉じたことを確かめる。
    // 閉じなければ、打ったキーは受け付けられていない。
    if (!(await waitUntil(pane, closed(ask, cwd), CLOSE_WAIT_MS))) return refuse('ask-mismatch', true);
    return { ok: true, label: [...labels, ...(hasText ? [text!] : [])].join(', ') };
  }

  async function interrupt(runId: string): Promise<InterruptResult> {
    const pane = deps.pane(runId);
    if (!pane) return { ok: false, reason: 'session-unknown' };
    const screen = pane.capture();
    // 札が出ているときの Escape は、断ると同じ。
    // 答えのつもりのない断りを打たない。
    if (parseDialog(screen)) return { ok: false, reason: 'ask-mismatch' };
    // 印は画面の末尾（案内の行）に出る。
    // 本文やアシスタントの出力に同じ語があっても、走っているとは見なさない。
    const tail = screen.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '').slice(-RUNNING_TAIL_LINES).join('\n');
    if (!RUNNING_RE.test(tail) && !SPINNER_RE.test(tail)) return { ok: true, sent: false };
    pane.sendKey('escape');
    return { ok: true, sent: true };
  }

  return {
    answerAsk: (runId, ask, keys, text) => queued(runId, () => answer(runId, ask, keys, text)),
    interruptRun: (runId) => queued(runId, () => interrupt(runId)),
  };
}
