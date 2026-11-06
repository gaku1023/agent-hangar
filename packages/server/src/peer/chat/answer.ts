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
const RULE_RE = /^\s*[╌─┄━]{8,}\s*$/;
const FOOTER_RE = /esc to cancel|enter to (?:select|confirm)/i;
const CHIP_RE = /[☐☒☑✔✓]/g;
const CHIP_ONE_RE = /[☐☒☑✔✓]/;
const DO_YOU_WANT_RE = /^\s*do you want\b/i;
/**
 * 札の見出しは、画面いっぱいの実線（─）の下に始まり、差分や引数を挟む破線（╌）の上で終わる。
 * 差分の行には行番号と +/- の印が付くので、この 2 種の線だけの行は差分には現れない。
 */
const SOLID_RE = /^\s*─{8,}\s*$/;
const DASHED_RE = /^\s*╌{8,}\s*$/;
/** 折り返した問いの上の行を探す行数。 */
const WRAP_LINES = 3;
/** 見出しの塊の行数の上限（題とパスと、NotebookEdit の説明の行）。 */
const HEAD_MAX = 5;
/**
 * 見出しの窓の行数（札の最初の罫線の上）。
 */
const HEADER_WINDOW = 4;
/**
 * 札の上を読む行数。
 */
const ABOVE_LINES = 40;

export const strip = (s: string): string => s.replace(/\s+/g, '');
/** 端末に打つ本文から、制御文字（C0 と DEL）を除く。 */
export const stripControl = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, '');

/**
 * ファイルの道具の札の題。
 * 見出しの 1 行目がこれと等しいときだけ、ファイルの札と読む（知らない題は読まず、照合は断る）。
 * call は、罫線の間が差分でなく ツール名(引数) の形の札（Read）。
 * 2.1.319 の実機で確かめた（fileDialogs.fixtures.ts）。MultiEdit の道具はこの版には無く、Edit file に MultiEdit の名も当てておく。
 */
const FILE_TITLES: Record<string, { tools: string[]; call?: true }> = {
  'edit file': { tools: ['Edit', 'MultiEdit'] },
  'create file': { tools: ['Write'] },
  'overwrite file': { tools: ['Write'] },
  'edit notebook': { tools: ['NotebookEdit'] },
  'read file': { tools: ['Read'], call: true },
};
const CALL_RE = /^([A-Za-z_]\w*)\(([\s\S]*)\)$/;

/**
 * 問い（qTop 行から）の上にある、見出し + 破線 + 中身 + 破線の札を、ファイルの札として読む。
 * 実線、題、パス、（説明の行）、破線、差分、破線、問いの順でなければ null。
 * 破線で挟まれた中身は、差分の行が番号と印を前に付けるので、見出しや線の偽物は作れない。
 */
