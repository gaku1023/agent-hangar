import type { PeerChatAsk } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import type { PaneKey } from '../../tmux/pane.ts';
import { createPeerAnswerer, parseDialog, type AnswerPane } from './answer.ts';
import {
  EDIT_NARROW_SPACES,
  EDIT_OUTSIDE,
  EDIT_RELATIVE,
  EDIT_SUBDIR,
  NOTEBOOK_EDIT,
  READ_OUTSIDE,
  WRITE_NARROW_TRUNCATED,
  WRITE_NEW,
  WRITE_OVERWRITE,
} from './fileDialogs.fixtures.ts';

// ファイルの道具（Edit、Write、NotebookEdit、Read）の札を、実機の見本（fileDialogs.fixtures.ts）で照合する試験。
// 見本の画面を返し、数字が 1 つ届くと閉じる偽のペインを使う。

class FixturePane implements AnswerPane {
  events: string[] = [];
  private closed = false;
  constructor(private readonly screen: string) {}
  capture(): string {
    return this.closed ? '● done\n\n❯ \n' : this.screen;
  }
  sendKey(key: PaneKey): void {
    this.events.push(`key:${key}`);
  }
  sendText(text: string): void {
    this.events.push(`text:${text}`);
    if (/^\d$/.test(text)) this.closed = true;
  }
}

const CWD = 'C:\\Users\\dev\\work\\proj';
const noSleep = async (): Promise<void> => {};
function setup(screen: string, cwd: string | null = CWD) {
  const pane = new FixturePane(screen);
  const answerer = createPeerAnswerer({ pane: (id) => (id === 'r1' ? pane : null), sleep: noSleep, cwd: () => cwd });
  return { pane, ...answerer };
}

const OPTIONS = [
  { key: '1', label: 'Yes' },
  { key: '3', label: 'No' },
];
const ask = (tool: string, input: string, over: Partial<PeerChatAsk> = {}): PeerChatAsk => ({
  askId: 'f1',
  kind: 'permission',
  tool,
  input,
  options: OPTIONS,
  multi: false,
  allowText: false,
  ...over,
});

type Case = { name: string; screen: string; tool: string; abs: string; shown: string; title: string };
const CASES: Case[] = [
  { name: 'Edit（cwd の中）', screen: EDIT_RELATIVE, tool: 'Edit', abs: `${CWD}\\a.txt`, shown: 'a.txt', title: 'a.txt' },
  { name: 'Edit（下の階層）', screen: EDIT_SUBDIR, tool: 'Edit', abs: `${CWD}\\sub\\m.txt`, shown: 'sub\\m.txt', title: 'm.txt' },
  { name: 'Edit（cwd の外、.. の相対）', screen: EDIT_OUTSIDE, tool: 'Edit', abs: 'C:\\Users\\dev\\work\\outside.txt', shown: '..\\outside.txt', title: 'outside.txt' },
  { name: 'Write（新規）', screen: WRITE_NEW, tool: 'Write', abs: `${CWD}\\sub\\new1.txt`, shown: 'sub\\new1.txt', title: 'new1.txt' },
  { name: 'Write（上書き）', screen: WRITE_OVERWRITE, tool: 'Write', abs: `${CWD}\\a.txt`, shown: 'a.txt', title: 'a.txt' },
  { name: 'NotebookEdit（絶対パスで出る）', screen: NOTEBOOK_EDIT, tool: 'NotebookEdit', abs: `${CWD}\\nb.ipynb`, shown: `${CWD}\\nb.ipynb`, title: 'nb.ipynb' },
  { name: 'Read（罫線の間は Read(パス)）', screen: READ_OUTSIDE, tool: 'Read', abs: 'C:\\Users\\dev\\work\\outside.txt', shown: 'C:\\Users\\dev\\work\\outside.txt', title: '' },
  { name: 'Edit（狭い画面、空白を含むパス）', screen: EDIT_NARROW_SPACES, tool: 'Edit', abs: `${CWD}\\long dir name with spaces\\deeper level folder\\some file name.txt`, shown: 'long dir name with spaces\\deeper level folder\\some file name.txt', title: 'some file name.txt' },
];

