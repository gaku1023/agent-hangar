import { describe, expect, it } from 'vitest';
import { indexTexts, isTypedPrompt, normalizeRecord, recordFacts, toolSummary } from './normalize.ts';

const base = { uuid: 'u', parentUuid: null, isSidechain: false, timestamp: '2026-09-01T10:00:00.000Z', cwd: '/Users/me/workspace/alpha', sessionId: 'aaaa' };

describe('normalizeRecord', () => {
  it('文字列 content の user は user 1 件', () => {
    const ev = normalizeRecord({ ...base, type: 'user', message: { role: 'user', content: 'こんにちは' } }, 5, null);
    expect(ev).toEqual([{ kind: 'user', seq: 5, ts: Date.parse(base.timestamp), text: 'こんにちは' }]);
  });
  it('isMeta の user は system', () => {
    const ev = normalizeRecord({ ...base, type: 'user', isMeta: true, message: { role: 'user', content: '<caveat/>' } }, 0, null);
    expect(ev[0]!.kind).toBe('system');
  });
  it('スラッシュコマンドの記録は isMeta が無くても system', () => {
    const ev = normalizeRecord({ ...base, type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name><command-message>clear</command-message>' } }, 0, null);
    expect(ev).toEqual([{ kind: 'system', seq: 0, ts: Date.parse(base.timestamp), text: '<command-name>/clear</command-name><command-message>clear</command-message>' }]);
  });
  it('! で打ったシェルの記録とタスクの知らせは、利用者の発言ではないので system', () => {
    for (const text of ['<bash-input> git status</bash-input>', '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>', '<task-notification>\n<summary>Agent "x" finished</summary>\n</task-notification>']) {
      expect(normalizeRecord({ ...base, type: 'user', message: { role: 'user', content: text } }, 0, null)[0]!.kind).toBe('system');
      expect(recordFacts({ ...base, type: 'user', message: { role: 'user', content: text } }).isUserTurn).toBe(false);
    }
  });
  it('ローカルコマンドの出力も system', () => {
    const ev = normalizeRecord({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '  <local-command-stdout>ok</local-command-stdout>' }] } }, 0, null);
    expect(ev[0]!.kind).toBe('system');
    expect(ev).toHaveLength(1);
  });
  it('text と image を持つ user は attachments 付きの user 1 件', () => {
    const ev = normalizeRecord({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'これを見て' }, { type: 'image', source: {} }] } }, 0, null);
    expect(ev).toEqual([{ kind: 'user', seq: 0, ts: Date.parse(base.timestamp), text: 'これを見て', attachments: [{ kind: 'image' }] }]);
  });
  it('tool_result は 1 件ずつ、is_error を写す', () => {
    const ev = normalizeRecord({ ...base, type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'File not found' }], is_error: true },
    ] } }, 3, null);
    expect(ev).toEqual([
      { kind: 'tool_result', seq: 3, ts: Date.parse(base.timestamp), toolId: 't1', text: 'ok', isError: false },
      { kind: 'tool_result', seq: 4, ts: Date.parse(base.timestamp), toolId: 't2', text: 'File not found', isError: true },
    ]);
  });
  it('assistant のブロックを種別ごとに分ける', () => {
    const ev = normalizeRecord({ ...base, type: 'assistant', effort: 'high', message: { role: 'assistant', model: 'claude-fable-5-1', content: [
      { type: 'thinking', thinking: '考える', signature: 'x' },
      { type: 'text', text: '返事' },
      { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' } },
    ] } }, 0, null);
    expect(ev.map((e) => e.kind)).toEqual(['thinking', 'assistant', 'tool_call']);
    expect(ev[1]).toMatchObject({ text: '返事', model: 'claude-fable-5-1' });
    expect(ev[2]).toMatchObject({ toolId: 'toolu_1', name: 'Edit', summary: 'Edit /a/b.ts', filePath: '/a/b.ts' });
  });
  it('作業中に打った指示（queued_command）は user にする', () => {
    const rec = { ...base, type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: '作業中に打った指示' } };
    expect(normalizeRecord(rec, 3, null)).toEqual([{ kind: 'user', seq: 3, ts: Date.parse(base.timestamp), text: '作業中に打った指示' }]);
  });
  it('作業中に打った指示が配列でも本文を拾う', () => {
    const rec = { ...base, type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', humanTurn: true, origin: { kind: 'human' }, prompt: [{ type: 'text', text: '画像つき' }, { type: 'image', source: {} }] } };
    expect(normalizeRecord(rec, 3, null)).toMatchObject([{ kind: 'user', text: '画像つき' }]);
  });
  it('人でない queued_command（タスクの知らせ、サブエージェントの報告）は user にしない', () => {
    const task = { ...base, type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>…' } };
    const peer = { ...base, type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'peer', from: 'a1' }, prompt: '報告' } };
    expect(normalizeRecord(task, 0, null)[0]!.kind).toBe('meta');
    expect(normalizeRecord(peer, 0, null)[0]!.kind).toBe('meta');
  });
  it('本文の無い system は subtype を本文にする', () => {
    const ev = normalizeRecord({ ...base, type: 'system', subtype: 'turn_duration', durationMs: 10 }, 0, null);
    expect(ev).toEqual([{ kind: 'system', seq: 0, ts: Date.parse(base.timestamp), text: 'turn_duration', subtype: 'turn_duration' }]);
  });
  it('本文のある system は content を本文にする', () => {
    const ev = normalizeRecord({ ...base, type: 'system', subtype: 'away_summary', content: '留守の間の要約' }, 0, null);
    expect(ev).toEqual([{ kind: 'system', seq: 0, ts: Date.parse(base.timestamp), text: '留守の間の要約', subtype: 'away_summary' }]);
  });
  it('知らない type は meta として保持する', () => {
    const ev = normalizeRecord({ type: 'ai-title', aiTitle: '題名', sessionId: 'aaaa' }, 7, null);
    expect(ev).toEqual([{ kind: 'meta', seq: 7, ts: undefined, name: 'ai-title', value: { aiTitle: '題名' } }]);
  });
  it('オブジェクトでなければ空', () => {
    expect(normalizeRecord('x', 0, null)).toEqual([]);
    expect(normalizeRecord(null, 0, null)).toEqual([]);
  });
});

