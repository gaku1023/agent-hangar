import type { PeerChatAsk } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import type { HostSession } from './hostTypes.ts';
import { createPeerAnswerer, dialogMatches, parseDialog } from './answer.ts';
import { pendingAskFrom } from './hostView.ts';
import { LONG_QUESTION_TEXT, LONG_QUESTION_WIN, SHORT_QUESTION_MAC } from './questionDialogs.fixtures.ts';

// 質問の札を、実機の見本（questionDialogs.fixtures.ts）で読み、hook の問いの文と照合する試験。

const ask = (input: string, labels: string[]): PeerChatAsk => ({
  askId: 'a1', kind: 'question', tool: 'AskUserQuestion', input,
  options: labels.map((label, i) => ({ key: String(i + 1), label })), multi: false, allowText: true,
});

const session = (question: string): HostSession => ({
  provider: 'claude-code', live: 'waiting', aside: false, waitingFor: 'question', permission: null,
  activity: { question } as HostSession['activity'], cwd: '/p', lock: false, newerElsewhere: false, remoteOnly: false, takenOver: false,
});

describe('質問の札の縦線（Claude Code 2.1.325）', () => {
  it('折り返した長い問いの頭の │ を外して、問いの文を 1 つに読む', () => {
    const d = parseDialog(LONG_QUESTION_WIN)!;
    expect(d.kind).toBe('question');
    expect(d.question.replace(/\s+/g, '')).toBe(LONG_QUESTION_TEXT.replace(/\s+/g, ''));
    expect(d.options.map((o) => o.first)).toEqual(['VM へ移す（推奨）', '今は PC のまま', '別の案', 'Type something.', 'Chat about this']);
  });

  it('縦線つきの長い問いを、hook の問いの文と照合できる', () => {
    const d = parseDialog(LONG_QUESTION_WIN)!;
    expect(dialogMatches(ask(LONG_QUESTION_TEXT, ['VM へ移す（推奨）', '今は PC のまま', '別の案']), d)).toBe(true);
  });

  it('縦線つきの札を、ほかの PC から答えられる札として載せる', () => {
    const a = pendingAskFrom(session(LONG_QUESTION_TEXT), LONG_QUESTION_WIN)!;
    expect(a.answerable).toBeUndefined();
    expect(a.options.map((o) => o.label)).toEqual(['VM へ移す（推奨）', '今は PC のまま', '別の案']);
  });

  it('縦線つきの札に、ほかの PC の答えを打てる', async () => {
    let screen = LONG_QUESTION_WIN;
    const sent: string[] = [];
    const pane = {
      capture: () => screen,
      sendKey: (k: string) => { sent.push(k); },
      sendText: (t: string) => { sent.push(t); screen = '\n❯ \n'; },
    };
    const { answerAsk } = createPeerAnswerer({ pane: () => pane, sleep: async () => {} });
    const r = await answerAsk('r1', { ...ask(LONG_QUESTION_TEXT, ['VM へ移す（推奨）', '今は PC のまま', '別の案']), options: [{ key: 'o1', label: 'VM へ移す（推奨）' }, { key: 'o2', label: '今は PC のまま' }, { key: 'o3', label: '別の案' }] }, ['o2']);
    expect(r).toEqual({ ok: true, label: '今は PC のまま' });
    expect(sent).toEqual(['2']);
  });

  it('違う問いの文とは照合しない', () => {
    const d = parseDialog(LONG_QUESTION_WIN)!;
    expect(dialogMatches(ask('記録の処理を VM に移しますか', ['VM へ移す（推奨）']), d)).toBe(false);
  });

  it('縦線の無い短い問いは、これまでどおり読む', () => {
    const d = parseDialog(SHORT_QUESTION_MAC)!;
    expect(d.question).toBe('どちらにしますか');
    expect(dialogMatches(ask('どちらにしますか', ['A', 'B']), d)).toBe(true);
  });
});
