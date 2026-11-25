import { describe, expect, it } from 'vitest';
import type { PeerChatAsk } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { askAnswered, askAnswerStarted, askUpdated } from '../store/localAsk.ts';
import { translatorOf } from './i18n.ts';
import { answeredText } from './peerChat.ts';
import { localAnsweredLine, presentLocalAsk, presentLocalAskBand } from './localAsk.ts';

const ask = (over: Partial<PeerChatAsk> = {}): PeerChatAsk => ({ askId: 'a1', kind: 'permission', tool: 'Bash', input: 'ls', options: [{ key: 'once', label: '1 回だけ許可', description: 'この実行だけを許可します。' }], multi: false, allowText: false, ...over });
const base = (): Store => ({ ...initialStore(), device: { id: 'd1', name: 'Mac' } });
const t = (s: Store) => translatorOf(s);

describe('presentLocalAsk', () => {
  it('札が無い会話は null', () => {
    const s = base();
    expect(presentLocalAsk(s, 's1', t(s))).toBeNull();
    expect(presentLocalAskBand(s, 's1', t(s))).toBeNull();
  });

  it('許可の札は、選択肢と説明と命令を持ち、答えられる', () => {
    const s = askUpdated(base(), 's1', ask());
    const m = presentLocalAsk(s, 's1', t(s))!;
    expect(m).toMatchObject({ askId: 'a1', askKind: 'permission', input: 'ls', hostOnly: null, pending: false, locked: false, answered: null });
    expect(m.options[0]).toMatchObject({ key: 'once', description: 'この実行だけを許可します。' });
  });

  it('答えを送っている間は pending', () => {
    const s = askAnswerStarted(askUpdated(base(), 's1', ask()), 's1', 'a1');
    expect(presentLocalAsk(s, 's1', t(s))!.pending).toBe(true);
  });

  it('答えられない札は hostOnly に案内を入れる', () => {
    const s = askUpdated(base(), 's1', ask({ answerable: false, options: [] }));
    expect(presentLocalAsk(s, 's1', t(s))!.hostOnly).not.toBeNull();
  });

  it('答えが通ったら記録の文を持つ。英数字で始まる語は「で」との間に空白を置く', () => {
    const s = askAnswered(askUpdated(base(), 's1', ask()), 's1', 'a1', localAnsweredLine(t(base()), ask(), '1 回だけ許可', 'Mac'));
    expect(presentLocalAsk(s, 's1', t(s))!.answered).toBe('Mac で 1 回だけ許可');
  });

  it('札の理由（title）は reason に載る', () => {
    const s = askUpdated(base(), 's1', ask({ title: 'テスト用のファイルを作るため' }));
    expect(presentLocalAsk(s, 's1', t(s))!.reason).toBe('テスト用のファイルを作るため');
  });

  it('帯は会話の id と札を持つ', () => {
    const s = askUpdated(base(), 's1', ask());
    expect(presentLocalAskBand(s, 's1', t(s))).toMatchObject({ sessionId: 's1', row: { askId: 'a1' } });
  });
});

describe('answeredText', () => {
  it('日本語の語は空白を入れず、英数字で始まる語は入れる', () => {
    const s = base();
    expect(answeredText(t(s), 'permission', false, 'Mac', '許可')).toBe('Mac で許可');
    expect(answeredText(t(s), 'permission', false, 'Mac', '1 回だけ許可')).toBe('Mac で 1 回だけ許可');
    expect(answeredText(t(s), 'question', false, 'Mac', 'はい')).toBe('Mac で「はい」');
    expect(answeredText(t(s), 'question', true, 'Mac', 'x')).toBe('Mac で入力完了');
  });
});
