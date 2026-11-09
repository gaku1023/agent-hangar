import type { PeerChatAsk } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import type { PaneKey } from '../../tmux/pane.ts';
import { createPeerAnswerer, parseDialog, type AnswerPane } from './answer.ts';

// ---- 偽の Claude Code（tmux 不要）----
// 実機（Claude Code 2.1.319、tmux 3.8 と psmux 3.4.0）で確かめた画面とキーの効き方を、そのまま真似る。
// 許可の札は数字 1 つで確定する。
// 単一選択の質問も数字 1 つで確定し、Other の行の数字は文字の入力に入るだけである。
// 複数選択は数字で切り替え、Down で Other の次の Submit まで下り、Enter で確認の画面、もう一度 Enter で確定する。

type Screen =
  | { t: 'permission'; command: string; rows: string[]; tool?: string; desc?: string }
  | { t: 'question'; question: string; options: string[]; multi: boolean }
  | { t: 'running' }
  | { t: 'idle' };

const RULE = '╌'.repeat(44);

class FakeClaude implements AnswerPane {
  events: string[] = [];
  screen: Screen;
  /**
   * 何かが確定したときの結果。
   * */
  result: string | null = null;
  private cursor = 1;
  private checked = new Set<number>();
  private typing = false;
  private typed = '';
  private review = false;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  capture(): string {
    const s = this.screen;
    if (s.t === 'idle') return '● done\n\n❯ \n';
    if (s.t === 'running') return '● Bash(sleep 100)\n  ⎿  Running…\n\n✻ Working… (3s · esc to interrupt)\n';
    if (s.t === 'permission') {
      const lines = [' ' + (s.tool ?? 'Bash command'), ' Tip: auto mode handles these prompts for you', ' ' + (s.desc ?? 'mock desc'), RULE, ' ' + s.command, RULE, ' Do you want to proceed?'];
      s.rows.forEach((r, i) => lines.push(`${i + 1 === this.cursor ? ' ❯ ' : '   '}${i + 1}. ${r}`));
      lines.push(' Esc to cancel · Tab to amend');
      return lines.join('\n') + '\n';
    }
    if (this.review) return ' Review your answers\n\n ❯ 1. Submit answers\n   2. Cancel\n\n Enter to select · Esc to cancel\n';
    const rows = [...s.options, 'Type something.'];
    const lines = [' ☐ Choice', s.question];
    rows.forEach((r, i) => {
      const box = s.multi ? (this.checked.has(i + 1) ? '[✔] ' : '[ ] ') : '';
      lines.push(`${i + 1 === this.cursor ? '❯ ' : '  '}${i + 1}. ${box}${r}`);
      if (i < s.options.length) lines.push('     ' + r + ' (description)');
    });
    if (s.multi) lines.push(`${this.cursor === rows.length + 1 ? '❯ ' : '  '}Submit`);
    lines.push('──────────', '  ' + (rows.length + 1) + '. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel');
    return lines.join('\n') + '\n';
  }

  sendText(text: string): void {
    this.events.push(`text:${text}`);
    const s = this.screen;
    if (this.typing) { this.typed += text; return; }
    if (s.t === 'permission' && /^\d$/.test(text)) {
      this.finish(`perm:${text}`);
    } else if (s.t === 'question' && /^\d$/.test(text)) {
      const n = Number(text);
      const other = s.options.length + 1;
      if (s.multi) {
        if (n <= s.options.length) { if (!this.checked.delete(n)) this.checked.add(n); }
      } else if (n === other) {
        this.typing = true;
      } else if (n <= s.options.length) {
        this.finish(`single:${s.options[n - 1]}`);
      }
    } else if (s.t === 'question' && s.multi && this.cursor === s.options.length + 1) {
      // Other の行に打つと、箱が自動で入る。
      this.typed += text;
      this.checked.add(this.cursor);
    }
  }

