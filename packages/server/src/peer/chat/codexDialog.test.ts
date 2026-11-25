import { describe, expect, it } from 'vitest';
import type { AgentAskQuestion, AgentPendingAsk } from '../../agent/pendingAsk.ts';
import { codexScreenKeys, matchCodexAsk, readCodexDialog } from './codexDialog.ts';
import {
  CODEX_EXEC_ASK,
  CODEX_EXEC_ASK_80,
  CODEX_EXEC_ASK_OTHER,
  CODEX_EXEC_CLOSED,
  CODEX_EXEC_ESC_CLOSED,
  CODEX_PATCH_ASK,
  CODEX_PATCH_ASK_80,
  CODEX_PATCH_CLOSED,
  CODEX_RUI_ASK,
  CODEX_RUI_ASK_80,
  CODEX_RUI_CLOSED,
  CODEX_RUI_LAST,
} from './dialogs.codex.fixtures.ts';

const CHOICES = [
  { key: 'once', label: '今回だけ許可', scope: 'once' as const },
  { key: 'session', label: 'この会話の間は許可', scope: 'session' as const },
  { key: 'deny', label: '許可しない', scope: 'deny' as const },
  { key: 'cancel', label: '許可せず中断', scope: 'deny-stop' as const },
];

const execAsk = (command: string): AgentPendingAsk => ({ provider: 'codex', stableId: 'x', api: null, kind: 'permission', tool: 'Bash', input: command, choices: CHOICES, questions: [] });
const patchAsk = (grantRoot: string): AgentPendingAsk => ({ provider: 'codex', stableId: 'x', api: null, kind: 'permission', tool: 'Edit', input: grantRoot, choices: CHOICES, questions: [] });

function question(over: Partial<AgentAskQuestion> = {}): AgentAskQuestion {
  return {
    id: 'lang',
    text: 'What language should the greeting file use?',
    kind: 'choice',
    options: [
      { key: 'English', label: 'English' },
      { key: 'Japanese', label: 'Japanese' },
    ],
    multi: false,
    allowText: true,
    required: true,
    ...over,
  };
}
const questionAsk = (qs: AgentAskQuestion[]): AgentPendingAsk => ({ provider: 'codex', stableId: 'q', api: null, kind: 'question', choices: [], questions: qs });
const perm = (choice: 'once' | 'session' | 'deny' | 'deny-stop') => ({ kind: 'permission' as const, choice });
const answer = (id: string, value: string) => ({ kind: 'question' as const, answers: { [id]: value } });
// 問いが 1 つのときの画面。実物は 2 問のもの（Question 1/2）なので、見出しだけ 1/1 に直した派生である。
const single = (s: string): string => s.replace('Question 1/2 (2 unanswered)', 'Question 1/1 (1 unanswered)');

