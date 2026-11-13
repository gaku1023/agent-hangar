import type { LiveSessionDto, PeerChatAsk, PermissionPolicy } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import type { AnswerResult } from '../peer/chat/answer.ts';
import { createOrchestratorAsks, ORCHESTRATOR_POLICY_RATE } from './asks.ts';
import { listAutoApprovals } from './autoApprovals.ts';

/**
 * 統括の許可の道具の芯（list_pending_asks と answer_ask の中身）。
 * 画面へのキー入力は偽の口（local）に置き換え、何が打たれたかだけを見る。
 */

const OPTIONS = [
  { key: '1', label: 'Yes' },
  { key: '2', label: "Yes, and don't ask again for: cat *" },
  { key: '3', label: 'No' },
];

type World = {
  db: Db;
  live: LiveSessionDto[];
  asks: Map<string, PeerChatAsk>;
  typed: { sessionId: string; askId: string; keys: string[]; text?: string }[];
  result: AnswerResult;
  policy: PermissionPolicy | null;
  userTurn: boolean;
  limited: number;
  now: number;
};

let w: World;
const svc = () => createOrchestratorAsks({
  db: w.db,
  live: () => w.live,
  local: {
    currentAsk: (sessionId) => w.asks.get(sessionId) ?? null,
    answer: async (sessionId, askId, keys, text) => {
      w.typed.push({ sessionId, askId, keys, ...(text !== undefined ? { text } : {}) });
      const r = w.result;
      // 打てた答えは札を閉じる。
      if (r.ok) w.asks.delete(sessionId);
      return r;
    },
  },
  policy: () => w.policy,
  userTurn: () => w.userTurn,
  onRateLimited: () => { w.limited++; },
  now: () => w.now,
});

function addSession(id: string, provider: string, providerId: string, title: string): void {
  w.db.prepare('insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device, custom_title) values (?, ?, ?, ?, ?, 1, ?, ?)').run(id, provider, providerId, '/w', 'd', 'd', title);
}
const waiting = (sessionId: string, over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId, status: 'waiting', name: null, nameSource: null, cwd: '/w', pid: 1, statusAt: 100, waitingFor: 'permission', ...over });
const permAsk = (askId: string, tool: string, input: string): PeerChatAsk => ({ askId, kind: 'permission', tool, input, options: OPTIONS, multi: false, allowText: false });

beforeEach(() => {
  w = { db: openDb(':memory:'), live: [], asks: new Map(), typed: [], result: { ok: true, label: 'Yes' }, policy: null, userTurn: true, limited: 0, now: 1_000_000 };
  addSession('orch', 'claude-code', 'u-orch', '統括');
  addSession('s1', 'claude-code', 'u-s1', 'ログイン修正');
  addSession('s2', 'codex', 't-s2', 'Codex の会話');
  addSession('s3', 'opencode', 'o-s3', 'opencode の会話');
  w.live = [
    waiting('u-orch', { permission: { tool: 'Read', input: '/etc/hosts', description: null } }),
    waiting('u-s1', { permission: { tool: 'Read', input: '/w/a.txt', description: 'read a' } }),
    waiting('t-s2', { agent: 'codex', permission: { tool: 'Bash', input: 'ls', description: null } }),
    waiting('o-s3', { agent: 'opencode', permission: { tool: 'bash', input: 'ls', description: null } }),
  ];
  w.asks.set('orch', permAsk('peer-orch', 'Read', '/etc/hosts'));
  w.asks.set('s1', permAsk('peer-s1', 'Read', '/w/a.txt'));
});

const askOf = (sessionId: string) => svc().list('orch').asks.find((a) => a.session_id === sessionId)!;