  sendKey(key: PaneKey): void {
    this.events.push(`key:${key}`);
    const s = this.screen;
    if (key === 'escape') {
      if (s.t === 'permission' || s.t === 'question') this.finish('escape');
      else if (s.t === 'running') this.screen = { t: 'idle' };
      return;
    }
    if (key === 'down') { this.cursor += 1; return; }
    if (key !== 'enter') return;
    if (s.t === 'permission') { this.finish(`perm:${this.cursor}`); return; }
    if (s.t !== 'question') return;
    if (this.review) { this.finish(`multi:${[...this.checked].map((i) => (i <= s.options.length ? s.options[i - 1] : this.typed)).join(',')}`); return; }
    if (this.typing) { this.finish(`text:${this.typed}`); return; }
    if (s.multi && this.cursor === s.options.length + 2) this.review = true;
  }

  private finish(result: string): void {
    this.result = result;
    this.screen = { t: 'idle' };
    this.review = false;
  }
}

const noSleep = async (): Promise<void> => {};
function setup(screen: Screen, over: Partial<Parameters<typeof createPeerAnswerer>[0]> = {}) {
  const pane = new FakeClaude(screen);
  const answerer = createPeerAnswerer({ pane: (runId) => (runId === 'r1' ? pane : null), sleep: noSleep, ...over });
  return { pane, ...answerer };
}

const BASH = 'echo hi > a.txt';
const permScreen = (command = BASH): Screen => ({
  t: 'permission',
  command,
  rows: ['Yes', "Yes, and don't ask again for mkdir -p zz commands in C:\\work\\w1", 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'No'],
});
const permAsk = (over: Partial<PeerChatAsk> = {}): PeerChatAsk => ({
  askId: 'a1',
  kind: 'permission',
  tool: 'Bash',
  input: BASH,
  options: [
    { key: 'allow', label: 'Yes' },
    { key: 'always', label: "Yes, and don't ask again for mkdir -p zz commands in C:\\work\\w1" },
    { key: 'deny', label: 'No' },
  ],
  multi: false,
  allowText: false,
  ...over,
});
const qScreen = (multi: boolean): Screen => ({ t: 'question', question: 'Which color?', options: ['Red', 'Green', 'Blue'], multi });
const qAsk = (multi: boolean, over: Partial<PeerChatAsk> = {}): PeerChatAsk => ({
  askId: 'q1',
  kind: 'question',
  tool: 'AskUserQuestion',
  input: 'Which color?',
  options: [{ key: 'o1', label: 'Red' }, { key: 'o2', label: 'Green' }, { key: 'o3', label: 'Blue' }],
  multi,
  allowText: true,
  ...over,
});

