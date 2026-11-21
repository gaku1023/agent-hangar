import { describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { HookDecisions } from './hookDecisions.ts';

const live = (over: Partial<LiveSessionDto>): LiveSessionDto => ({ sessionId: 'u1', status: 'waiting', name: null, nameSource: null, cwd: '/w', pid: 1, ...over });
const bash = { providerSessionId: 'u1', tool: 'Bash', input: 'npm test', toolInput: { command: 'npm test' }, suggestions: [] as unknown[] };
const askUq = { providerSessionId: 'u1', tool: 'AskUserQuestion', input: '', toolInput: { questions: [{ question: 'Which color?', multiSelect: false, options: [{ label: 'Red' }] }] }, suggestions: [] as unknown[] };
const permAsk = { kind: 'permission' as const, tool: 'Bash', input: 'npm test' };
const qAsk = { kind: 'question' as const, tool: 'AskUserQuestion', input: 'Which color?' };
const out = (decision: unknown) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });

describe('HookDecisions', () => {
  it('許可の Yes は allow、No は interrupt つきの deny で、待っている台本に返す', async () => {
    const d = new HookDecisions();
    const id = d.open('s1', bash);
    const w = d.wait('s1', id, 1000);
    expect(d.decide('s1', permAsk, { kind: 'permission', behavior: 'allow' })).toEqual({ id });
    expect(await w).toEqual({ t: 'answer', output: out({ behavior: 'allow' }) });
    const id2 = d.open('s1', bash);
    d.decide('s1', permAsk, { kind: 'permission', behavior: 'deny' });
    const r = await d.wait('s1', id2, 1000);
    expect(r).toMatchObject({ t: 'answer', output: out({ behavior: 'deny', interrupt: true }) });
  });

  it('台本が待っていない間に決めても、次の待ちが受け取る。受け取ったら delivered', async () => {
    const d = new HookDecisions();
    const id = d.open('s1', bash);
    d.decide('s1', permAsk, { kind: 'permission', behavior: 'allow' });
    expect(d.isDelivered(id)).toBe(false);
    expect((await d.wait('s1', id, 1000)).t).toBe('answer');
    expect(d.isDelivered(id)).toBe(true);
    expect(await d.wait('s1', id, 10)).toEqual({ t: 'gone' });
  });

  it('決まらないまま待ちが切れたら pending を返す（台本は繰り返す）', async () => {
    const d = new HookDecisions();
    const id = d.open('s1', bash);
    expect(await d.wait('s1', id, 20)).toEqual({ t: 'pending' });
  });

  it('知らない id と別のセッションの id は gone', async () => {
    const d = new HookDecisions();
    const id = d.open('s1', bash);
    expect(await d.wait('s1', 'nope', 10)).toEqual({ t: 'gone' });
    expect(await d.wait('s2', id, 10)).toEqual({ t: 'gone' });
  });

  it('質問は、問いの文をキーにした answers を updatedInput に入れる（1 問だけ）', async () => {
    const d = new HookDecisions();
    const id = d.open('s1', askUq);
    expect(d.decide('s1', qAsk, { kind: 'question', value: 'Red' })).toEqual({ id });
    expect(await d.wait('s1', id, 100)).toEqual({ t: 'answer', output: out({ behavior: 'allow', updatedInput: { questions: askUq.toolInput.questions, answers: { 'Which color?': 'Red' } } }) });
  });

  it('問いが 2 つ以上の質問、別の問い、別のツール、種類違いには決めない', () => {
    const d = new HookDecisions();
    d.open('s1', { ...askUq, toolInput: { questions: [{ question: 'a' }, { question: 'b' }] } });
    expect(d.decide('s1', qAsk, { kind: 'question', value: 'x' })).toBeNull();
    d.open('s1', askUq);
    expect(d.decide('s1', { ...qAsk, input: 'Other?' }, { kind: 'question', value: 'x' })).toBeNull();
    expect(d.decide('s1', { kind: 'permission', tool: 'Bash', input: 'rm -rf /' }, { kind: 'permission', behavior: 'allow' })).toBeNull();
    expect(d.decide('s1', permAsk, { kind: 'question', value: 'x' })).toBeNull();
    d.open('s1', bash);
    expect(d.decide('s1', { ...permAsk, tool: 'Edit' }, { kind: 'permission', behavior: 'allow' })).toBeNull();
    expect(d.decide('s2', permAsk, { kind: 'permission', behavior: 'allow' })).toBeNull();
  });

  it('決めた待ちに 2 度は決めない。取り下げれば、台本には渡らず pending に戻る', async () => {
    const d = new HookDecisions();
    const id = d.open('s1', bash);
    d.decide('s1', permAsk, { kind: 'permission', behavior: 'allow' });
    expect(d.decide('s1', permAsk, { kind: 'permission', behavior: 'deny' })).toBeNull();
    d.withdraw(id);
    expect(await d.wait('s1', id, 20)).toEqual({ t: 'pending' });
    expect(d.decide('s1', permAsk, { kind: 'permission', behavior: 'deny' })).toEqual({ id });
  });

  it('画面で先に答えられたら（PostToolUse、closeTool）待っている台本を gone で抜けさせる', async () => {
    const d = new HookDecisions();
    const id = d.open('s1', askUq);
    const w = d.wait('s1', id, 5000);
    d.closeTool('s1', 'AskUserQuestion');
    expect(await w).toEqual({ t: 'gone' });
    expect(d.decide('s1', qAsk, { kind: 'question', value: 'Red' })).toBeNull();
  });

  it('登録が待ちを抜けたら閉じる。待ちを見る前の届き順では閉じない', async () => {
    const d = new HookDecisions();
    const id = d.open('s1', bash);
    const w = d.wait('s1', id, 5000);
    d.apply([live({ status: 'busy' })], 1000);
    expect(d.decide('s1', permAsk, { kind: 'permission', behavior: 'allow' })).toEqual({ id });
    expect(await w).toMatchObject({ t: 'answer' });
    const id2 = d.open('s1', bash);
    d.apply([live({ status: 'waiting', waitingFor: 'permission' })], 1000);
    const w2 = d.wait('s1', id2, 5000);
    d.apply([live({ status: 'busy' })], 2000);
    expect(await w2).toEqual({ t: 'gone' });
  });

  it('会話が一覧から消えて 30 秒たったら（run が終わった）閉じる', async () => {
    const d = new HookDecisions({ now: () => 0 });
    const id = d.open('s1', bash);
    d.apply([], 10_000);
    expect(d.decide('s1', permAsk, { kind: 'permission', behavior: 'allow' })).toEqual({ id });
    d.withdraw(id);
    d.apply([], 31_000);
    expect(await d.wait('s1', id, 10)).toEqual({ t: 'gone' });
  });

  it('closeSession は、そのセッションの待ち全部を閉じる', async () => {
    const d = new HookDecisions();
    const a = d.open('s1', bash);
    const b = d.open('s2', bash);
    d.closeSession('s1');
    expect(await d.wait('s1', a, 10)).toEqual({ t: 'gone' });
    expect((await d.wait('s2', b, 10)).t).toBe('pending');
  });

  it('待ちを開けたことを onOpen で知らせる', () => {
    let n = 0;
    new HookDecisions({ onOpen: () => { n++; } }).open('s1', bash);
    expect(n).toBe(1);
  });
});