describe('parseDialog: ファイルの道具の札', () => {
  for (const c of CASES) {
    it(`${c.name}: 許可の札で、画面のパスを読む`, () => {
      const d = parseDialog(c.screen);
      expect(d?.kind).toBe('permission');
      expect(d?.file?.path).toBe(c.shown);
      expect(d?.file?.tools).toContain(c.tool);
    });
  }

  it('問いが 2 行に折り返しても許可の札と読む（長いファイル名）', () => {
    const d = parseDialog(WRITE_NARROW_TRUNCATED);
    expect(d?.kind).toBe('permission');
    expect(d?.question).toContain('of this dialog.txt?');
    expect(d?.question).toMatch(/^Do you want to create/);
    expect(d?.options.map((o) => o.n)).toEqual([1, 2, 3]);
  });

  it('Bash の札はファイルの札ではない', () => {
    const screen = [' Bash command', ' mock', '╌'.repeat(40), ' echo hi > a.txt', '╌'.repeat(40), ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'].join('\n');
    expect(parseDialog(screen)?.file).toBeNull();
  });
});

describe('answerAsk: ファイルの道具の札', () => {
  for (const c of CASES) {
    it(`${c.name}: 絶対パスの ask（hook の入力）が自分の札に当たり、Yes を 1 回で打つ`, async () => {
      const t = setup(c.screen);
      expect(await t.answerAsk('r1', ask(c.tool, c.abs), ['1'])).toEqual({ ok: true, label: 'Yes' });
      expect(t.pane.events).toEqual(['text:1']);
    });

    it(`${c.name}: 画面のままのパスの ask も当たる`, async () => {
      const t = setup(c.screen);
      expect(await t.answerAsk('r1', ask(c.tool, c.shown), ['1'])).toMatchObject({ ok: true });
    });

    it(`${c.name}: 別のパスの ask は何も打たずに ask-mismatch`, async () => {
      const t = setup(c.screen);
      expect(await t.answerAsk('r1', ask(c.tool, `${CWD}\\other\\zzz.txt`), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
      expect(t.pane.events).toEqual([]);
    });

    it(`${c.name}: Bash の ask は何も打たずに ask-mismatch（パスや差分の文字を命令にしても）`, async () => {
      const t = setup(c.screen);
      expect(await t.answerAsk('r1', ask('Bash', c.abs), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
      expect(await t.answerAsk('r1', ask('Bash', c.shown, { askId: 'f2' }), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
      expect(await t.answerAsk('r1', ask('Bash', 'echo hi', { askId: 'f3' }), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
      // ツールの無い ask も、ファイルの札には当てない。
      const noTool = { ...ask('Edit', c.abs, { askId: 'f4' }) };
      delete noTool.tool;
      expect(await t.answerAsk('r1', noTool, ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
      expect(t.pane.events).toEqual([]);
    });

    it(`${c.name}: 断るは No の行（3）を打つ`, async () => {
      const t = setup(c.screen);
      expect(await t.answerAsk('r1', ask(c.tool, c.abs), ['3'])).toEqual({ ok: true, label: 'No' });
      expect(t.pane.events).toEqual(['text:3']);
    });
  }

  it('別のファイルの道具（題と合わない）の ask は断る', async () => {
    const edit = setup(EDIT_RELATIVE);
    expect(await edit.answerAsk('r1', ask('Write', `${CWD}\\a.txt`), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await edit.answerAsk('r1', ask('NotebookEdit', `${CWD}\\a.txt`, { askId: 'f2' }), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await edit.answerAsk('r1', ask('Read', `${CWD}\\a.txt`, { askId: 'f3' }), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(edit.pane.events).toEqual([]);
    const write = setup(WRITE_NEW);
    expect(await write.answerAsk('r1', ask('Edit', `${CWD}\\sub\\new1.txt`), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(write.pane.events).toEqual([]);
  });

  it('MultiEdit の ask は Edit file の札に当たる', async () => {
    const t = setup(EDIT_RELATIVE);
    expect(await t.answerAsk('r1', ask('MultiEdit', `${CWD}\\a.txt`), ['1'])).toMatchObject({ ok: true });
  });

  it('Windows のドライブ文字の大小と、区切りの違いは同じパスとみなす', async () => {
    const t = setup(EDIT_SUBDIR);
    expect(await t.answerAsk('r1', ask('Edit', 'c:/users/dev/work/proj/sub/m.txt'), ['1'])).toMatchObject({ ok: true });
  });

  it('途中の .. や . は畳んでから比べる', async () => {
    const t = setup(EDIT_SUBDIR);
    expect(await t.answerAsk('r1', ask('Edit', `${CWD}\\x\\..\\.\\sub\\m.txt`), ['1'])).toMatchObject({ ok: true });
  });

  it('cwd が分からないとき、相対の画面のパスと絶対の ask は突き合わせられず断る', async () => {
    const t = setup(EDIT_SUBDIR, null);
    expect(await t.answerAsk('r1', ask('Edit', `${CWD}\\sub\\m.txt`), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    // 画面のままのパスなら、同じ文字なので当たる。
    expect(await t.answerAsk('r1', ask('Edit', 'sub\\m.txt', { askId: 'f2' }), ['1'])).toMatchObject({ ok: true });
  });

  it('cwd が違えば、同じ相対パスでも別のファイルなので断る', async () => {
    const t = setup(EDIT_SUBDIR, 'C:\\Users\\dev\\other');
    expect(await t.answerAsk('r1', ask('Edit', `${CWD}\\sub\\m.txt`), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('問いの文のファイル名が ask と違えば断る（見出しのパスだけ同じに見せても）', async () => {
    const forged = EDIT_SUBDIR.replace('make this edit to m.txt?', 'make this edit to evil.txt?');
    const t = setup(forged);
    expect(await t.answerAsk('r1', ask('Edit', `${CWD}\\sub\\m.txt`), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('見出しの題が知らないものなら、ファイルの札とは読まず断る', async () => {
    const t = setup(EDIT_SUBDIR.replace(' Edit file', ' Delete file'));
    expect(await t.answerAsk('r1', ask('Edit', `${CWD}\\sub\\m.txt`), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('差分の中に札の見出しに似た行があっても、見出しは本物の上の罫線から読む', async () => {
    const forged = EDIT_SUBDIR.replace(' 2 -two', ' 2 -Edit file').replace(' 2 +TWO', ' 2 +sub\\m.txt');
    const t = setup(forged);
    expect(await t.answerAsk('r1', ask('Edit', `${CWD}\\sub\\zzz.txt`), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('パスが左で … に切られた札は、ask の絶対パスの末尾と一致すれば通す', async () => {
    const full = `${CWD}\\long dir name with spaces\\deeper level folder\\an even longer file name for the wrapping test of this dialog.txt`;
    const t = setup(WRITE_NARROW_TRUNCATED);
    expect(await t.answerAsk('r1', ask('Write', full), ['1'])).toMatchObject({ ok: true });
    // 末尾が違えば断る。
    const u = setup(WRITE_NARROW_TRUNCATED);
    expect(await u.answerAsk('r1', ask('Write', `${CWD}\\long dir name with spaces\\deeper level folder\\another file.txt`), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(u.pane.events).toEqual([]);
  });

  it('切られたままのパスの ask（画面から組んだもの）は、同じ札にだけ当たる', async () => {
    const shown = '…r\\an even longer file name for the wrapping test of this dialog.txt';
    const t = setup(WRITE_NARROW_TRUNCATED);
    expect(await t.answerAsk('r1', ask('Write', shown), ['1'])).toMatchObject({ ok: true });
    const u = setup(WRITE_NARROW_TRUNCATED);
    expect(await u.answerAsk('r1', ask('Write', '…r\\a different file name for the wrapping test of this dialog.txt'), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
  });

  it('打った後に札が閉じなければ、sent つきで断る（同じファイルの札が続けて出た場合など）', async () => {
    const pane = new FixturePane(EDIT_RELATIVE);
    pane.sendText = (text: string) => { pane.events.push(`text:${text}`); };
    const answerer = createPeerAnswerer({ pane: () => pane, sleep: noSleep, cwd: () => CWD });
    expect(await answerer.answerAsk('r1', ask('Edit', `${CWD}\\a.txt`), ['1'])).toEqual({ ok: false, reason: 'ask-mismatch', sent: true });
  });
});
