import { describe, expect, it } from 'vitest';
import type { PeerChatAsk } from '@agent-hangar/shared';
import { createPeerAnswerer, type AnswerPane } from './answer.ts';
import { EDIT_NARROW_SPACES, EDIT_OUTSIDE, EDIT_RELATIVE, EDIT_SUBDIR, NOTEBOOK_EDIT, READ_OUTSIDE, WRITE_NARROW_TRUNCATED, WRITE_NEW, WRITE_OVERWRITE } from './fileDialogs.fixtures.ts';
import { readPermissionHook } from '../../provider/claude-code/hooks/permission.ts';
import { ChatView, pendingAskFrom, UNANSWERABLE_RECHECK_MS } from './hostView.ts';
import type { HostSession } from './hostTypes.ts';
import { currentPendingAsk } from './tail.ts';

const session = (over: Partial<HostSession> = {}): HostSession => ({ provider: 'claude-code', live: 'waiting', waitingFor: 'permission', permission: null, activity: null, cwd: '/p', lock: false, newerElsewhere: false, remoteOnly: false, takenOver: false, ...over });
const RULE = '╌'.repeat(44);

describe('ChatView.recordAnswer', () => {
  it('同じ札の記録は 1 つ。手元の記録が先に入っても、後から答えた PC の記録で置き換え、同じ uuid の項目を 2 つ出さない', () => {
    const SELF = { deviceId: 'pc-a', deviceName: 'Win' };
    const MAC = { deviceId: 'pc-b', deviceName: 'Mac' };
    const view = new ChatView({
      now: () => 1000, sleep: async () => undefined, recheckMs: 1000,
      session: () => null, run: () => null, pane: () => null,
      tail: { readTranscript: () => null }, queued: () => [], self: () => SELF, hostId: 'h',
    });
    const item = { uuid: 'u1@ask:A', at: 1, kind: 'permission' as const, text: 'run', ask: { askId: 'A', kind: 'permission' as const, options: [{ key: '1', label: 'Yes' }], multi: false, allowText: false } };
    view.recordAnswer('s1', item, SELF, '');
    view.recordAnswer('s1', item, MAC, 'Yes');
    const items = view.build('s1', 'pc-b', null).state.items.filter((i) => i.ask?.askId === 'A');
    expect(items).toHaveLength(1);
    expect(items[0]!.ask!.answered).toMatchObject({ by: MAC, label: 'Yes' });
  });
});

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