describe('toolSummary', () => {
  it('ファイルパス、コマンドの 1 行目、パターン、説明の順で選ぶ', () => {
    expect(toolSummary('Edit', { file_path: '/a.ts' })).toBe('Edit /a.ts');
    expect(toolSummary('Bash', { command: 'ls -la\nwc -l', description: 'List' })).toBe('Bash ls -la');
    expect(toolSummary('Grep', { pattern: 'foo' })).toBe('Grep foo');
    expect(toolSummary('Agent', { description: 'Survey', prompt: '...' })).toBe('Agent Survey');
    expect(toolSummary('Skill', { skill: 'grilling' })).toBe('Skill grilling');
    expect(toolSummary('Nothing', {})).toBe('Nothing');
    expect(toolSummary('Bash', { command: 'x'.repeat(300) })).toHaveLength('Bash '.length + 120);
  });
});

describe('recordFacts', () => {
  it('作業中に打った指示もターンに数え、タスクの知らせは数えない', () => {
    expect(recordFacts({ ...base, type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: '続けて' } }).isUserTurn).toBe(true);
    expect(recordFacts({ ...base, type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: 'x' } }).isUserTurn).toBe(false);
  });
  it('形だけの返事の <synthetic> はモデルとして拾わない', () => {
    expect(recordFacts({ ...base, type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }).model).toBeUndefined();
  });
  it('assistant からモデル、effort、トークンを取る', () => {
    const f = recordFacts({ ...base, type: 'assistant', effort: 'high', message: { role: 'assistant', model: 'claude-fable-5-1', content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 } } });
    expect(f).toEqual({ cwd: '/Users/me/workspace/alpha', ts: Date.parse(base.timestamp), model: 'claude-fable-5-1', effort: 'high', usage: { input: 1110, output: 20 }, isUserTurn: false });
  });
  it('メタ行から題名と名前と PR を取る', () => {
    expect(recordFacts({ type: 'ai-title', aiTitle: 'A' })).toMatchObject({ aiTitle: 'A' });
    expect(recordFacts({ type: 'custom-title', customTitle: 'B' })).toMatchObject({ customTitle: 'B' });
    expect(recordFacts({ type: 'agent-name', agentName: 'C' })).toMatchObject({ agentName: 'C' });
    expect(recordFacts({ type: 'pr-link', prUrl: 'https://x/pull/1' })).toMatchObject({ prUrl: 'https://x/pull/1' });
  });
  it('isUserTurn は本文のある user だけ', () => {
    expect(recordFacts({ ...base, type: 'user', message: { role: 'user', content: 'x' } }).isUserTurn).toBe(true);
    expect(recordFacts({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }).isUserTurn).toBe(true);
    expect(recordFacts({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }).isUserTurn).toBe(false);
    expect(recordFacts({ ...base, type: 'user', isMeta: true, message: { role: 'user', content: 'x' } }).isUserTurn).toBe(false);
  });
  it('スラッシュコマンドとローカルコマンドの記録は isUserTurn にしない', () => {
    for (const text of [
      '<command-name>/clear</command-name><command-message>clear</command-message>',
      '<command-message>clear</command-message>',
      '<command-args>x</command-args>',
      '<local-command-caveat>c</local-command-caveat>',
      '<local-command-stdout>out</local-command-stdout>',
      '<system-reminder>r</system-reminder>',
    ]) {
      expect(recordFacts({ ...base, type: 'user', message: { role: 'user', content: text } }).isUserTurn).toBe(false);
      expect(recordFacts({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }).isUserTurn).toBe(false);
    }
    // 途中にタグがあるだけの本文は普通の依頼として扱う。
    expect(recordFacts({ ...base, type: 'user', message: { role: 'user', content: 'see <command-name>x</command-name>' } }).isUserTurn).toBe(true);
  });
});

