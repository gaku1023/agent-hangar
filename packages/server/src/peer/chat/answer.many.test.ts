import type { PeerChatAsk } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import type { PaneKey } from '../../tmux/pane.ts';
import { createPeerAnswerer, dialogMatches, parseDialog, type AnswerPane } from './answer.ts';
import { MANY_Q1, MANY_Q2, MANY_SUBMIT, MANY_TAB1, MANY_TAB2, SHORT_QUESTION_MAC } from './questionDialogs.fixtures.ts';

/**
 * 1 回の呼び出しに問いが複数ある札（AskUserQuestion の questions が 2 つ以上）。
 * 札は 1 問ずつ答える。
 * 今のタブの問いだけを照合し、答えたら次のタブが新しい札になる。
 * 最後の問いに答えて確認のタブ（Submit）が出たら、続けて送る。
 * 未回答の問いが残る確認のタブは押さず、1 つの札として答えさせる。
 */

describe('parseDialog: 問いが複数ある札', () => {
  it('1 タブ目は 1/2 で、本文と選択肢はそのタブのもの', () => {
    const d = parseDialog(MANY_TAB1)!;
    expect(d.kind).toBe('question');
    expect(d.manyQuestions).toBe(true);
    expect(d.step).toEqual({ index: 1, total: 2, submit: false });
    expect(d.question).toBe(MANY_Q1);
    expect(d.options.map((o) => o.first)).toEqual(['使う', '使わない', 'Type something.', 'Chat about this']);
  });

  it('2 タブ目は 2/2 で、本文と選択肢はそのタブのもの', () => {
    const d = parseDialog(MANY_TAB2)!;
    expect(d.step).toEqual({ index: 2, total: 2, submit: false });
    expect(d.question).toBe(MANY_Q2);
    expect(d.options.map((o) => o.first)).toEqual(['今夜まとめて', '少しずつ', 'Type something.', 'Chat about this']);
  });

  it('最後の確認のタブは submit で、行は Submit answers と Cancel', () => {
    const d = parseDialog(MANY_SUBMIT)!;
    expect(d.kind).toBe('question');
    expect(d.step).toEqual({ index: null, total: 2, submit: true });
    expect(d.question).toBe('Ready to submit your answers?');
    expect(d.options.map((o) => o.first)).toEqual(['Submit answers', 'Cancel']);
  });

  it('問いが 1 つの札は step を持たない', () => {
    const d = parseDialog(SHORT_QUESTION_MAC)!;
    expect(d.manyQuestions).toBe(false);
    expect(d.step).toBeNull();
  });
});

const ask = (input: string, labels: string[], over: Partial<PeerChatAsk> = {}): PeerChatAsk => ({
  askId: 'm1', kind: 'question', tool: 'AskUserQuestion', input,
  options: labels.map((label, i) => ({ key: String(i + 1), label })), multi: false, allowText: true, ...over,
});
const ASK1 = ask(MANY_Q1, ['使う', '使わない']);
const ASK2 = ask(MANY_Q2, ['今夜まとめて', '少しずつ'], { askId: 'm2' });
const ASK_SUBMIT = ask('Ready to submit your answers?', ['Submit answers', 'Cancel'], { askId: 'm3', allowText: false });

describe('dialogMatches: 問いが複数ある札', () => {
  it('今のタブの問いの ask だけが合う', () => {
    expect(dialogMatches(ASK1, parseDialog(MANY_TAB1)!)).toBe(true);
    expect(dialogMatches(ASK2, parseDialog(MANY_TAB1)!)).toBe(false);
    expect(dialogMatches(ASK2, parseDialog(MANY_TAB2)!)).toBe(true);
    expect(dialogMatches(ASK1, parseDialog(MANY_TAB2)!)).toBe(false);
    expect(dialogMatches(ASK_SUBMIT, parseDialog(MANY_SUBMIT)!)).toBe(true);
  });

  it('問いが複数ある札の複数選択のタブは、合わない（答えない）', () => {
    const screen = MANY_TAB1.replace('1. 使う', '1. [ ] 使う').replace('2. 使わない', '2. [ ] 使わない');
    expect(dialogMatches({ ...ASK1, multi: true }, parseDialog(screen)!)).toBe(false);
  });
});

