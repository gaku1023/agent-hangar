import type { PeerChatAsk } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import type { PaneKey } from '../../tmux/pane.ts';
import { createPeerAnswerer, dialogMatches, parseDialog, type AnswerPane } from './answer.ts';
import { REAL_MANY_MULTI_TAB1, REAL_MANY_MULTI_TAB2_LAST, REAL_MANY_SUBMIT_2332 } from './questionDialogs.real.fixtures.ts';

/**
 * 問いが複数あり、タブの中が複数選択の札。
 * 2.1.332 の実機（Mac の tmux と Windows の psmux、2026-11-25）で確かめた動き：
 * - 数字のキーは、その行の箱を付け外しする。カーソル（❯）は動かない。
 * - 自由入力の行（Type something）は、カーソルをその行に置いて文字を打つと、箱が付いて文字が入る。
 * - 自由入力の行の下に、番号の無い行（最後の問いでないタブは Next、最後の問いのタブは Submit）がある。
 *   Down でそこへ行き Enter を押すと、次のタブ（Submit の行なら確認のタブ）へ進む。
 * - 箱を 1 つでも付けると、そのタブの頭の印は ☒ になる（まだ進んでいなくても）。
 */

const rows = (labels: string[], checked: boolean[], cursor: number, other: string, next: string): string[] => {
  const out: string[] = [];
  labels.forEach((l, i) => {
    out.push(`${cursor === i + 1 ? '❯' : ' '} ${i + 1}. [${checked[i] ? '✔' : ' '}] ${l}`);
    out.push(`         ${l}`);
  });
  const o = labels.length + 1;
  out.push(`${cursor === o ? '❯' : ' '} ${o}. [${checked[labels.length] ? '✔' : ' '}] ${other || 'Type something'}`);
  out.push(`${cursor === o + 1 ? '❯' : ' '}    ${next}`);
  return out;
};

const RULE = '─'.repeat(120);

/** 実機の動きを写した偽の Claude Code。1 タブ目は果物（複数選択）、2 タブ目は色（複数選択）。 */
class FakeManyMulti implements AnswerPane {
  events: string[] = [];
  tab: 1 | 2 | 3 | 0 = 1;
  cursor = 1;
  checked: boolean[][] = [[false, false, false, false], [false, false, false]];
  typed: string[] = ['', ''];
  answers: string[][] = [];
  labels = [['りんご', 'みかん', 'ぶどう'], ['赤', '青']];
  questions = ['果物はどれ？', '色はどれ？'];