function fileDialogOf(lines: string[], qTop: number): DialogFile | null {
  let bottom = qTop - 1;
  while (bottom >= 0 && lines[bottom]!.trim() === '') bottom--;
  if (bottom < 0 || !DASHED_RE.test(lines[bottom]!)) return null;
  let top = bottom - 1;
  while (top >= 0 && !DASHED_RE.test(lines[top]!)) top--;
  if (top < 0) return null;
  const head: string[] = [];
  let anchored = false;
  for (let k = top - 1; k >= 0 && head.length <= HEAD_MAX; k--) {
    const l = lines[k]!;
    if (SOLID_RE.test(l)) { anchored = true; break; }
    if (RULE_RE.test(l)) return null;
    if (l.trim() !== '') head.unshift(l.trim());
  }
  if (!anchored || head.length === 0) return null;
  const spec = FILE_TITLES[head[0]!.toLowerCase().replace(/\s+/g, ' ')];
  if (!spec) return null;
  if (spec.call) {
    const m = CALL_RE.exec(lines.slice(top + 1, bottom).map((l) => l.trim()).join(' ').trim());
    return { tools: spec.tools, path: m && m[1] === spec.tools[0] ? m[2]!.trim() : '' };
  }
  return { tools: spec.tools, path: head[1] ?? '' };
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
  // 最後の行は文の続きなので、すぐ上に続く行に Do you want… の頭があれば、つないで 1 つの問いとして読む。
  let qTop = q;
  if (q >= 0 && !DO_YOU_WANT_RE.test(lines[q]!)) {
    for (let k = q - 1; k >= 0 && q - k <= WRAP_LINES; k--) {
      const l = lines[k]!;
      if (l.trim() === '' || RULE_RE.test(l) || CHIP_ONE_RE.test(l)) break;
      if (DO_YOU_WANT_RE.test(l)) { qTop = k; break; }
    }
  }
  const question = q >= 0 ? lines.slice(qTop, q + 1).map((l) => l.trim()).join(' ') : '';
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
    ruled: rules.length >= 2 ? aboveLines.slice(rules[rules.length - 2]! + 1, rules[rules.length - 1]!).join('\n') : null,
    file: fileDialogOf(lines, qTop),
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
const slashed = (p: string, keepSpaces = false): string => (keepSpaces ? p.trim() : strip(p)).replace(/\\/g, '/');
const isAbsolute = (p: string): boolean => /^(?:[A-Za-z]:)?\//.test(p);

/**
 * パスを、cwd を根にした絶対のパス（区切りは /、. と .. は畳む）にする。
 * 照合のときは、空白を除き（折り返しで空白が変わるため）、ドライブ文字つきは大小を無視する（Windows）。
 * 見せるとき（display）は、空白も大小もそのままにする。
 * 相対なのに cwd が無いとき、左が … で切れているとき、~ で始まるときは null。
 */
export function resolvePath(p: string, cwd: string | null, display = false): string | null {
  const s = slashed(p, display);
  if (s === '' || TRUNC_RE.test(s) || s.startsWith('~')) return null;
  let full = s;
  if (!isAbsolute(s)) {
    if (cwd === null || cwd === '') return null;
    full = `${slashed(cwd, display)}/${s}`;
    if (!isAbsolute(full)) return null;
  }
  const drive = /^[A-Za-z]:/.exec(full)?.[0] ?? '';
  const segs: string[] = [];
  for (const seg of full.slice(drive.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segs.pop();
    else segs.push(seg);
  }
  const out = `${drive}/${segs.join('/')}`;
  return drive && !display ? out.toLowerCase() : out;
}

/**
 * 札のパスを、ほかの PC に見せる絶対のパスにする（hook の入力が無いときに、ask の input にする）。
 * 絶対にできなければ（相対で cwd が無い、左が … で切れている）、画面の文字をそのまま返す。
 * 区切りは、ドライブ文字つきなら \\ に戻す。大小は変えない。
 */
export function displayPath(shown: string, cwd: string | null): string {
  const abs = resolvePath(shown, cwd, true);
  if (abs === null) return shown.trim();
  return /^[A-Za-z]:/.test(abs) ? abs.replace(/\//g, '\\') : abs;
}

/**
 * ask のパス（hook が届けた絶対パス、または画面から組んだ文字）が、札に出ているパスと同じファイルか。
 * 札のパスは cwd からの相対で出ることがあるので、cwd を根にして絶対にしてから比べる。
 * 札のパスは長いと左が … で切れる。
 * 切れていれば、ask の絶対パスがその末尾で終わることを求める（切れ目は区切りの途中でもよい）。
 * 画面から組んだ ask も切れていれば、同じ文字であることだけを求める。
 * 空白は除いて比べる。
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
 * ask のツールが題のさすツールで、パスが同じファイルで、問いの文のファイル名も ask のものと同じであること。
 * 罫線の間の差分は見ない（ask は差分を持たない）。
 */
function fileMatches(ask: PeerChatAsk, f: DialogFile, d: Dialog, cwd: string | null): boolean {
  if (!ask.tool || !f.tools.includes(ask.tool)) return false;
  if (!ask.input || f.path === '' || !samePath(ask.input, f.path, cwd)) return false;
  // Read の問いはファイル名を含まない（Do you want to proceed?）ので、パスの照合だけにする。
  if (f.tools.includes('Read')) return true;
  // 編集、作成、上書きの問いには、ファイル名（ディレクトリは含まない）が入る。
  // 見出しのパスと問いのファイル名の両方が ask と合うことを求める。
  if (!/^do you want to (?:make this edit to|create|overwrite)\b/i.test(d.question)) return false;
  const base = baseName(ask.input);
  return base !== '' && !TRUNC_RE.test(base) && strip(d.question).toLowerCase().includes(strip(base).toLowerCase());
}

/**
 * 画面の札が ask と同じか（種類、ツールと主な引数または質問の文、複数選択か）。
 * 選択肢のラベルは行を当てるときに見る。
 * ファイルの道具の札は、差分でなくパスで照合する（cwd は相対のパスを絶対にするのに使う）。
 */
export function dialogMatches(ask: PeerChatAsk, d: Dialog, cwd: string | null = null): boolean {
  if (d.kind !== ask.kind || d.multi !== ask.multi || d.manyQuestions) return false;
  if (d.file) return ask.kind === 'permission' && fileMatches(ask, d.file, d, cwd);
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
    // 本文は send-keys -l で打つので、制御文字（CR、ESC、改行など）が入ると、途中で確定したり次の入力に落ちたりする。
    // 制御文字は除き、通常の文字（日本語を含む）は変えない。
    // 除いたら空になる本文は、何も打たずに断る。
    const text = rawText === undefined ? undefined : stripControl(rawText);
    if (rawText !== undefined && rawText !== '' && text === '') return { ok: false, reason: 'ask-mismatch' };
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
    if (!RUNNING_RE.test(tail)) return { ok: true, sent: false };
    pane.sendKey('escape');
    return { ok: true, sent: true };
  }

  return {
    answerAsk: (runId, ask, keys, text) => queued(runId, () => answer(runId, ask, keys, text)),
    interruptRun: (runId) => queued(runId, () => interrupt(runId)),
  };
}