describe('readCodexDialog（Codex 0.171.0 の実物）', () => {
  it('命令の承認を読む（120 桁と 80 桁）', () => {
    for (const s of [CODEX_EXEC_ASK, CODEX_EXEC_ASK_80]) {
      const d = readCodexDialog(s);
      expect(d?.kind).toBe('exec');
      if (d?.kind !== 'exec') return;
      expect(d.command).toBe('echo hi > a.txt');
      expect(d.reason).toBe('May I retry the requested command with permission to write a.txt?');
      expect(d.options.map((o) => o.hotkey)).toEqual(['y', 'p', 'esc']);
    }
  });

  it('ファイルの変更の承認を読む。80 桁で折り返されたパスはつなぎ直す', () => {
    const wide = readCodexDialog(CODEX_PATCH_ASK);
    const narrow = readCodexDialog(CODEX_PATCH_ASK_80);
    expect(wide?.kind).toBe('patch');
    expect(narrow?.kind).toBe('patch');
    if (wide?.kind !== 'patch' || narrow?.kind !== 'patch') return;
    expect(wide.destination).toMatch(/^\/work\/project-root\/a+\/cx\/b\.txt$/);
    expect(narrow.destination).toMatch(/^\/work\/project-root\/a+b+\/cx\/b\.txt$/);
    expect(wide.description).toBe('Apply proposed file edits');
    expect(narrow.options.map((o) => o.hotkey)).toEqual(['y', 'a', 'esc']);
  });

  it('requestUserInput の問いと選択肢を読む。None of the above は選択肢に入れない', () => {
    for (const s of [CODEX_RUI_ASK, CODEX_RUI_ASK_80]) {
      const d = readCodexDialog(s);
      expect(d).toMatchObject({ kind: 'question', index: 1, total: 2, last: false, text: 'What language should the greeting file use?', otherNumber: 3 });
      if (d?.kind !== 'question') return;
      expect(d.options).toEqual([
        { number: 1, label: 'English', description: 'A short greeting written in English.' },
        { number: 2, label: 'Japanese', description: 'A short greeting written in Japanese.' },
      ]);
    }
    expect(readCodexDialog(CODEX_RUI_LAST)).toMatchObject({ kind: 'question', index: 2, total: 2, last: true });
  });

  it('札の無い画面（閉じた後）は null。Plan の Implement this plan? も札として読まない', () => {
    for (const s of [CODEX_EXEC_CLOSED, CODEX_EXEC_ESC_CLOSED, CODEX_PATCH_CLOSED, CODEX_RUI_CLOSED, '', 'hello']) expect(readCodexDialog(s)).toBeNull();
  });
});

describe('codexScreenKeys（命令の承認）', () => {
  it('once は y、deny-stop は escape。120 桁でも 80 桁でも同じ', () => {
    for (const s of [CODEX_EXEC_ASK, CODEX_EXEC_ASK_80]) {
      expect(codexScreenKeys(s, execAsk('echo hi > a.txt'), perm('once'))).toEqual(['y']);
      expect(codexScreenKeys(s, execAsk('echo hi > a.txt'), perm('deny-stop'))).toEqual(['escape']);
    }
  });

  it('命令の session と deny は画面に無いので null（p は永続の規則なので使わない）', () => {
    expect(codexScreenKeys(CODEX_EXEC_ASK, execAsk('echo hi > a.txt'), perm('session'))).toBeNull();
    expect(codexScreenKeys(CODEX_EXEC_ASK, execAsk('echo hi > a.txt'), perm('deny'))).toBeNull();
  });

  it('命令の文が違う見本では打たない', () => {
    expect(codexScreenKeys(CODEX_EXEC_ASK_OTHER, execAsk('echo hi > a.txt'), perm('once'))).toBeNull();
    expect(codexScreenKeys(CODEX_EXEC_ASK, execAsk('echo two > c.txt'), perm('once'))).toBeNull();
    expect(codexScreenKeys(CODEX_EXEC_ASK, execAsk(''), perm('once'))).toBeNull();
    expect(codexScreenKeys(CODEX_EXEC_ASK_OTHER, execAsk('echo two > c.txt'), perm('once'))).toEqual(['y']);
  });

  it('シェルの包みと空白の違いは同じ命令とみなす', () => {
    expect(codexScreenKeys(CODEX_EXEC_ASK, execAsk(`/bin/zsh -lc 'echo hi > a.txt'`), perm('once'))).toEqual(['y']);
    expect(codexScreenKeys(CODEX_EXEC_ASK, execAsk('echo   hi >  a.txt'), perm('once'))).toEqual(['y']);
  });

  it('札の無い画面と、種類の違う ask では null', () => {
    expect(codexScreenKeys(CODEX_EXEC_CLOSED, execAsk('echo hi > a.txt'), perm('once'))).toBeNull();
    expect(codexScreenKeys(CODEX_EXEC_ASK, patchAsk('/work'), perm('once'))).toBeNull();
    expect(codexScreenKeys(CODEX_EXEC_ASK, questionAsk([question()]), answer('lang', 'English'))).toBeNull();
  });
});

