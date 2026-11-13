import { describe, expect, it } from 'vitest';
import { translator, type LiveSessionDto, type TranscriptEvent } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { orchestratorRows, presentOrchestrator } from './orchestrator.ts';

const ja = translator('ja');
let seq = 0;
const user = (text: string): TranscriptEvent => ({ kind: 'user', seq: ++seq, text });
const ai = (text: string): TranscriptEvent => ({ kind: 'assistant', seq: ++seq, text });
const notify = (text: string): TranscriptEvent => ({ kind: 'tool_call', seq: ++seq, toolId: `t${seq}`, name: 'mcp__hangar__notify_user', input: { text }, summary: '' });
const result = (toolId: string, isError = false): TranscriptEvent => ({ kind: 'tool_result', seq: ++seq, toolId, text: '', isError });
const notifyOk = (text: string): TranscriptEvent[] => { const c = notify(text); return [c, result((c as { toolId: string }).toolId)]; };
const other = (): TranscriptEvent => ({ kind: 'tool_call', seq: ++seq, toolId: `t${seq}`, name: 'mcp__hangar__list_sessions', input: {}, summary: '' });

describe('orchestratorRows', () => {
  it('[hangar] で始まる入力は発言として描かず、その返答も描かない', () => {
    const r = orchestratorRows([user('[hangar] 許可待ちが 1 件'), ai('了解、片付けました'), user('進み具合は'), ai('順調です')]);
    expect(r.rows.map((x) => (x.kind === 'user' || x.kind === 'assistant' ? x.text : x.kind))).toEqual(['進み具合は', '順調です']);
  });
  it('[voice] の印は描かない', () => {
    const r = orchestratorRows([user('[voice] 進み具合を教えて'), ai('順調です')]);
    expect(r.rows[0]).toMatchObject({ kind: 'user', text: '進み具合を教えて' });
  });
  it('出来事で始まったターンでも、notify_user の文は統括の発言として描く。ほかの道具は描かない', () => {
    const r = orchestratorRows([user('[hangar] 許可待ちが 1 件'), other(), ...notifyOk('判断をお願いします'), ai('伝えました')]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ kind: 'assistant', text: '判断をお願いします' });
  });
  it('失敗した notify_user の呼び出しは描かず、読み上げにも入れない（再試行で同じ文が重ならない）', () => {
    const bad = notify('判断をお願いします');
    const good = notify('判断をお願いします');
    const r = orchestratorRows([user('[hangar] 許可待ち'), bad, result((bad as { toolId: string }).toolId, true), good, result((good as { toolId: string }).toolId)]);
    expect(r.rows).toHaveLength(1);
    expect(r.speak.notices).toHaveLength(1);
  });
  it('結果がまだ来ない notify_user は、来るまで描かない', () => {
    const r = orchestratorRows([user('[hangar] 許可待ち'), notify('判断をお願いします')]);
    expect(r.rows).toHaveLength(0);
  });
  it('読むのは、音声で始まったターンの最後の返答と、出来事で始まったターンの notify_user の文だけ', () => {
    const voice = orchestratorRows([user('[voice] 状況は'), ai('途中です'), ai('順調です')]);
    expect(voice.speak.reply).toMatchObject({ text: '順調です' });
    expect(voice.speak.notices).toEqual([]);
    const typed = orchestratorRows([user('状況は'), ai('順調です')]);
    expect(typed.speak.reply).toBeNull();
    const event = orchestratorRows([user('[hangar] 許可待ち'), ai('片付けました'), ...notifyOk('判断をお願いします')]);
    expect(event.speak.reply).toBeNull();
    expect(event.speak.notices.map((n) => n.text)).toEqual(['判断をお願いします']);
  });
  it('最後のターンが音声でなければ、前の音声のターンの返答は読まない', () => {
    const r = orchestratorRows([user('[voice] 状況は'), ai('順調です'), user('文字で聞く'), ai('はい')]);
    expect(r.speak.reply).toBeNull();
    expect(r.speak.voiceOn).toBe(false);
  });
  it('音声で始まったターンがあれば voiceOn', () => {
    expect(orchestratorRows([user('[voice] a'), ai('b')]).speak.voiceOn).toBe(true);
  });
});

const live = (status: LiveSessionDto['status']): LiveSessionDto => ({ sessionId: 'o1', status, name: null, nameSource: null, cwd: '/h', pid: 1, role: 'orchestrator' });
function store(over: { enabled?: boolean; sessionId?: string | null; live?: LiveSessionDto[]; policy?: string | null; events?: TranscriptEvent[]; approvals?: Store['orchestrator']['approvals'] } = {}): Store {
  const s = initialStore();
  s.settings = { orchestrator: { enabled: over.enabled ?? true, sessionId: over.sessionId === undefined ? 'o1' : over.sessionId, model: 'sonnet', effort: 'medium' }, permissionPolicy: over.policy ? { text: over.policy, autoTools: ['Read'], updatedAt: 1 } : null } as Store['settings'];
  s.live = over.live ?? [live('idle')];
  s.orchestrator = { events: over.events ?? [], approvals: over.approvals ?? [], loaded: true, sending: false };
  return s;
}

describe('presentOrchestrator', () => {
  it('無効か、会話がまだ無ければ柱を出さない', () => {
    expect(presentOrchestrator(store({ enabled: false }), ja)).toBeNull();
    expect(presentOrchestrator(store({ sessionId: null }), ja)).toBeNull();
  });
  it('止まっている（動いている会話が無い）ときは入力欄が送れない', () => {
    const p = presentOrchestrator(store({ live: [] }), ja)!;
    expect(p.tone).toBe('ended');
    expect(p.canSend).toBe(false);
    expect(presentOrchestrator(store({ live: [live('idle')] }), ja)!.canSend).toBe(true);
    expect(presentOrchestrator(store({ live: [live('busy')] }), ja)!.tone).toBe('busy');
  });
  it('方針の 1 行は利用者の言葉のまま。無ければ null', () => {
    expect(presentOrchestrator(store({ policy: '読むだけなら通す' }), ja)!.policy).toBe('読むだけなら通す');
    expect(presentOrchestrator(store(), ja)!.policy).toBeNull();
  });
  it('記録の行は 会話の題名 / 道具 / 中身の先頭 で、押す先の会話を持つ', () => {
    const p = presentOrchestrator(store({ approvals: [{ id: 'a1', at: 5, sessionId: 's9', title: '調べもの', tool: 'Read', input: '/a/b/c.ts\nつづき', label: 'Yes', reason: '読むだけ', policyText: null }] }), ja)!;
    expect(p.approvals).toEqual([{ id: 'a1', sessionId: 's9', title: '調べもの', tool: 'Read', head: '/a/b/c.ts' }]);
  });
});