describe('ChatView.observe: 拠り所なしから tool_use ありへの askId の変化', () => {
  const SELF = { deviceId: 'pc-a', deviceName: 'Win' };
  const permScreen = [' Bash command', ' mock desc', RULE, ' ls -la', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'].join('\n');
  const jl = (o: Record<string, unknown>): string => JSON.stringify({ isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z', ...o });
  const userL = jl({ type: 'user', uuid: 'u-user', message: { role: 'user', content: 'run it' } });
  const asstL = jl({ type: 'assistant', uuid: 'u-asst', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }] } });
  const useL = jl({ type: 'assistant', uuid: 'u-use', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }] } });

  function make() {
    const w = { lines: [userL, asstL], live: 'waiting' as 'waiting' | 'busy', screen: permScreen };
    const view = new ChatView({
      now: () => 1000, sleep: async () => undefined, recheckMs: 1000,
      session: () => session({ live: w.live, permission: { tool: 'Bash', input: 'ls -la', description: 'd' } }),
      run: () => ({ tmuxName: 't' }),
      pane: () => ({ capture: () => w.screen, captureStyled: async () => null, sendKey: () => undefined, sendText: () => undefined }),
      tail: { readTranscript: () => ({ key: String(w.lines.length), read: () => Buffer.from(w.lines.join('\n') + '\n') }) },
      queued: () => [], self: () => SELF, hostId: 'h',
    });
    return { w, view };
  }
  const asks = (view: ChatView) => view.build('s1', 'pc-b', null).state.items.filter((i) => i.ask);

  it('askId が変わっても札は 1 枚のまま、answered は付かない（最後の項目も札）', () => {
    const { w, view } = make();
    const first = asks(view);
    expect(first).toHaveLength(1);
    const oldId = first[0]!.ask!.askId;
    // tool_use が書かれて、拠り所が見つかる。
    w.lines.push(useL);
    view.poke('s1');
    const st = view.build('s1', 'pc-b', null).state;
    const cards = st.items.filter((i) => i.ask);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.ask!.askId).not.toBe(oldId);
    expect(cards[0]!.ask!.answered).toBeUndefined();
    expect(st.items.at(-1)!.ask).toBeDefined();
    // もう一度見ても同じ。
    expect(asks(view)).toHaveLength(1);
    expect(asks(view)[0]!.ask!.answered).toBeUndefined();
  });

  it('live が waiting を抜けたあとにだけ、この PC の手元で答えた記録が付く', () => {
    const { w, view } = make();
    asks(view);
    w.lines.push(useL);
    expect(asks(view)[0]!.ask!.answered).toBeUndefined();
    w.live = 'busy';
    w.screen = '● Bash(ls)\n  ⎿  Running…\n';
    view.poke('s1');
    const cards = asks(view);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.ask!.answered).toMatchObject({ by: SELF, label: '' });
  });

  it('askId が変わったことを覚え、古い askId を今の札へ読み替える。覚えの無い askId は読み替えない', () => {
    const { w, view } = make();
    const oldId = asks(view)[0]!.ask!.askId;
    w.lines.push(useL);
    view.observe('s1');
    const cur = view.currentAsk('s1')!;
    expect(cur.askId).not.toBe(oldId);
    expect(view.resolveAskId(oldId, cur.askId)).toBe(cur.askId);
    expect(view.resolveAskId(cur.askId, cur.askId)).toBe(cur.askId);
    expect(view.resolveAskId('unrelated', cur.askId)).toBe('unrelated');
  });

  it('同じ命令の 2 回目の札は言い換えにしない。1 枚目は手元の記録になり、1 枚目の askId は 2 枚目に読み替えない', () => {
    const { w, view } = make();
    const a0 = asks(view)[0]!.ask!.askId;
    // 1 枚目は手元で答えられ（結果が載る）、同じ命令の 2 枚目が観察の間に出た（登録はずっと waiting のまま）。
    const resultL = jl({ type: 'user', uuid: 'u-res', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] } });
    const use2L = jl({ type: 'assistant', uuid: 'u-use2', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls -la' } }] } });
    w.lines.push(useL, resultL, use2L);
    view.poke('s1');
    const cards = asks(view);
    const a2 = cards.find((c) => !c.ask!.answered)!.ask!.askId;
    expect(a2).not.toBe(a0);
    expect(cards.find((c) => c.ask!.askId === a0)?.ask?.answered).toMatchObject({ by: SELF, label: '' });
    expect(view.answeredAsk(a0)).toBe(true);
    expect(view.resolveAskId(a0, a2)).toBe(a0);
  });

  it('言い換えの覚えは 64 件まで。古いものから忘れる', () => {
    const { view } = make();
    const remember = (view as unknown as { rememberRekey(a: string, b: string): void }).rememberRekey.bind(view);
    for (let i = 0; i < 65; i++) remember(`old${i}`, `new${i}`);
    expect(view.resolveAskId('old0', 'new0')).toBe('old0');
    expect(view.resolveAskId('old1', 'new1')).toBe('new1');
    expect(view.resolveAskId('old64', 'new64')).toBe('new64');
  });
});