describe('codexScreenKeys（ファイルの変更の承認）', () => {
  it('once は y、session は a、deny は無し、deny-stop は escape', () => {
    for (const s of [CODEX_PATCH_ASK, CODEX_PATCH_ASK_80]) {
      const ask = patchAsk('/work/project-root');
      expect(codexScreenKeys(s, ask, perm('once'))).toEqual(['y']);
      expect(codexScreenKeys(s, ask, perm('session'))).toEqual(['a']);
      expect(codexScreenKeys(s, ask, perm('deny'))).toBeNull();
      expect(codexScreenKeys(s, ask, perm('deny-stop'))).toEqual(['escape']);
    }
  });

  it('grantRoot が画面の場所の下に無ければ打たない。空なら場所を問わない', () => {
    expect(codexScreenKeys(CODEX_PATCH_ASK, patchAsk('/elsewhere'), perm('once'))).toBeNull();
    expect(codexScreenKeys(CODEX_PATCH_ASK, patchAsk(''), perm('once'))).toEqual(['y']);
  });
});

describe('codexScreenKeys（requestUserInput）', () => {
  it('問いが 2 つの札は、1 問目でも最後の問いでも null（画面の道で答えない）', () => {
    const ask = questionAsk([question(), question({ id: 'name', text: 'Which file name should the plan use?' })]);
    expect(codexScreenKeys(CODEX_RUI_ASK, ask, answer('lang', 'English'))).toBeNull();
    // 札の側が 1 問と言っていても、画面が Question 1/2 なら打たない。
    expect(codexScreenKeys(CODEX_RUI_ASK, questionAsk([question()]), answer('lang', 'English'))).toBeNull();
    expect(codexScreenKeys(CODEX_RUI_LAST, questionAsk([question()]), answer('lang', 'English'))).toBeNull();
  });

  it('問いが 1 つなら、選択肢の番号キーを返す（派生の画面）', () => {
    for (const s of [single(CODEX_RUI_ASK), single(CODEX_RUI_ASK_80)]) {
      expect(codexScreenKeys(s, questionAsk([question()]), answer('lang', 'English'))).toEqual(['1']);
      expect(codexScreenKeys(s, questionAsk([question()]), answer('lang', 'Japanese'))).toEqual(['2']);
    }
  });

  it('問いの文や選択肢が違う、選択肢が無い答え、自由記述、複数選択、伏せた値は null', () => {
    const s = single(CODEX_RUI_ASK);
    expect(codexScreenKeys(s, questionAsk([question({ text: 'Another question?' })]), answer('lang', 'English'))).toBeNull();
    expect(codexScreenKeys(s, questionAsk([question({ options: [{ key: 'English', label: 'English' }, { key: 'French', label: 'French' }] })]), answer('lang', 'English'))).toBeNull();
    expect(codexScreenKeys(s, questionAsk([question()]), answer('lang', 'Klingon'))).toBeNull();
    expect(codexScreenKeys(s, questionAsk([question({ multi: true })]), answer('lang', 'English'))).toBeNull();
    expect(codexScreenKeys(s, questionAsk([question({ secret: true })]), answer('lang', 'English'))).toBeNull();
    expect(codexScreenKeys(s, questionAsk([question({ kind: 'text', options: [] })]), answer('lang', 'English'))).toBeNull();
    expect(codexScreenKeys(s, questionAsk([question()]), { kind: 'question', answers: { lang: ['English'] } })).toBeNull();
  });

  it('閉じた後の画面では null', () => {
    expect(codexScreenKeys(CODEX_RUI_CLOSED, questionAsk([question()]), answer('lang', 'English'))).toBeNull();
  });
});

describe('matchCodexAsk', () => {
  it('命令の承認は ask の種類（Bash）と文で見る', () => {
    const d = readCodexDialog(CODEX_EXEC_ASK)!;
    expect(matchCodexAsk(d, execAsk('echo hi > a.txt'))).toBe(true);
    expect(matchCodexAsk(d, { ...execAsk('echo hi > a.txt'), tool: 'Edit' })).toBe(false);
  });
});
