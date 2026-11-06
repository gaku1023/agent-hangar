import { describe, expect, it } from 'vitest';
import type { PeerChatAsk } from '@agent-hangar/shared';
import { createPeerAnswerer, type AnswerPane } from './answer.ts';
import { EDIT_NARROW_SPACES, EDIT_OUTSIDE, EDIT_RELATIVE, EDIT_SUBDIR, NOTEBOOK_EDIT, READ_OUTSIDE, WRITE_NARROW_TRUNCATED, WRITE_NEW, WRITE_OVERWRITE } from './fileDialogs.fixtures.ts';
import { pendingAskFrom } from './hostView.ts';
import type { HostSession } from './hostTypes.ts';

const session = (over: Partial<HostSession> = {}): HostSession => ({ provider: 'claude-code', live: 'waiting', waitingFor: 'permission', permission: null, activity: null, cwd: '/p', lock: false, newerElsewhere: false, remoteOnly: false, takenOver: false, ...over });
const RULE = '╌'.repeat(44);

describe('pendingAskFrom', () => {
  const perm = [' Bash command', ' mock desc', RULE, ' ls -la', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'].join('\n');

  it('許可は、画面の行の文を label にし、番号を key にする', () => {
    const a = pendingAskFrom(session({ permission: { tool: 'Bash', input: 'ls -la', description: 'd' } }), perm)!;
    expect(a).toMatchObject({ kind: 'permission', tool: 'Bash', input: 'ls -la', multi: false, allowText: false });
    expect(a.options).toEqual([{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]);
  });

  it('登録に許可の中身が無ければ、罫線に挟まれた文字を input にして道具は付けない', () => {
    const a = pendingAskFrom(session(), perm)!;
    expect(a.tool).toBeUndefined();
    expect(a.input).toBe('ls -la');
  });

  it('画面に札が無ければ null', () => {
    expect(pendingAskFrom(session(), '● done\n\n❯ \n')).toBeNull();
  });

  it('質問は問いの文を input にし、Type something は自由入力、Chat about this は選択肢に出さない', () => {
    const screen = [' ☐ Choice', 'Which one?', '❯ 1. Alpha', '     Alpha (description)', '  2. Beta', '     Beta (description)', '  3. Type something.', '──────────', '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
    const a = pendingAskFrom(session({ waitingFor: 'question', activity: { tool: 'AskUserQuestion', summary: '', question: 'Which one?' } }), screen)!;
    expect(a).toMatchObject({ kind: 'question', tool: 'AskUserQuestion', input: 'Which one?', multi: false, allowText: true });
    expect(a.options.map((o) => o.label)).toEqual(['Alpha', 'Beta']);
  });
});

describe('pendingAskFrom: ファイルの道具の札', () => {
  const CWD = 'C:\\Users\\dev\\work\\proj';
  const at = (over: Partial<HostSession> = {}) => session({ cwd: CWD, ...over });

  it('hook の入力が無ければ、題から道具を、画面のパスを cwd で絶対にして input にする', () => {
    expect(pendingAskFrom(at(), EDIT_SUBDIR)).toMatchObject({ kind: 'permission', tool: 'Edit', input: `${CWD}\\sub\\m.txt` });
    expect(pendingAskFrom(at(), EDIT_OUTSIDE)).toMatchObject({ tool: 'Edit', input: 'C:\\Users\\dev\\work\\outside.txt' });
    expect(pendingAskFrom(at(), WRITE_NEW)).toMatchObject({ tool: 'Write', input: `${CWD}\\sub\\new1.txt` });
    expect(pendingAskFrom(at(), WRITE_OVERWRITE)).toMatchObject({ tool: 'Write', input: `${CWD}\\a.txt` });
    expect(pendingAskFrom(at(), NOTEBOOK_EDIT)).toMatchObject({ tool: 'NotebookEdit', input: `${CWD}\\nb.ipynb` });
    expect(pendingAskFrom(at(), READ_OUTSIDE)).toMatchObject({ tool: 'Read', input: 'C:\\Users\\dev\\work\\outside.txt' });
  });

  it('空白を含むパスは空白と大小をそのまま見せる', () => {
    expect(pendingAskFrom(at(), EDIT_NARROW_SPACES)!.input).toBe(`${CWD}\\long dir name with spaces\\deeper level folder\\some file name.txt`);
  });

  it('cwd が分からないか、パスが左で切れているときは、画面の文字のまま input にする', () => {
    expect(pendingAskFrom(session({ cwd: '' }), EDIT_SUBDIR)!.input).toBe('sub\\m.txt');
    expect(pendingAskFrom(at(), WRITE_NARROW_TRUNCATED)!.input).toBe('…r\\an even longer file name for the wrapping test of this dialog.txt');
  });

  it('hook の入力（道具と絶対パス）があれば、それを使う', () => {
    const a = pendingAskFrom(at({ permission: { tool: 'Edit', input: `${CWD}\\sub\\m.txt`, description: null } }), EDIT_SUBDIR)!;
    expect(a).toMatchObject({ tool: 'Edit', input: `${CWD}\\sub\\m.txt` });
  });

  it('作った ask は、同じ画面の答えとして通る（組み立てと照合の往復）', async () => {
    for (const screen of [EDIT_RELATIVE, EDIT_SUBDIR, EDIT_OUTSIDE, WRITE_NEW, WRITE_OVERWRITE, NOTEBOOK_EDIT, READ_OUTSIDE, EDIT_NARROW_SPACES, WRITE_NARROW_TRUNCATED]) {
      const p = pendingAskFrom(at(), screen)!;
      const ask = { askId: 'x', ...p } as PeerChatAsk;
      const yes = ask.options.find((o) => o.label === 'Yes')!;
      let closed = false;
      const pane: AnswerPane = { capture: () => (closed ? '● done\n' : screen), sendKey: () => {}, sendText: () => { closed = true; } };
      const r = await createPeerAnswerer({ pane: () => pane, cwd: () => CWD, sleep: async () => {} }).answerAsk('r', ask, [yes.key]);
      expect(r, screen.slice(0, 80)).toEqual({ ok: true, label: 'Yes' });
    }
  });
});