describe('pendingAskFrom: 元の PC で答えられない札の印（answerable）', () => {
  const SOLID = '─'.repeat(44);
  const DASH = '╌'.repeat(44);
  const proceed = [' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for hangar - notify_user commands", '   3. No', ' Esc to cancel'];
  const mcp = [SOLID, ' Tool use', DASH, ' hangar - notify_user(title: "done") (MCP)', DASH, ...proceed].join('\n');
  const bash = [SOLID, ' Bash command', DASH, ' ls -la', DASH, ...proceed].join('\n');
  const hookBash = { tool: 'Bash', input: 'ls -la', description: null };
  const hookMcp = { tool: 'mcp__hangar__notify_user', input: '{"title":"done"}', description: null };

  it('MCP の道具の札は、hook の許可があっても false（画面の本体が input と合わない）', () => {
    expect(pendingAskFrom(session({ permission: hookMcp }), mcp)!.answerable).toBe(false);
  });

  it('MCP の道具の札は、hook の許可が無くても false（題が Bash command でない）', () => {
    expect(pendingAskFrom(session(), mcp)!.answerable).toBe(false);
  });

  it('Bash command の札は、hook の有無によらず印を付けない', () => {
    expect(pendingAskFrom(session(), bash)!.answerable).toBeUndefined();
    expect(pendingAskFrom(session({ permission: hookBash }), bash)!.answerable).toBeUndefined();
  });

  it('質問は印を付けない', () => {
    const screen = [' ☐ Choice', 'Which one?', '❯ 1. Alpha', '  2. Beta', '  3. Type something.', '──────────', '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
    const a = pendingAskFrom(session({ waitingFor: 'question', activity: { tool: 'AskUserQuestion', summary: '', question: 'Which one?' } }), screen)!;
    expect(a.answerable).toBeUndefined();
  });

  it('hook のあるファイルの札は印を付けず、hook の無いファイルの札は false', () => {
    const cwd = 'C:\\Users\\dev\\work\\proj';
    const hook = { tool: 'Write', input: `${cwd}\\sub\\new1.txt`, description: null };
    expect(pendingAskFrom(session({ cwd, permission: hook }), WRITE_NEW)!.answerable).toBeUndefined();
    expect(pendingAskFrom(session({ cwd }), WRITE_NEW)!.answerable).toBe(false);
  });
});

describe('札の印は tail の ask まで運ばれる', () => {
  it('answerable が false の PeerPendingAsk は PeerChatAsk に false で載り、印の無い札には欄が出ない', () => {
    const run = (answerable?: false) => {
      const pending = { kind: 'permission' as const, tool: 'Bash', input: 'ls', options: [{ key: '1', label: 'Yes' }], multi: false, allowText: false, ...(answerable === undefined ? {} : { answerable }) };
      return currentPendingAsk('s1', { readTranscript: () => null, pendingAsk: () => pending });
    };
    expect(run(false)).toMatchObject({ answerable: false });
    expect('answerable' in run()!).toBe(false);
  });
});

describe('ChatView: 答えられない印の取り直し', () => {
  const SOLID = '─'.repeat(44);
  const DASH = '╌'.repeat(44);
  const proceed = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'];
  const full = [SOLID, ' Bash command', DASH, ' ls -la', DASH, ...proceed].join('\n');
  // hook が先に届き、画面がまだ描き途中（罫線が 2 本そろっていない）。
  const partial = [SOLID, ' Bash command', DASH, ' ls -la', ...proceed].join('\n');
  const hook = { tool: 'Bash', input: 'ls -la', description: null };

  function make() {
    const w = { now: 1000, screen: partial, captures: 0 };
    const view = new ChatView({
      now: () => w.now, sleep: async () => undefined, recheckMs: 1000,
      session: () => session({ permission: hook }),
      run: () => ({ tmuxName: 't' }),
      pane: () => ({ capture: () => { w.captures++; return w.screen; }, captureStyled: async () => null, sendKey: () => undefined, sendText: () => undefined }),
      tail: { readTranscript: () => null },
      queued: () => [], self: () => ({ deviceId: 'pc-a', deviceName: 'Win' }), hostId: 'h',
    });
    return { w, view };
  }

  it('描き途中で false になっても、画面が整えば 2 秒後の取得で取り消される', () => {
    const { w, view } = make();
    expect(view.pendingAsk('s1', false)!.answerable).toBe(false);
    w.screen = full;
    w.now += UNANSWERABLE_RECHECK_MS;
    expect(view.pendingAsk('s1', false)!.answerable).toBeUndefined();
    // 答えられる札は覚えに入り、画面を取り直さない。
    const n = w.captures;
    w.now += UNANSWERABLE_RECHECK_MS * 5;
    view.pendingAsk('s1', false);
    expect(w.captures).toBe(n);
  });

  it('false の札の取り直しは 2 秒に 1 回まで（何度取得しても capture は増えない）', () => {
    const { w, view } = make();
    view.pendingAsk('s1', false);
    expect(w.captures).toBe(1);
    for (let i = 0; i < 10; i++) { w.now += 100; view.pendingAsk('s1', false); }
    expect(w.captures).toBe(1);
    w.now += UNANSWERABLE_RECHECK_MS;
    view.pendingAsk('s1', false);
    expect(w.captures).toBe(2);
  });

  it('印が変わると札の uuid が変わり、after の続きとして流し直される', () => {
    const { w, view } = make();
    const first = view.build('s1', 'pc-b', null).state.items.at(-1)!;
    expect(first.ask!.answerable).toBe(false);
    const askId = first.ask!.askId;
    w.screen = full;
    w.now += UNANSWERABLE_RECHECK_MS;
    const next = view.build('s1', 'pc-b', first.uuid).state.items;
    expect(next).toHaveLength(1);
    expect(next[0]!.ask).toMatchObject({ askId });
    expect(next[0]!.ask!.answerable).toBeUndefined();
  });

  describe('transcript の base がある形', () => {
    const userL = JSON.stringify({ type: 'user', uuid: 'b1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'go' } });
    function makeBase() {
      const w = { now: 1000, screen: partial, live: 'waiting' as 'waiting' | 'busy' };
      const view = new ChatView({
        now: () => w.now, sleep: async () => undefined, recheckMs: 1000,
        session: () => session({ live: w.live, permission: hook }),
        run: () => ({ tmuxName: 't' }),
        pane: () => ({ capture: () => w.screen, captureStyled: async () => null, sendKey: () => undefined, sendText: () => undefined }),
        tail: { readTranscript: () => ({ key: 'k', read: () => Buffer.from(userL + '\n') }) },
        queued: () => [], self: () => ({ deviceId: 'pc-a', deviceName: 'Win' }), hostId: 'h',
      });
      return { w, view };
    }
    const lastAsk = (view: ChatView, after: string | null) => view.build('s1', 'pc-b', after).state.items.filter((i) => i.ask);

    it('false から true へ、after に ! 付きの uuid を渡しても取りこぼさず 1 件流れ直す', () => {
      const { w, view } = makeBase();
      const first = lastAsk(view, null);
      expect(first).toHaveLength(1);
      expect(first[0]!.uuid).toMatch(/^b1@ask:.+!$/);
      w.screen = full;
      w.now += UNANSWERABLE_RECHECK_MS;
      const next = lastAsk(view, first[0]!.uuid);
      expect(next).toHaveLength(1);
      expect(next[0]!.uuid).toBe(first[0]!.uuid.slice(0, -1));
      // 受け取った後の after には繰り返さない。
      expect(lastAsk(view, next[0]!.uuid)).toHaveLength(0);
    });

    it('true から false へも 1 件流れ直す', () => {
      const { w, view } = makeBase();
      w.screen = full;
      const first = lastAsk(view, null);
      expect(first[0]!.ask!.answerable).toBeUndefined();
      w.screen = partial;
      w.now += UNANSWERABLE_RECHECK_MS;
      view.poke('s1');
      const next = lastAsk(view, first[0]!.uuid);
      expect(next).toHaveLength(1);
      expect(next[0]!.ask!.answerable).toBe(false);
    });

    it('札が閉じた後に ! 付きの after が来ても、本文の位置は保たれ札は出ない', () => {
      const { w, view } = makeBase();
      const first = lastAsk(view, null);
      w.live = 'busy';
      const st = view.build('s1', 'pc-b', first[0]!.uuid).state;
      expect(st.truncated).toBe(false);
      expect(st.items.filter((i) => i.ask && !i.ask.answered)).toHaveLength(0);
      expect(st.items.filter((i) => !i.ask)).toHaveLength(0);
    });
  });
});

describe('ChatView.build: 答えの記録の札は、呼んだ位置に並ぶ（transcript の後ろに足さない）', () => {
  const SELF = { deviceId: 'pc-a', deviceName: 'Win' };
  const MAC = { deviceId: 'pc-b', deviceName: 'Mac' };
  const permScreen = [' Bash command', ' mock desc', RULE, ' ls -la', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'].join('\n');
  const jl = (o: Record<string, unknown>): string => JSON.stringify({ isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z', ...o });
  const userL = jl({ type: 'user', uuid: 'u-user', message: { role: 'user', content: 'run it' } });
  const asstL = jl({ type: 'assistant', uuid: 'u-asst', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }] } });
  const useL = jl({ type: 'assistant', uuid: 'u-use', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }] } });
  const resultL = jl({ type: 'user', uuid: 'u-res', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] } });
  const finalL = jl({ type: 'assistant', uuid: 'u-42', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '42' }] } });

  function make() {
    const w = { lines: [userL, asstL], live: 'waiting' as 'waiting' | 'busy', screen: permScreen };
    const view = new ChatView({
      now: () => 1000, sleep: async () => undefined, recheckMs: 1000,
      session: () => session({ live: w.live, permission: { tool: 'Bash', input: 'ls -la', description: 'd' } }),
      run: () => ({ tmuxName: 't' }),
      pane: () => ({ capture: () => w.screen, captureStyled: async () => null, sendKey: () => undefined, sendText: () => undefined }),
      tail: { readTranscript: () => ({ key: String(w.lines.length), read: () => Buffer.from(w.lines.join('\n') + '\n') }) },
      queued: () => [], self: () => SELF, hostId: 'h',
    });
    return { w, view };
  }
  type Rig = ReturnType<typeof make>;
  const keys = (view: ChatView, after: string | null = null): string[] => view.build('s1', 'pc-b', after).state.items.map((i) => (i.ask ? `ask:${i.ask.answered ? 'answered' : 'open'}` : i.text));
  const finish = (w: Rig['w'], view: Rig['view']): void => {
    w.lines.push(useL, resultL, finalL);
    w.live = 'busy';
    w.screen = '● Bash(ls)\n  ⎿  Running…\n';
    view.poke('s1');
  };
  const permItem = (uuid: string, askId: string, extra: Record<string, unknown> = {}) => ({ uuid, at: 1, kind: 'permission' as const, text: askId, ask: { askId, kind: 'permission' as const, options: [{ key: '1', label: 'Yes' }], multi: false, allowText: false, ...extra } });

  it('手元で答えた札は、あとの返答（42）より前に並ぶ', () => {
    const { w, view } = make();
    expect(keys(view)).toEqual(['run it', 'ok', 'ask:open']);
    finish(w, view);
    const order = keys(view);
    expect(order.indexOf('ask:answered')).toBe(2);
    expect(order.indexOf('ask:answered')).toBeLessThan(order.indexOf('42'));
    expect(order.filter((k) => k.startsWith('ask:'))).toHaveLength(1);
  });

  it('見る側がまだ札を受け取っていない続き（after が札の前）でも、札は続きの先頭に出る', () => {
    const { w, view } = make();
    keys(view);
    finish(w, view);
    const order = keys(view, 'u-asst');
    expect(order[0]).toBe('ask:answered');
    expect(order.indexOf('42')).toBeGreaterThan(0);
  });

  it('札を受け取った後の続き（after が札の uuid）でも、答えの付いた札は続きの先頭に出る（見る側が同じ位置に重ね書きする）', () => {
    const { w, view } = make();
    const cardUuid = view.build('s1', 'pc-b', null).state.items.at(-1)!.uuid;
    finish(w, view);
    const order = keys(view, cardUuid);
    expect(order[0]).toBe('ask:answered');
    expect(order.indexOf('42')).toBeGreaterThan(0);
  });

  it('askId が言い換わった札（tool_use が後から載った）も、答えの記録が後から来て、呼んだ位置に並ぶ', () => {
    const { w, view } = make();
    const oldId = view.build('s1', 'pc-b', null).state.items.at(-1)!.ask!.askId;
    w.lines.push(useL);
    view.poke('s1');
    const mid = view.build('s1', 'pc-b', null).state.items;
    expect(mid.at(-1)!.ask!.askId).not.toBe(oldId);
    w.lines.push(resultL, finalL);
    w.live = 'busy';
    w.screen = '● done\n';
    view.poke('s1');
    const order = keys(view);
    expect(order.filter((k) => k.startsWith('ask:'))).toEqual(['ask:answered']);
    expect(order.indexOf('ask:answered')).toBeLessThan(order.indexOf('42'));
  });

  it('答えられない印（uuid の !）が付いた札の記録も、呼んだ位置に並ぶ', () => {
    const { w, view } = make();
    w.live = 'busy';
    w.lines.push(useL, resultL, finalL);
    view.recordAnswer('s1', permItem('u-asst@ask:A!', 'A', { answerable: false }), MAC, 'Yes');
    const order = keys(view);
    expect(order).toHaveLength(5);
    expect(order.slice(0, 3)).toEqual(['run it', 'ok', 'ask:answered']);
    expect(order.at(-1)).toBe('42');
  });

  it('同じ位置の札を 2 回答えたときは、答えた順のまま並ぶ', () => {
    const { w, view } = make();
    w.live = 'busy';
    w.lines.push(useL, resultL, finalL);
    view.recordAnswer('s1', permItem('u-asst@ask:A', 'A'), MAC, 'Yes');
    view.recordAnswer('s1', permItem('u-asst@ask:B', 'B'), MAC, 'Yes');
    const items = view.build('s1', 'pc-b', null).state.items;
    expect(items.map((i) => i.ask?.askId ?? i.text).slice(0, 4)).toEqual(['run it', 'ok', 'A', 'B']);
    expect(items.at(-1)!.text).toBe('42');
  });

  it('transcript に位置（直前の項目）が無い記録は、末尾に足す（続きの取得でも同じ）', () => {
    const { w, view } = make();
    w.live = 'busy';
    view.recordAnswer('s1', permItem('gone-base@ask:Z', 'Z'), MAC, 'Yes');
    expect(keys(view)).toEqual(['run it', 'ok', 'ask:answered']);
    expect(keys(view, 'u-asst')).toEqual(['ask:answered']);
  });

  const many = (w: Rig['w']): void => {
    for (let i = 0; i < 250; i++) w.lines.push(jl({ type: 'assistant', uuid: `u-x${i}`, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: `x${i}` }] } }));
  };

  it('頭からの取得で古い項目を落としたとき、落とした範囲にある札の記録は出さない。transcript に最初から無い位置の記録は末尾に出す', () => {
    const { w, view } = make();
    w.live = 'busy';
    many(w);
    view.recordAnswer('s1', permItem('u-asst@ask:A', 'A'), MAC, 'Yes');
    view.recordAnswer('s1', permItem('never-there@ask:B', 'B'), MAC, 'Yes');
    const st = view.build('s1', 'pc-b', null).state;
    expect(st.truncated).toBe(true);
    expect(st.items.filter((i) => i.ask).map((i) => i.ask!.askId)).toEqual(['B']);
    expect(st.items.at(-1)!.ask!.askId).toBe('B');
  });

  it('after が非 null で truncated のとき、落とした範囲の記録は出さず、after の位置の記録は先頭に、見る側がすでに持つ位置の記録は末尾に出す', () => {
    const { w, view } = make();
    w.live = 'busy';
    many(w);
    view.recordAnswer('s1', permItem('u-x5@ask:D', 'D'), MAC, 'Yes');
    view.recordAnswer('s1', permItem('u-asst@ask:A', 'A'), MAC, 'Yes');
    view.recordAnswer('s1', permItem('u-user@ask:E', 'E'), MAC, 'Yes');
    const st = view.build('s1', 'pc-b', 'u-asst').state;
    expect(st.truncated).toBe(true);
    const ids = st.items.filter((i) => i.ask).map((i) => i.ask!.askId);
    expect(ids).toEqual(['A', 'E']);
    expect(st.items[0]!.ask!.askId).toBe('A');
    expect(st.items.at(-1)!.ask!.askId).toBe('E');
  });
});