describe('list_pending_asks', () => {
  it('統括自身の会話は載らない', () => {
    const { asks } = svc().list('orch');
    expect(asks.map((a) => a.session_id).sort()).toEqual(['s1', 's2', 's3']);
  });
  it('Claude Code の札は答えられ、Codex と opencode は answerable: false', () => {
    const { asks } = svc().list('orch');
    expect(asks.find((a) => a.session_id === 's1')).toMatchObject({ title: 'ログイン修正', kind: 'permission', tool: 'Read', input: '/w/a.txt', description: 'read a', answerable: true, since: 100, options: OPTIONS });
    expect(asks.find((a) => a.session_id === 's2')).toMatchObject({ answerable: false, tool: 'Bash' });
    expect(asks.find((a) => a.session_id === 's3')).toMatchObject({ answerable: false });
  });
  it('方針が空なら auto_tools は読み取りと検索の 4 つ', () => {
    expect(svc().list('orch').policy).toEqual({ text: null, auto_tools: ['Read', 'Glob', 'Grep', 'LS'] });
    w.policy = { text: '全部聞いて', autoTools: [], updatedAt: 1 };
    expect(svc().list('orch').policy).toEqual({ text: '全部聞いて', auto_tools: [] });
  });
  it('ask_id は会話ごとに違い、同じ札なら何度引いても同じ', () => {
    w.asks.set('s1', permAsk('same', 'Read', '/w/a.txt'));
    w.asks.set('orch', permAsk('same', 'Read', '/w/a.txt'));
    const a = askOf('s1').ask_id;
    expect(askOf('s1').ask_id).toBe(a);
    expect(svc().list('other').asks.find((x) => x.session_id === 'orch')!.ask_id).not.toBe(a);
  });
});

describe('answer_ask(by: policy)', () => {
  const policy = (option = '1', over: Record<string, unknown> = {}) => ({ askId: askOf('s1').ask_id, option, by: 'policy' as const, reason: '読むだけ', ...over });

  it('方針の道具の「今回だけ許す」の行は通り、打つ前に記録が 1 行増える', async () => {
    const s = svc();
    expect(await s.answer('orch', policy())).toEqual({ ok: true, label: 'Yes' });
    expect(w.typed).toEqual([{ sessionId: 's1', askId: 'peer-s1', keys: ['1'] }]);
    expect(listAutoApprovals(w.db, {})).toMatchObject([{ sessionId: 's1', title: 'ログイン修正', tool: 'Read', input: '/w/a.txt', label: 'Yes', reason: '読むだけ', policyText: null, at: w.now }]);
  });
  it('autoTools に無い道具は not-allowed で、キーを打たず、記録も無い', async () => {
    w.asks.set('s1', permAsk('peer-s1', 'Bash', 'rm -rf /'));
    expect(await svc().answer('orch', policy())).toEqual({ ok: false, reason: 'not-allowed' });
    expect(w.typed).toEqual([]);
    expect(listAutoApprovals(w.db, {})).toEqual([]);
  });
  it('方針で何も許していなければ、読み取りも not-allowed', async () => {
    w.policy = { text: '全部聞いて', autoTools: [], updatedAt: 1 };
    expect(await svc().answer('orch', policy())).toEqual({ ok: false, reason: 'not-allowed' });
    expect(w.typed).toEqual([]);
  });
  it('質問は not-allowed（質問は必ず利用者が答える）', async () => {
    w.asks.set('s1', { askId: 'q1', kind: 'question', tool: 'AskUserQuestion', input: 'どちら?', options: [{ key: '1', label: 'Yes' }], multi: false, allowText: true });
    w.policy = { text: 'x', autoTools: ['Read', 'AskUserQuestion'], updatedAt: 1 };
    w.live[1] = { ...w.live[1]!, waitingFor: 'question' };
    expect(await svc().answer('orch', policy())).toEqual({ ok: false, reason: 'not-allowed' });
    expect(w.typed).toEqual([]);
  });
  it('「今後は聞かない」の行と断る行は not-allowed', async () => {
    for (const k of ['2', '3']) expect(await svc().answer('orch', policy(k))).toEqual({ ok: false, reason: 'not-allowed' });
    expect(w.typed).toEqual([]);
    expect(listAutoApprovals(w.db, {})).toEqual([]);
  });
  it('統括自身の札には答えない', async () => {
    const own = svc().list('someone-else').asks.find((a) => a.session_id === 'orch')!.ask_id;
    expect(await svc().answer('orch', { ...policy(), askId: own })).toEqual({ ok: false, reason: 'not-allowed' });
    expect(await svc().answer('orch', { ...policy(), askId: own, by: 'user' })).toEqual({ ok: false, reason: 'not-allowed' });
    expect(w.typed).toEqual([]);
  });
  it('答えられない会話（Codex）は not-answerable', async () => {
    expect(await svc().answer('orch', { ...policy(), askId: askOf('s2').ask_id })).toEqual({ ok: false, reason: 'not-answerable' });
    expect(w.typed).toEqual([]);
  });
  it('画面の札が違えば ask-mismatch で、記録を消す', async () => {
    w.result = { ok: false, reason: 'ask-mismatch' };
    expect(await svc().answer('orch', policy())).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(listAutoApprovals(w.db, {})).toEqual([]);
  });
  it('知らない ask_id は ask-mismatch で、何も打たない', async () => {
    expect(await svc().answer('orch', { ...policy(), askId: 'nope' })).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(w.typed).toEqual([]);
  });
  it('同じ ask_id の 2 度目は already-answered で、キーも記録も増えない', async () => {
    const s = svc();
    const args = policy();
    expect((await s.answer('orch', args)).ok).toBe(true);
    expect(await s.answer('orch', args)).toEqual({ ok: false, reason: 'already-answered' });
    expect(w.typed).toHaveLength(1);
    expect(listAutoApprovals(w.db, {})).toHaveLength(1);
  });
  it('ほかの PC が先に答えていれば already-answered を返し、記録を消す', async () => {
    w.result = { ok: false, reason: 'already-answered' };
    expect(await svc().answer('orch', policy())).toEqual({ ok: false, reason: 'already-answered' });
    expect(listAutoApprovals(w.db, {})).toEqual([]);
  });
  it(`1 分に ${ORCHESTRATOR_POLICY_RATE} 回を超えたら断り、利用者へ知らせる`, async () => {
    const s = svc();
    for (let i = 0; i < ORCHESTRATOR_POLICY_RATE; i++) {
      w.asks.set('s1', permAsk(`peer-${i}`, 'Read', `/w/${i}`));
      expect((await s.answer('orch', policy())).ok).toBe(true);
    }
    w.asks.set('s1', permAsk('peer-over', 'Read', '/w/over'));
    expect(await s.answer('orch', policy())).toEqual({ ok: false, reason: 'rate-limited' });
    expect(w.limited).toBe(1);
    expect(w.typed).toHaveLength(ORCHESTRATOR_POLICY_RATE);
    // 1 分たてば、また通る。
    w.now += 60_000;
    expect((await s.answer('orch', policy())).ok).toBe(true);
  });
  it('記録が書けなければ打たない', async () => {
    w.db.exec('drop table auto_approvals');
    await expect(svc().answer('orch', policy())).rejects.toThrow();
    expect(w.typed).toEqual([]);
  });
});