  capture(): string {
    if (this.tab === 0) return '● done\n\n❯ \n';
    const chip = (i: number): string => (this.checked[i]!.some(Boolean) || this.tab > i + 1 ? '☒' : '☐');
    const head = `←  ${chip(0)} 果物  ${chip(1)} 色  ✔ Submit  →`;
    if (this.tab === 3) {
      return [RULE, head, '', 'Review your answers', '', ' ● 果物はどれ？', `   → ${this.answers[0]!.join(', ')}`, ' ● 色はどれ？', `   → ${this.answers[1]!.join(', ')}`, '', '❯ 1. Submit answers', '  2. Cancel', ''].join('\n');
    }
    const t = this.tab - 1;
    const labels = this.labels[t]!;
    const body = rows(labels, this.checked[t]!, this.cursor, this.typed[t]!, this.tab === 1 ? 'Next' : 'Submit');
    return [RULE, head, this.questions[t]!, ...body, RULE, `  ${labels.length + 2}. Chat about this`, 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel', ''].join('\n');
  }

  sendText(text: string): void {
    this.events.push(`text:${text}`);
    if (this.tab === 3) { if (text === '1') this.tab = 0; return; }
    const t = this.tab - 1;
    const other = this.labels[t]!.length + 1;
    if (this.cursor === other && !/^\d$/.test(text)) { this.typed[t] += text; this.checked[t]![other - 1] = true; return; }
    if (/^\d$/.test(text)) {
      const n = Number(text);
      if (n >= 1 && n <= other) this.checked[t]![n - 1] = !this.checked[t]![n - 1];
    }
  }

  sendKey(key: PaneKey): void {
    this.events.push(`key:${key}`);
    if (this.tab === 0 || this.tab === 3) return;
    const t = this.tab - 1;
    const last = this.labels[t]!.length + 2;
    if (key === 'down') this.cursor = Math.min(last, this.cursor + 1);
    if (key === 'enter' && this.cursor === last) {
      const picked = this.labels[t]!.filter((_, i) => this.checked[t]![i]);
      if (this.checked[t]![this.labels[t]!.length]) picked.push(this.typed[t]!);
      this.answers.push(picked);
      this.tab = this.tab === 1 ? 2 : 3;
      this.cursor = 1;
    }
  }
}

const ask = (q: string, labels: string[], over: Partial<PeerChatAsk> = {}): PeerChatAsk => ({
  askId: `a-${q}`, kind: 'question', tool: 'AskUserQuestion', input: q,
  options: labels.map((label, i) => ({ key: String(i + 1), label })), multi: true, allowText: true, ...over,
});
const ASK1 = ask('果物はどれ？', ['りんご', 'みかん', 'ぶどう'], { step: { index: 1, total: 2 } });
const ASK2 = ask('色はどれ？', ['赤', '青'], { step: { index: 2, total: 2 } });

const noSleep = async (): Promise<void> => {};
const rig = () => {
  const pane = new FakeManyMulti();
  return { pane, ...createPeerAnswerer({ pane: () => pane, sleep: noSleep }) };
};

describe('parseDialog と dialogMatches: 実機のタブの中の複数選択', () => {
  it('Windows の実機の 1 タブ目を読み、ask が合う', () => {
    const d = parseDialog(REAL_MANY_MULTI_TAB1)!;
    expect(d.step).toEqual({ index: 1, total: 2, submit: false });
    expect(d.multi).toBe(true);
    expect(d.question).toBe('果物はどれ？');
    expect(d.options.map((o) => o.first)).toEqual(['りんご', 'みかん', 'ぶどう', 'Type something', 'Chat about this']);
    expect(d.cursor).toBe(1);
    expect(dialogMatches(ASK1, d)).toBe(true);
    expect(dialogMatches({ ...ASK1, multi: false }, d)).toBe(false);
  });
  it('2.1.332 の確認のタブ（Ready to submit の行が無い）も、確認のタブと読む', () => {
    const d = parseDialog(REAL_MANY_SUBMIT_2332)!;
    expect(d.step).toEqual({ index: null, total: 2, submit: true });
    expect(d.options.map((o) => o.first)).toEqual(['Submit answers', 'Cancel']);
    expect(d.unanswered).toBe(0);
  });
  it('頭の行の無い Submit answers と Cancel の箇条書きは、札と読まない', () => {
    expect(parseDialog('Review your answers\n\n❯ 1. Submit answers\n  2. Cancel\n')).toBeNull();
  });
  it('最後の問いのタブ（Submit の行）も合う', () => {
    const d = parseDialog(REAL_MANY_MULTI_TAB2_LAST)!;
    expect(d.multi).toBe(true);
    expect(d.question).toBe('色はどれ？');
    expect(dialogMatches(ASK2, d)).toBe(true);
  });
});

describe('answerAsk: タブの中の複数選択に答える', () => {
  it('数字で箱を付け、Next の行まで下りて Enter で次のタブへ進む', async () => {
    const r = rig();
    expect(await r.answerAsk('run', ASK1, ['2', '3'])).toEqual({ ok: true, label: 'みかん, ぶどう' });
    expect(r.pane.events).toEqual(['text:2', 'text:3', 'key:down', 'key:down', 'key:down', 'key:down', 'key:enter']);
    expect(r.pane.tab).toBe(2);
    expect(r.pane.answers).toEqual([['みかん', 'ぶどう']]);
  });

  it('自由入力は Type something の行で打ち、下の行で Enter', async () => {
    const r = rig();
    expect(await r.answerAsk('run', ASK1, ['1'], 'もも')).toEqual({ ok: true, label: 'りんご, もも' });
    expect(r.pane.events).toEqual(['text:1', 'key:down', 'key:down', 'key:down', 'text:もも', 'key:down', 'key:enter']);
    expect(r.pane.answers).toEqual([['りんご', 'もも']]);
  });

  it('最後の問いに答えると、確認のタブの Submit answers を続けて押し、札が閉じる', async () => {
    const r = rig();
    await r.answerAsk('run', ASK1, ['1']);
    expect(await r.answerAsk('run', ASK2, [], 'みどり')).toEqual({ ok: true, label: 'みどり' });
    expect(r.pane.answers).toEqual([['りんご'], ['みどり']]);
    expect(r.pane.tab).toBe(0);
  });

  it('手元で付けた箱は、選ばれていなければ外し、選ばれていれば打たない', async () => {
    const r = rig();
    r.pane.checked[0]![0] = true; // りんご
    r.pane.checked[0]![1] = true; // みかん
    expect(await r.answerAsk('run', ASK1, ['2', '3'])).toEqual({ ok: true, label: 'みかん, ぶどう' });
    expect(r.pane.answers).toEqual([['みかん', 'ぶどう']]);
    expect(r.pane.events.slice(0, 2)).toEqual(['text:1', 'text:3']);
  });

  it('カーソルが手元で動いていても、そこから数えて Next に着く', async () => {
    const r = rig();
    r.pane.cursor = 3;
    expect(await r.answerAsk('run', ASK1, ['1'])).toEqual({ ok: true, label: 'りんご' });
    expect(r.pane.events).toEqual(['text:1', 'key:down', 'key:down', 'key:enter']);
    expect(r.pane.tab).toBe(2);
  });

  it('自由入力の行に手元の文字が入っていると、打たずに断る', async () => {
    const r = rig();
    r.pane.typed[0] = 'なし';
    r.pane.checked[0]![3] = true;
    expect(await r.answerAsk('run', ASK1, ['1'], 'もも')).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(r.pane.events).toEqual([]);
  });

  it('2 タブ目の ask で、まだ 1 タブ目の画面には打たない', async () => {
    const r = rig();
    expect(await r.answerAsk('run', ASK2, ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(r.pane.events).toEqual([]);
  });
});