describe('answerAsk: 許可の札', () => {
  it('許可は、ラベルで行を当てた数字を 1 つだけ打つ', async () => {
    const t = setup(permScreen());
    expect(await t.answerAsk('r1', permAsk(), ['allow'])).toEqual({ ok: true, label: 'Yes' });
    expect(t.pane.events).toEqual(['text:1']);
    expect(t.pane.result).toBe('perm:1');
  });

  it('断るは No の行を当てる（番号は固定でない。自動のモードの行があれば 4、無ければ 3）', async () => {
    const t = setup(permScreen());
    await t.answerAsk('r1', permAsk(), ['deny']);
    expect(t.pane.events).toEqual(['text:4']);
    const rows = (permScreen() as Extract<Screen, { t: 'permission' }>).rows.filter((r) => !r.includes('auto mode'));
    const u = setup({ t: 'permission', command: BASH, rows });
    await u.answerAsk('r1', permAsk(), ['deny']);
    expect(u.pane.events).toEqual(['text:3']);
    expect(u.pane.result).toBe('perm:3');
  });

  it('いつも許可は、2 行に折り返した行のラベルでも当たる', async () => {
    const t = setup(permScreen());
    // 狭い端末では 2 行目へ折り返し、続きは字下げされる。
    const orig = t.pane.capture.bind(t.pane);
    t.pane.capture = () => orig().replace("2. Yes, and don't ask again for mkdir -p zz commands in C:\\work\\w1", "2. Yes, and don't ask again for mkdir -p zz commands in\n      C:\\work\\w1");
    expect(await t.answerAsk('r1', permAsk(), ['always'])).toMatchObject({ ok: true });
    expect(t.pane.events).toEqual(['text:2']);
  });

  it('改行や折り返しで空白が変わっていても、同じ命令なら通す', async () => {
    const t = setup(permScreen('echo   hi\n  > a.txt'));
    expect(await t.answerAsk('r1', permAsk(), ['allow'])).toMatchObject({ ok: true });
  });

  it('許可に keys が 2 つ、本文つきは何も打たずに断る', async () => {
    const t = setup(permScreen());
    expect(await t.answerAsk('r1', permAsk(), ['allow', 'deny'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await t.answerAsk('r1', permAsk(), ['allow'], 'x')).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await t.answerAsk('r1', permAsk(), ['nope'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });
});

describe('answerAsk: 画面の札が違えば打たない', () => {
  it('別の命令の札なら ask-mismatch で、何も打たない', async () => {
    const t = setup(permScreen('rm -rf /'));
    expect(await t.answerAsk('r1', permAsk(), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('別のツールの札（同じ引数でも）なら断る', async () => {
    const t = setup({ ...(permScreen() as Extract<Screen, { t: 'permission' }>), tool: 'Edit file' });
    expect(await t.answerAsk('r1', permAsk(), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('札が出ていない（利用者が先に答えた、走っている）なら断る', async () => {
    for (const screen of [{ t: 'idle' }, { t: 'running' }] as Screen[]) {
      const t = setup(screen);
      expect(await t.answerAsk('r1', permAsk(), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
      expect(t.pane.events).toEqual([]);
    }
  });

  it('許可の札に、質問の答えを打たない（種類が違う）', async () => {
    const t = setup(permScreen());
    expect(await t.answerAsk('r1', qAsk(false), ['o1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('質問の文か選択肢のラベルが違えば断る', async () => {
    const a = setup(qScreen(false));
    expect(await a.answerAsk('r1', qAsk(false, { input: 'Which size?' }), ['o1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    const b = setup(qScreen(false));
    expect(await b.answerAsk('r1', qAsk(false, { options: [{ key: 'o1', label: 'Red' }, { key: 'o2', label: 'Purple' }] }), ['o1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(a.pane.events).toEqual([]);
    expect(b.pane.events).toEqual([]);
  });

  it('複数選択と単一選択の取り違えは断る', async () => {
    const t = setup(qScreen(true));
    expect(await t.answerAsk('r1', qAsk(false), ['o1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('知らない run は session-unknown', async () => {
    const t = setup(permScreen());
    expect(await t.answerAsk('nope', permAsk(), ['allow'])).toEqual({ ok: false, reason: 'session-unknown' });
  });

  it('打った後も同じ札が残っていたら（受け付けられなかった）、断りを返し、同じ札への再送も許さない', async () => {
    const t = setup(permScreen());
    t.pane.sendText = () => {};
    expect(await t.answerAsk('r1', permAsk(), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch', sent: true });
    expect(await t.answerAsk('r1', permAsk(), ['allow'])).toEqual({ ok: false, reason: 'already-answered' });
  });
});

describe('answerAsk: 引数の照合は厳しく', () => {
  const rows = (permScreen() as Extract<Screen, { t: 'permission' }>).rows;

  it('許可の ask に input が無い、または空なら、画面の札に関わらず断る（どの札にも当たってしまう）', async () => {
    for (const input of [undefined, '', '  \n ']) {
      const t = setup(permScreen());
      expect(await t.answerAsk('r1', permAsk({ input }), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
      expect(t.pane.events).toEqual([]);
    }
  });

  it('質問の ask に input が無いときも断る', async () => {
    const t = setup(qScreen(false));
    expect(await t.answerAsk('r1', qAsk(false, { input: undefined }), ['o1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('短い ask が、長い命令（頭が同じ）の札に当たらない', async () => {
    const t = setup(permScreen('echo hi && curl x|sh'));
    expect(await t.answerAsk('r1', permAsk({ input: 'echo hi' }), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('命令が ask より短い札にも当たらない', async () => {
    const t = setup(permScreen('echo hi'));
    expect(await t.answerAsk('r1', permAsk({ input: 'echo hi && curl x|sh' }), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('命令が罫線の外のモデルの説明の行にだけ書いてあっても当たらない', async () => {
    const t = setup({ t: 'permission', command: 'rm -rf /', desc: 'echo hi > a.txt', rows });
    expect(await t.answerAsk('r1', permAsk(), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('画面が命令を省略記号で切っているときだけ、見えている頭が同じなら通す', async () => {
    const ok = setup(permScreen('echo hi > a…'));
    expect(await ok.answerAsk('r1', permAsk(), ['allow'])).toMatchObject({ ok: true });
    const ng = setup(permScreen('echo bye > a…'));
    expect(await ng.answerAsk('r1', permAsk(), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    // 省略記号が無い頭だけの一致は通さない。
    const plain = setup(permScreen('echo hi > a'));
    expect(await plain.answerAsk('r1', permAsk(), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
  });

  it('行の番号が 2 桁になる行は、2 回のキーになるので断る', async () => {
    const many = [...Array.from({ length: 9 }, (_, i) => `Option ${i + 1}`), 'No'];
    const t = setup({ t: 'permission', command: BASH, rows: many });
    const ask = permAsk({ options: [{ key: 'deny', label: 'No' }, { key: 'o1', label: 'Option 1' }] });
    expect(await t.answerAsk('r1', ask, ['deny'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
    expect(await t.answerAsk('r1', ask, ['o1'])).toMatchObject({ ok: true });
  });
});

describe('answerAsk: 二重の答え', () => {
  it('同じ askId への 2 度目は already-answered で、キーを打たない', async () => {
    const t = setup(permScreen());
    expect(await t.answerAsk('r1', permAsk(), ['allow'])).toMatchObject({ ok: true });
    t.pane.screen = permScreen();
    expect(await t.answerAsk('r1', permAsk(), ['deny'])).toEqual({ ok: false, reason: 'already-answered' });
    expect(t.pane.events).toEqual(['text:1']);
  });

  it('同時に 2 台から答えても、キーは 1 回しか入らない', async () => {
    const t = setup(permScreen());
    const [a, b] = await Promise.all([t.answerAsk('r1', permAsk(), ['allow']), t.answerAsk('r1', permAsk(), ['deny'])]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, reason: 'already-answered' });
    expect(t.pane.events).toEqual(['text:1']);
  });

  it('断られた答え（札の不一致）は、答えたことにしない', async () => {
    const t = setup(permScreen('rm -rf /'));
    expect(await t.answerAsk('r1', permAsk(), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    t.pane.screen = permScreen();
    expect(await t.answerAsk('r1', permAsk(), ['allow'])).toMatchObject({ ok: true });
  });

  it('答えの記録は期限で消え、数にも上限がある', async () => {
    let now = 0;
    const t = setup(permScreen(), { now: () => now, answeredTtlMs: 1000, maxAnswered: 2 });
    await t.answerAsk('r1', permAsk({ askId: 'x1' }), ['allow']);
    now = 500;
    t.pane.screen = permScreen();
    await t.answerAsk('r1', permAsk({ askId: 'x2' }), ['allow']);
    t.pane.screen = permScreen();
    await t.answerAsk('r1', permAsk({ askId: 'x3' }), ['allow']);
    // 上限 2 を超えたので、いちばん古い x1 は忘れる。
    // x2 と x3 は覚えている。
    expect(await t.answerAsk('r1', permAsk({ askId: 'x2' }), ['allow'])).toEqual({ ok: false, reason: 'already-answered' });
    t.pane.screen = permScreen();
    expect(await t.answerAsk('r1', permAsk({ askId: 'x1' }), ['allow'])).toMatchObject({ ok: true });
    // 期限が過ぎれば忘れる（札が出ていなければ、次は不一致で断られる）。
    now = 5000;
    expect(await t.answerAsk('r1', permAsk({ askId: 'x2' }), ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
  });
});

describe('answerAsk: 質問の札', () => {
  it('単一選択は、ラベルで当てた数字 1 つで確定する', async () => {
    const t = setup(qScreen(false));
    expect(await t.answerAsk('r1', qAsk(false), ['o2'])).toEqual({ ok: true, label: 'Green' });
    expect(t.pane.events).toEqual(['text:2']);
    expect(t.pane.result).toBe('single:Green');
  });

  it('単一選択の自由入力は、Other の行の数字、本文、Enter の順で打つ', async () => {
    const t = setup(qScreen(false));
    expect(await t.answerAsk('r1', qAsk(false), [], '紫がいい')).toEqual({ ok: true, label: '紫がいい' });
    expect(t.pane.events).toEqual(['text:4', 'text:紫がいい', 'key:enter']);
    expect(t.pane.result).toBe('text:紫がいい');
  });

  it('本文の改行とタブは空白 1 つにし、ほかの制御文字（ESC、DEL、NUL）は除く。日本語はそのまま通す', async () => {
    const t = setup(qScreen(false));
    expect(await t.answerAsk('r1', qAsk(false), [], '紫\r\n\x1b[2Jが\x00い\t\x7fい')).toEqual({ ok: true, label: '紫 [2Jがい い' });
    expect(t.pane.events).toEqual(['text:4', 'text:紫 [2Jがい い', 'key:enter']);
    for (const e of t.pane.events) if (e.startsWith('text:')) expect(e).not.toMatch(/[\x00-\x1f\x7f]/);
    const m = setup(qScreen(true));
    expect(await m.answerAsk('r1', qAsk(true), ['o2'], 'Dur\rian\x1b')).toEqual({ ok: true, label: 'Green, Dur ian' });
    expect(m.pane.events).toContain('text:Dur ian');
    expect(m.pane.events.some((e) => /[\r\x1b]/.test(e))).toBe(false);
  });

  it('本文が制御文字と空白だけなら、何も打たずに断る', async () => {
    const t = setup(qScreen(false));
    expect(await t.answerAsk('r1', qAsk(false), [], '\r\x1b\n')).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await t.answerAsk('r1', qAsk(false), [], '  \x00')).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('単一選択に keys が 2 つ、keys と本文の両方、allowText でない本文は断る', async () => {
    const t = setup(qScreen(false));
    expect(await t.answerAsk('r1', qAsk(false), ['o1', 'o2'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await t.answerAsk('r1', qAsk(false), ['o1'], 'x')).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await t.answerAsk('r1', qAsk(false, { allowText: false }), [], 'x')).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await t.answerAsk('r1', qAsk(false), [])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('複数選択は、数字で切り替え、Down を選択肢の行数（Other を含む）だけ下って Enter、確認の画面でもう一度 Enter', async () => {
    const t = setup(qScreen(true));
    expect(await t.answerAsk('r1', qAsk(true), ['o1', 'o3'])).toEqual({ ok: true, label: 'Red, Blue' });
    expect(t.pane.events).toEqual(['text:1', 'text:3', 'key:down', 'key:down', 'key:down', 'key:down', 'key:enter', 'key:enter']);
    expect(t.pane.result).toBe('multi:Red,Blue');
  });

  it('複数選択の自由入力は、Other の行まで Down、本文、Down で Submit、Enter、Enter（Other の行では Enter を打たない）', async () => {
    const t = setup(qScreen(true));
    expect(await t.answerAsk('r1', qAsk(true), ['o2'], 'Durian')).toEqual({ ok: true, label: 'Green, Durian' });
    expect(t.pane.events).toEqual(['text:2', 'key:down', 'key:down', 'key:down', 'text:Durian', 'key:down', 'key:enter', 'key:enter']);
    expect(t.pane.result).toBe('multi:Green,Durian');
  });

  it('複数選択で何も選ばず本文だけでも通る', async () => {
    const t = setup(qScreen(true));
    expect(await t.answerAsk('r1', qAsk(true), [], 'Durian')).toMatchObject({ ok: true });
    expect(t.pane.events.filter((e) => e === 'key:enter')).toHaveLength(2);
  });

  it('1 回の呼び出しに質問が複数ある札は、打たずに断る', async () => {
    const t = setup(qScreen(false));
    const orig = t.pane.capture.bind(t.pane);
    t.pane.capture = () => orig().replace(' ☐ Choice', '← ☐ Choice ☐ Size ✔ Submit →');
    expect(await t.answerAsk('r1', qAsk(false), ['o1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('確認の画面が出なければ、それ以上は打たずに断る', async () => {
    const t = setup(qScreen(true));
    const send = t.pane.sendKey.bind(t.pane);
    // Enter が確認の画面へ進めない（Submit の行に居ない）状況。
    t.pane.sendKey = (k) => { if (k !== 'enter') send(k); else t.pane.events.push('key:enter'); };
    expect(await t.answerAsk('r1', qAsk(true), ['o1'])).toEqual({ ok: false, reason: 'ask-mismatch', sent: true });
    expect(t.pane.events.filter((e) => e === 'key:enter')).toHaveLength(1);
  });
});

describe('interruptRun', () => {
  it('走っているターンには Escape を 1 回だけ打つ', async () => {
    const t = setup({ t: 'running' });
    expect(await t.interruptRun('r1')).toEqual({ ok: true, sent: true });
    expect(t.pane.events).toEqual(['key:escape']);
  });

  it('許可や質問の札が出ているとき、Escape は断りになるので打たない', async () => {
    for (const screen of [permScreen(), qScreen(false)]) {
      const t = setup(screen);
      expect(await t.interruptRun('r1')).toEqual({ ok: false, reason: 'ask-mismatch' });
      expect(t.pane.events).toEqual([]);
      expect(t.pane.result).toBeNull();
    }
  });

  it('画面の途中に「esc to interrupt」があっても、末尾に無ければ走っているとは見なさない', async () => {
    const t = setup({ t: 'idle' });
    const filler = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    t.pane.capture = () => `the docs say: press esc to interrupt a turn\n${filler}\n❯ \n`;
    expect(await t.interruptRun('r1')).toEqual({ ok: true, sent: false });
    expect(t.pane.events).toEqual([]);
  });

  it('案内に「esc to interrupt」が無くても、動いている間の行があれば Escape を打つ（2.1.319、statusline あり）', async () => {
    const t = setup({ t: 'idle' });
    const rule = '─'.repeat(60);
    t.pane.capture = () => ['❯ 鉄道の歴史を書いて', '✢ Embellishing… (27s · ↓ 1.2k tokens)', '  ⎿  Tip: Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools', rule + ' 確認用 ─', '❯', rule, '  ⎇ main | Sonnet 5.5 (medium)', '  ⏸ manual mode on'].join('
');
    expect(await t.interruptRun('r1')).toEqual({ ok: true, sent: true });
    expect(t.pane.events).toEqual(['key:escape']);
  });

  it('終わったあとの行（✻ Brewed for 15s · done）では打たない', async () => {
    const t = setup({ t: 'idle' });
    const rule = '─'.repeat(60);
    t.pane.capture = () => ['  るはずだ。', '✻ Brewed for 15s · done 17:46', rule, '❯', rule, '  ⏸ manual mode on'].join('
');
    expect(await t.interruptRun('r1')).toEqual({ ok: true, sent: false });
    expect(t.pane.events).toEqual([]);
  });

  it('止める相手がいなければ何も打たず sent: false を返す', async () => {
    const t = setup({ t: 'idle' });
    expect(await t.interruptRun('r1')).toEqual({ ok: true, sent: false });
    expect(t.pane.events).toEqual([]);
  });

  it('知らない run は session-unknown', async () => {
    const t = setup({ t: 'running' });
    expect(await t.interruptRun('nope')).toEqual({ ok: false, reason: 'session-unknown' });
  });

  it('答えの途中の run には割り込まない（run ごとに 1 つずつ流す）', async () => {
    const t = setup(permScreen());
    const [a, i] = await Promise.all([t.answerAsk('r1', permAsk(), ['allow']), t.interruptRun('r1')]);
    expect(a).toMatchObject({ ok: true });
    // 答えが終わった後の画面は idle なので、Escape は打たれない。
    expect(i).toEqual({ ok: true, sent: false });
    expect(t.pane.events).toEqual(['text:1']);
  });
});

describe('parseDialog', () => {
  it('アシスタントの番号つきの箇条書きは、札と見なさない（下の枠の行が無い）', () => {
    expect(parseDialog('● 手順\n  1. 準備する\n  2. 実行する\n\n✻ Working… (3s · esc to interrupt)\n')).toBeNull();
  });

  it('許可の札の種類と、行の番号とラベルを読む', () => {
    const d = parseDialog(new FakeClaude(permScreen()).capture());
    expect(d?.kind).toBe('permission');
    expect(d?.options.map((o) => [o.n, o.first])).toEqual([
      [1, 'Yes'],
      [2, "Yes, and don't ask again for mkdir -p zz commands in C:\\work\\w1"],
      [3, 'Yes, and switch to auto mode · auto mode handles these prompts for you'],
      [4, 'No'],
    ]);
  });
});