describe('answer_ask(by: user)', () => {
  it('利用者の入力で始まったターンなら、方針に無い道具や断る行も押せ、記録は書かない', async () => {
    w.asks.set('s1', permAsk('peer-s1', 'Bash', 'rm -rf build'));
    w.result = { ok: true, label: 'No' };
    expect(await svc().answer('orch', { askId: askOf('s1').ask_id, option: '3', by: 'user' })).toEqual({ ok: true, label: 'No' });
    expect(w.typed).toEqual([{ sessionId: 's1', askId: 'peer-s1', keys: ['3'] }]);
    expect(listAutoApprovals(w.db, {})).toEqual([]);
  });
  it('出来事で始まったターンでは not-allowed', async () => {
    w.userTurn = false;
    expect(await svc().answer('orch', { askId: askOf('s1').ask_id, option: '1', by: 'user' })).toEqual({ ok: false, reason: 'not-allowed' });
    expect(w.typed).toEqual([]);
  });
});

describe('記録の一覧', () => {
  it('新しい順で、limit と since で絞れ、90 日より古い行は書くときに捨てる', async () => {
    const s = svc();
    for (let i = 0; i < 3; i++) {
      w.asks.set('s1', permAsk(`p${i}`, 'Read', `/w/${i}`));
      await s.answer('orch', { askId: askOf('s1').ask_id, option: '1', by: 'policy', reason: `r${i}` });
      w.now += 1000;
    }
    expect(listAutoApprovals(w.db, {}).map((a) => a.reason)).toEqual(['r2', 'r1', 'r0']);
    expect(listAutoApprovals(w.db, { limit: 1 }).map((a) => a.reason)).toEqual(['r2']);
    expect(listAutoApprovals(w.db, { since: 1_001_000 }).map((a) => a.reason)).toEqual(['r2', 'r1']);
    w.now += 91 * 86_400_000;
    w.asks.set('s1', permAsk('late', 'Read', '/w/late'));
    await s.answer('orch', { askId: askOf('s1').ask_id, option: '1', by: 'policy', reason: 'late' });
    expect(listAutoApprovals(w.db, {}).map((a) => a.reason)).toEqual(['late']);
  });
});