describe('indexTexts', () => {
  it('user と assistant の本文、tool_call の要約とコマンドだけを返す', () => {
    const texts = indexTexts([
      { kind: 'user', seq: 0, text: 'u' },
      { kind: 'assistant', seq: 1, text: 'a' },
      { kind: 'thinking', seq: 2, text: 'th' },
      { kind: 'tool_call', seq: 3, toolId: 't', name: 'Bash', input: { command: 'ls -la\nwc -l' }, summary: 'Bash ls -la' },
      { kind: 'tool_result', seq: 4, toolId: 't', text: 'result', isError: false },
      { kind: 'meta', seq: 5, name: 'ai-title', value: {} },
    ]);
    expect(texts).toEqual([
      { seq: 0, role: 'user', text: 'u' },
      { seq: 1, role: 'assistant', text: 'a' },
      { seq: 3, role: 'tool', text: 'Bash ls -la\nls -la\nwc -l' },
    ]);
  });
});

describe('Agent の結果', () => {
  const rec = (toolUseResult?: unknown) => ({
    type: 'user', timestamp: '2026-10-01T01:00:03.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }] },
    ...(toolUseResult === undefined ? {} : { toolUseResult }),
  });
  it('バックグラウンドで起こした Agent の結果に agentId を残す', () => {
    const [ev] = normalizeRecord(rec({ agentId: 'a020716d1a6ca2caa', status: 'async_launched', isAsync: true }), 0, null);
    expect(ev).toMatchObject({ kind: 'tool_result', toolId: 'toolu_1', agentLaunch: { agentId: 'a020716d1a6ca2caa', async: true } });
  });
  it('前面で終わった結果は async を偽にする', () => {
    const [ev] = normalizeRecord(rec({ agentId: 'b1', status: 'completed' }), 0, null);
    expect(ev).toMatchObject({ agentLaunch: { agentId: 'b1', async: false } });
  });
  it('toolUseResult が無い、または agentId を持たない結果には付けない', () => {
    expect(normalizeRecord(rec(), 0, null)[0]).not.toHaveProperty('agentLaunch');
    expect(normalizeRecord(rec({ stdout: 'x' }), 0, null)[0]).not.toHaveProperty('agentLaunch');
    expect(normalizeRecord(rec('text'), 0, null)[0]).not.toHaveProperty('agentLaunch');
  });
});

describe('isTypedPrompt', () => {
  const user = (content: unknown, over: Record<string, unknown> = {}) => ({ ...base, type: 'user', message: { role: 'user', content }, ...over });
  it('打った発言と、作業中に打って積まれた指示は true', () => {
    expect(isTypedPrompt(user('直して'))).toBe(true);
    expect(isTypedPrompt(user([{ type: 'text', text: 'これも' }, { type: 'image', source: {} }]))).toBe(true);
    expect(isTypedPrompt({ ...base, type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: '続けて' } })).toBe(true);
  });
  it('AskUserQuestion の答え（ツールの結果）は false', () => {
    expect(isTypedPrompt(user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'User has answered your questions: "このセッションをどうしますか"="Done にする".' }]))).toBe(false);
  });
  it('要約で続けた会話の頭、中断の印、meta、コマンドの記録、assistant は false', () => {
    expect(isTypedPrompt(user('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true, isVisibleInTranscriptOnly: true }))).toBe(false);
    expect(isTypedPrompt(user([{ type: 'text', text: '[Request interrupted by user]' }]))).toBe(false);
    expect(isTypedPrompt(user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))).toBe(false);
    expect(isTypedPrompt(user('<caveat/>', { isMeta: true }))).toBe(false);
    expect(isTypedPrompt(user('<command-name>/clear</command-name>'))).toBe(false);
    expect(isTypedPrompt({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'はい' }] } })).toBe(false);
  });
  it('すでに読んだ facts を渡せる。渡した facts を信じる', () => {
    const raw = user('直して');
    expect(isTypedPrompt(raw, recordFacts(raw))).toBe(true);
    expect(isTypedPrompt(raw, { isUserTurn: false })).toBe(false);
  });
});
