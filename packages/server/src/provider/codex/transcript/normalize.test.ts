import { describe, expect, it } from 'vitest';
import { CODEX_LEGACY, CODEX_ONE_TURN, CODEX_TOOLS, fixtureRecords } from '../../../../test/codexFixtures.ts';
import { codexRecordFacts, normalizeCodexRecord, type CodexMode } from './normalize.ts';

const recs = (f: string) => fixtureRecords(f);
const ev = (r: unknown, seq = 0) => normalizeCodexRecord(r, seq, null);
const find = (rs: Record<string, any>[], type: string, sub?: string) => rs.find((r) => r.type === type && (sub === undefined || r.payload?.type === sub))!;
const filter = (rs: Record<string, any>[], type: string, sub?: string) => rs.filter((r) => r.type === type && (sub === undefined || r.payload?.type === sub));

describe('normalizeCodexRecord', () => {
  it('paginated の 1 ターン：user 1、assistant 1、tool_call と tool_result が同じ toolId。item_completed と token_count はイベントを作らない', () => {
    const rs = recs(CODEX_ONE_TURN.file);
    const events = rs.flatMap((r, i) => ev(r, i * 10));
    expect(events.filter((e) => e.kind === 'user')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'assistant')).toHaveLength(1);
    const call = events.find((e) => e.kind === 'tool_call');
    const result = events.find((e) => e.kind === 'tool_result');
    expect(call && call.kind === 'tool_call' && call.toolId).toBe('call_one');
    expect(result && result.kind === 'tool_result' && result.toolId).toBe('call_one');
    expect(result && result.kind === 'tool_result' && result.text).toBe('Script completed\na b c');
    for (const r of [...filter(rs, 'event_msg', 'item_completed'), ...filter(rs, 'event_msg', 'thread_settings_applied')]) expect(ev(r).filter((e) => e.kind !== 'meta')).toEqual([]);
    // token_count は使用量の枠だけ meta に残す。
    const tcEvents = ev(find(rs, 'event_msg', 'token_count'));
    expect(tcEvents).toHaveLength(1);
    expect(tcEvents[0]).toMatchObject({ kind: 'meta', name: 'rate_limits' });
  });

  it('注入文脈の user は system(injected_context) で isUserTurn が偽。developer はイベントなし', () => {
    const rs = recs(CODEX_ONE_TURN.file);
    const injected = rs.find((r) => r.payload?.role === 'user' && String(r.payload.content[0].text).startsWith('<environment_context>'))!;
    const e = ev(injected);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'system', subtype: 'injected_context' });
    expect(codexRecordFacts(injected, { mode: 'paginated' }).isUserTurn).toBe(false);
    const dev = rs.find((r) => r.payload?.role === 'developer')!;
    expect(ev(dev)).toEqual([]);
    expect(codexRecordFacts(dev, { mode: 'paginated' }).isUserTurn).toBe(false);
    const real = rs.find((r) => r.payload?.role === 'user' && String(r.payload.content[0].text).startsWith('List'))!;
    expect(codexRecordFacts(real, { mode: 'paginated' }).isUserTurn).toBe(true);
  });

  it('turn_aborted の注入（<turn_aborted>）も利用者の発言にしない', () => {
    const rs = recs(CODEX_TOOLS.file);
    const aborted = rs.find((r) => r.payload?.role === 'user' && String(r.payload.content[0].text).startsWith('<turn_aborted>'))!;
    expect(ev(aborted)[0]).toMatchObject({ kind: 'system', subtype: 'injected_context' });
    expect(codexRecordFacts(aborted, { mode: 'paginated' }).isUserTurn).toBe(false);
  });

  it('summary が空の reasoning はイベントなし、summary があれば thinking', () => {
    expect(ev(find(recs(CODEX_ONE_TURN.file), 'response_item', 'reasoning'))).toEqual([]);
    const e = ev(find(recs(CODEX_TOOLS.file), 'response_item', 'reasoning'));
    expect(e).toEqual([expect.objectContaining({ kind: 'thinking', text: 'Planning the edit' })]);
  });

  it('道具の名前：shell は Bash、apply_patch は Edit（filePath 付き）、mcp は mcp__server__tool、exec は tools.exec_command が 1 つだけなら Bash', () => {
    const rs = recs(CODEX_TOOLS.file);
    const calls = rs.flatMap((r) => ev(r)).filter((e) => e.kind === 'tool_call');
    const byId = Object.fromEntries(calls.map((c) => [c.kind === 'tool_call' ? c.toolId : '', c]));
    expect(byId.call_sh).toMatchObject({ name: 'Bash', input: { command: 'bash -lc echo hi', workdir: '/work/sample' }, summary: 'Bash bash -lc echo hi' });
    expect(byId.call_patch).toMatchObject({ name: 'Edit', filePath: 'src/a.ts', summary: 'Edit src/a.ts' });
    expect(byId.call_mcp).toMatchObject({ name: 'mcp__hangar__set_turn_intent', input: { intent: 'edit a' } });
    // 2 つ呼ぶ exec は exec のまま。
    expect(byId.call_two).toMatchObject({ name: 'exec' });
    const one = recs(CODEX_ONE_TURN.file).flatMap((r) => ev(r)).find((e) => e.kind === 'tool_call');
    expect(one).toMatchObject({ name: 'Bash', input: { command: 'ls -la' }, summary: 'Bash ls -la' });
  });

  it('tool_result の isError は先頭の文字列で見分ける', () => {
    const rs = recs(CODEX_TOOLS.file);
    const results = rs.flatMap((r) => ev(r)).filter((e) => e.kind === 'tool_result');
    const byId = Object.fromEntries(results.map((r) => [r.kind === 'tool_result' ? r.toolId : '', r]));
    expect(byId.call_mcp).toMatchObject({ isError: true });
    expect(byId.call_sh).toMatchObject({ isError: false, text: 'hi' });
  });

  it('task_complete は system(turn_duration)、turn_aborted は system(turn_aborted)', () => {
    const one = ev(find(recs(CODEX_ONE_TURN.file), 'event_msg', 'task_complete'));
    expect(one).toEqual([expect.objectContaining({ kind: 'system', subtype: 'turn_duration', text: '5.7' })]);
    const ab = ev(find(recs(CODEX_TOOLS.file), 'event_msg', 'turn_aborted'));
    expect(ab).toEqual([expect.objectContaining({ kind: 'system', subtype: 'turn_aborted', text: 'interrupted' })]);
  });

  it('world_state と additional_tools はイベントを作らず、巨大な行でも中身を読まない', () => {
    const huge = 'x'.repeat(5_000_000);
    const t0 = Date.now();
    expect(ev({ timestamp: '2026-10-26T00:00:00Z', type: 'world_state', payload: { state: { huge } } })).toEqual([]);
    expect(ev({ timestamp: '2026-10-26T00:00:00Z', type: 'response_item', payload: { type: 'additional_tools', tools: [{ huge }] } })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('知らない type は meta に 1KB 以内で残り、落ちない。壊れた形（payload なし）も落ちない', () => {
    const e = ev({ timestamp: '2026-10-26T00:00:00Z', type: 'brand_new', payload: { type: 'thing', a: 'y'.repeat(5000), b: { c: 1 }, n: 3 } });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'meta', name: 'brand_new:thing' });
    expect(JSON.stringify((e[0] as { value: unknown }).value).length).toBeLessThanOrEqual(1024);
    expect(() => ev({ type: 'response_item' })).not.toThrow();
    expect(() => ev(null)).not.toThrow();
    expect(ev('str')).toEqual([]);
  });

  it('session_meta と turn_context は meta にし、base_instructions など大きい付随物を捨てる', () => {
    const rs = recs(CODEX_ONE_TURN.file);
    const sm = ev(find(rs, 'session_meta'))[0] as { kind: string; name: string; value: Record<string, unknown> };
    expect(sm).toMatchObject({ kind: 'meta', name: 'session_meta' });
    expect(JSON.stringify(sm.value)).not.toContain('placeholder instructions');
    expect(sm.value).toMatchObject({ cwd: '/work/sample', history_mode: 'paginated' });
    const tc = ev(find(rs, 'turn_context'))[0] as { value: Record<string, unknown> };
    expect(tc.value).toMatchObject({ model: 'test-model', effort: 'low', cwd: '/work/sample' });
    expect(tc.value).not.toHaveProperty('permission_profile');
  });

  it('compacted は system(compacted) で replacement_history を捨てる', () => {
    const e = ev({ timestamp: '2026-10-26T00:00:00Z', type: 'compacted', payload: { message: 'summary text', replacement_history: [{ big: 'x'.repeat(10000) }] } });
    expect(e).toEqual([expect.objectContaining({ kind: 'system', subtype: 'compacted', text: 'summary text' })]);
  });

  it('seq は先頭から数えて、1 行から出る複数のイベントで続く', () => {
    const e = ev({ timestamp: '2026-10-26T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'data:' }] } }, 7);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'user', seq: 7, text: 'hi', attachments: [{ kind: 'image' }] });
  });
});

describe('codexRecordFacts と二重の数え', () => {
  const sum = (rs: Record<string, any>[], mode: CodexMode) => {
    let input = 0; let output = 0;
    for (const r of rs) { const u = codexRecordFacts(r, { mode }).usage; if (u) { input += u.input; output += u.output; } }
    return { input, output };
  };

  it('paginated：usage は token_usage_record の（input − cached、output）で、token_count からは足さない。合計が thread_token_usage と一致する', () => {
    const rs = recs(CODEX_ONE_TURN.file);
    expect(sum(rs, 'paginated')).toEqual({ input: 1200, output: 70 });
    const last = filter(rs, 'token_usage_record').at(-1)!.payload.thread_token_usage;
    expect(sum(rs, 'paginated')).toEqual({ input: last.input_tokens - last.cached_input_tokens, output: last.output_tokens });
    expect(codexRecordFacts(find(rs, 'event_msg', 'token_count'), { mode: 'paginated' }).usage).toBeUndefined();
    expect(codexRecordFacts(find(rs, 'token_usage_record'), { mode: 'paginated' }).contextTokens).toBe(1000);
  });

  it('paginated の 2 ターン（中断を含む）でも合計が thread_token_usage と一致する', () => {
    const rs = recs(CODEX_TOOLS.file);
    expect(sum(rs, 'paginated')).toEqual({ input: 900 + 200, output: 70 });
  });

  it('legacy（合成）：usage は token_count の last から。user_message、agent_message、agent_reasoning はイベントなしで、発話が 1 回ずつ', () => {
    const rs = recs(CODEX_LEGACY.file);
    expect(sum(rs, 'legacy')).toEqual({ input: 400, output: 30 });
    for (const sub of ['user_message', 'agent_message', 'agent_reasoning', 'exec_command_end']) expect(ev(find(rs, 'event_msg', sub))).toEqual([]);
    const events = rs.flatMap((r) => ev(r));
    expect(events.filter((e) => e.kind === 'user')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'assistant')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'thinking')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'tool_call')).toMatchObject({ name: 'Bash', toolId: 'call_ls', input: { command: 'ls -l' } });
    // 注入文脈（<user_instructions>）は利用者の発言にならない。
    expect(rs.filter((r) => codexRecordFacts(r, { mode: 'legacy' }).isUserTurn)).toHaveLength(1);
  });

  it('turn_context の model と effort が modelSelected で入り、cwd は session_meta と turn_context と thread_settings_applied から入る。task_started が contextSize を持つ', () => {
    const rs = recs(CODEX_TOOLS.file);
    const tcs = filter(rs, 'turn_context').map((r) => codexRecordFacts(r, { mode: 'paginated' }));
    expect(tcs[0]).toMatchObject({ model: 'model-a', effort: 'low', modelSelected: true, cwd: '/work/sample' });
    expect(tcs[1]).toMatchObject({ model: 'model-b', effort: 'high', modelSelected: true });
    expect(codexRecordFacts(find(rs, 'session_meta'), { mode: 'paginated' }).cwd).toBe('/work/sample');
    expect(codexRecordFacts(find(rs, 'event_msg', 'thread_settings_applied'), { mode: 'paginated' }).cwd).toBe('/work/sample/sub');
    expect(codexRecordFacts(find(rs, 'event_msg', 'task_started'), { mode: 'paginated' }).contextSize).toBe(200000);
  });

  it('題名の元は、最初の isUserTurn の行が実際の入力になる（注入文脈ではない）', () => {
    const rs = recs(CODEX_ONE_TURN.file);
    const first = rs.find((r) => codexRecordFacts(r, { mode: 'paginated' }).isUserTurn)!;
    expect(ev(first)[0]).toMatchObject({ kind: 'user', text: 'List the files please' });
  });
});
