import { describe, expect, it } from 'vitest';
import type { PeerChatAsk } from '@agent-hangar/shared';
import { createPeerAnswerer, type AnswerPane } from './answer.ts';
import { EDIT_NARROW_SPACES, EDIT_OUTSIDE, EDIT_RELATIVE, EDIT_SUBDIR, NOTEBOOK_EDIT, READ_OUTSIDE, WRITE_NARROW_TRUNCATED, WRITE_NEW, WRITE_OVERWRITE } from './fileDialogs.fixtures.ts';
import { readPermissionHook } from '../../provider/claude-code/hooks/permission.ts';
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
  const hookPayload = (tool: string, input: Record<string, unknown>) => ({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: tool, tool_input: input });
  const permissionOf = (tool: string, input: Record<string, unknown>) => readPermissionHook(hookPayload(tool, input))!.ask;

  // 本物の hook の入力の形（tool_input）。
  // Edit は file_path、old_string、new_string、replace_all。
  // Write は file_path と content。
  // NotebookEdit は notebook_path。
  // Read は file_path。
  const CASES: { name: string; screen: string; tool: string; input: Record<string, unknown>; path: string }[] = [
    { name: 'Edit（cwd の中）', screen: EDIT_RELATIVE, tool: 'Edit', input: { file_path: `${CWD}\\a.txt`, old_string: 'beta', new_string: 'BETA', replace_all: false }, path: `${CWD}\\a.txt` },
    { name: 'Edit（下の階層）', screen: EDIT_SUBDIR, tool: 'Edit', input: { file_path: `${CWD}\\sub\\m.txt`, old_string: 'two', new_string: 'TWO' }, path: `${CWD}\\sub\\m.txt` },
    { name: 'Edit（cwd の外）', screen: EDIT_OUTSIDE, tool: 'Edit', input: { file_path: 'C:\\Users\\dev\\work\\outside.txt', old_string: 'x2', new_string: 'X2' }, path: 'C:\\Users\\dev\\work\\outside.txt' },
    { name: 'Write（新規）', screen: WRITE_NEW, tool: 'Write', input: { file_path: `${CWD}\\sub\\new1.txt`, content: 'hello\n' }, path: `${CWD}\\sub\\new1.txt` },
    { name: 'Write（上書き）', screen: WRITE_OVERWRITE, tool: 'Write', input: { file_path: `${CWD}\\a.txt`, content: 'one\ntwo' }, path: `${CWD}\\a.txt` },
    { name: 'NotebookEdit', screen: NOTEBOOK_EDIT, tool: 'NotebookEdit', input: { notebook_path: `${CWD}\\nb.ipynb`, cell_id: 'c1', new_source: 'print(2)', edit_mode: 'replace' }, path: `${CWD}\\nb.ipynb` },
    { name: 'Read（cwd の外）', screen: READ_OUTSIDE, tool: 'Read', input: { file_path: 'C:\\Users\\dev\\work\\outside.txt' }, path: 'C:\\Users\\dev\\work\\outside.txt' },
    { name: 'Edit（空白を含むパス）', screen: EDIT_NARROW_SPACES, tool: 'Edit', input: { file_path: `${CWD}\\long dir name with spaces\\deeper level folder\\some file name.txt`, old_string: 'k2', new_string: 'K2' }, path: `${CWD}\\long dir name with spaces\\deeper level folder\\some file name.txt` },
    { name: 'Write（左が切れたパス）', screen: WRITE_NARROW_TRUNCATED, tool: 'Write', input: { file_path: `${CWD}\\long dir name with spaces\\deeper level folder\\an even longer file name for the wrapping test of this dialog.txt`, content: 'hi' }, path: `${CWD}\\long dir name with spaces\\deeper level folder\\an even longer file name for the wrapping test of this dialog.txt` },
  ];

  for (const c of CASES) {
    it(`${c.name}: hook の入力は素のパスで、そのまま ask の tool と input になる`, () => {
      const perm = permissionOf(c.tool, c.input);
      expect(perm).toMatchObject({ tool: c.tool, input: c.path });
      expect(pendingAskFrom(at({ permission: perm }), c.screen)).toMatchObject({ kind: 'permission', tool: c.tool, input: c.path });
    });

    it(`${c.name}: 作った ask は、同じ画面の答えとして通る（組み立てと照合の往復）`, async () => {
      const p = pendingAskFrom(at({ permission: permissionOf(c.tool, c.input) }), c.screen)!;
      const ask = { askId: 'x', ...p } as PeerChatAsk;
      const yes = ask.options.find((o) => o.label === 'Yes')!;
      let closed = false;
      const pane: AnswerPane = { capture: () => (closed ? '● done\n' : c.screen), sendKey: () => {}, sendText: () => { closed = true; } };
      const r = await createPeerAnswerer({ pane: () => pane, cwd: () => CWD, sleep: async () => {} }).answerAsk('r', ask, [yes.key]);
      expect(r).toEqual({ ok: true, label: 'Yes' });
    });

    it(`${c.name}: hook の許可が無ければ、画面から tool と input を組まず、答えられない`, async () => {
      const p = pendingAskFrom(at(), c.screen)!;
      expect(p.kind).toBe('permission');
      expect(p.tool).toBeUndefined();
      expect(p.input).toBeUndefined();
      const ask = { askId: 'x', ...p } as PeerChatAsk;
      const yes = ask.options.find((o) => o.label === 'Yes')!;
      const sent: string[] = [];
      const pane: AnswerPane = { capture: () => c.screen, sendKey: () => {}, sendText: (t) => { sent.push(t); } };
      const r = await createPeerAnswerer({ pane: () => pane, cwd: () => CWD, sleep: async () => {} }).answerAsk('r', ask, [yes.key]);
      expect(r).toEqual({ ok: false, reason: 'ask-mismatch' });
      expect(sent).toEqual([]);
    });
  }

  it('hook の許可の道具と画面の題が合わなければ、答えられない', async () => {
    const perm = permissionOf('Bash', { command: 'ls' });
    const p = pendingAskFrom(at({ permission: perm }), EDIT_SUBDIR)!;
    const sent: string[] = [];
    const pane: AnswerPane = { capture: () => EDIT_SUBDIR, sendKey: () => {}, sendText: (t) => { sent.push(t); } };
    const r = await createPeerAnswerer({ pane: () => pane, cwd: () => CWD, sleep: async () => {} }).answerAsk('r', { askId: 'x', ...p } as PeerChatAsk, ['1']);
    expect(r).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(sent).toEqual([]);
  });
});