/**
 * 問いが 2 つの札の偽の Claude Code。
 * 数字はそのタブの行を選んで次のタブへ進む。Type something の数字は文字の入力に入り、Enter で次のタブへ進む。
 * 確認のタブの 1 は送って札を閉じる。
 */
class FakeMany implements AnswerPane {
  events: string[] = [];
  tab: 1 | 2 | 3 | 0 = 1;
  answers: string[] = [];
  private typing = false;
  private typed = '';

  capture(): string {
    if (this.tab === 0) return '● done\n\n❯ \n';
    return this.tab === 1 ? MANY_TAB1 : this.tab === 2 ? MANY_TAB2 : MANY_SUBMIT;
  }

  sendText(text: string): void {
    this.events.push(`text:${text}`);
    if (this.typing) { this.typed += text; return; }
    if (!/^\d$/.test(text)) return;
    const n = Number(text);
    if (this.tab === 3) { if (n === 1) this.tab = 0; return; }
    const labels = this.tab === 1 ? ['使う', '使わない'] : ['今夜まとめて', '少しずつ'];
    if (n === 3) { this.typing = true; return; }
    if (n <= 2) { this.answers.push(labels[n - 1]!); this.next(); }
  }

  sendKey(key: PaneKey): void {
    this.events.push(`key:${key}`);
    if (key === 'enter' && this.typing) { this.answers.push(this.typed); this.typing = false; this.typed = ''; this.next(); }
  }

  private next(): void { this.tab = this.tab === 1 ? 2 : 3; }
}

const noSleep = async (): Promise<void> => {};
const rig = () => {
  const pane = new FakeMany();
  return { pane, ...createPeerAnswerer({ pane: () => pane, sleep: noSleep }) };
};

describe('answerAsk: 問いが複数ある札に 1 問ずつ答える', () => {
  it('1 問目に番号で答えると、数字 1 つを打ち、次のタブへ進んで答えたことになる', async () => {
    const t = rig();
    expect(await t.answerAsk('r1', ASK1, ['2'])).toEqual({ ok: true, label: '使わない' });
    expect(t.pane.events).toEqual(['text:2']);
    expect(t.pane.tab).toBe(2);
  });

  it('自由文は Type something の番号、本文、Enter で、次のタブへ進む', async () => {
    const t = rig();
    expect(await t.answerAsk('r1', ASK1, [], '声は後で決める')).toEqual({ ok: true, label: '声は後で決める' });
    expect(t.pane.events).toEqual(['text:3', 'text:声は後で決める', 'key:enter']);
    expect(t.pane.answers).toEqual(['声は後で決める']);
    expect(t.pane.tab).toBe(2);
  });

  it('1 問目の ask で、もう 2 タブ目に進んだ画面には打たない', async () => {
    const t = rig();
    t.pane.tab = 2;
    expect(await t.answerAsk('r1', ASK1, ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.pane.events).toEqual([]);
  });

  it('最後の問いに答えると、確認のタブの Submit answers を続けて押す', async () => {
    const t = rig();
    t.pane.tab = 2;
    expect(await t.answerAsk('r1', ASK2, ['1'])).toEqual({ ok: true, label: '今夜まとめて' });
    expect(t.pane.events).toEqual(['text:1', 'text:1']);
    expect(t.pane.tab).toBe(0);
  });

  it('確認のタブが札として残っていれば、それにも答えられる', async () => {
    const t = rig();
    t.pane.tab = 3;
    expect(await t.answerAsk('r1', ASK_SUBMIT, ['1'])).toEqual({ ok: true, label: 'Submit answers' });
    expect(t.pane.tab).toBe(0);
  });
});
