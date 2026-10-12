import { describe, expect, it } from 'vitest';
import { translator, type LiveAgentDto, type LiveDigestDto, type TranscriptEvent } from '@agent-hangar/shared';
import { presentNowCard, type CardInput } from './live.ts';
import type { ArtifactCardProps } from './project.ts';

const ja = translator('ja');
const en = translator('en');

let seq = 0;
const call = (name: string, input: unknown, ts?: number): TranscriptEvent => ({ kind: 'tool_call', seq: seq++, ...(ts === undefined ? {} : { ts }), toolId: `t${seq}`, name, input, summary: name });
const res = (c: TranscriptEvent, isError = false): TranscriptEvent => ({ kind: 'tool_result', seq: seq++, toolId: (c as { toolId: string }).toolId, text: '', isError });
const prompt = (text: string, ts?: number): TranscriptEvent => ({ kind: 'user', seq: seq++, ...(ts === undefined ? {} : { ts }), text });
const digest = (p: Partial<LiveDigestDto> = {}): LiveDigestDto => ({ sessionId: 's1', turnStartSeq: 0, intent: null, agents: [], ...p });
const agent = (p: Partial<LiveAgentDto>): LiveAgentDto => ({ agentId: 'a', title: '担当', state: 'running', startedAt: 0, lastAt: 60_000, last: null, report: null, endNote: null, linked: true, ...p });
const artifact = (id: string): ArtifactCardProps => ({ id, title: `成果 ${id}`, description: null, favicon: '📄', url: 'https://x', lastPublished: '12 分前', versionCount: 1, canOpenEditor: false });
const input = (p: Partial<CardInput> = {}): CardInput => ({
  digest: digest(), events: [], turnFrom: 0, live: 'busy', activity: null, now: 180_000, viewingAgent: false, clock: (ts) => `t${ts}`, idleFor: '3 分',
  waited: '4 分', artifacts: [], ...p,
});
const present = (p: Partial<CardInput> = {}, t = ja) => presentNowCard(input(p), t);

describe('現在の札の止まっている理由（試作 stop-reason-proto の N1）', () => {
  it('許可待ちは状態の行を「許可待ち」にし、道具と命令の全文と説明の欄を出す', () => {
    const s = present({ live: 'waiting', reason: 'permission', permission: { tool: 'Bash', input: 'rm -rf ./build/cache', description: '古いキャッシュを消す' } });
    expect(s).toMatchObject({ tone: 'wait', state: '許可待ち', sub: '4 分', detail: null, question: false });
    expect(s.stop).toEqual({ kind: 'permission', head: 'Claude が求めている許可 · Bash', command: 'rm -rf ./build/cache', why: '古いキャッシュを消す', hint: 'ターミナルで許可するか拒否してください' });
  });
  it('許可の中身が届いていなければ、ターミナルに出ていると言う', () => {
    expect(present({ live: 'waiting', reason: 'permission', permission: null }).stop).toEqual({ kind: 'permission', head: 'Claude が求めている許可', command: null, why: null, hint: '何の許可かはターミナルに出ています。hangar の外で起動したセッションは中身を受け取れません。' });
  });
  it('使用制限は灰の札にし、リセットの時刻、残りの棒、自動で続くかを出す', () => {
    const now = new Date(2026, 9, 12, 16, 42).getTime();
    const resetsAt = new Date(2026, 9, 12, 16, 50).getTime();
    const s = present({ now, live: 'idle', reason: 'limit', limit: { kind: 'five_hour', resetsAt, auto: true, reset: false } });
    expect(s).toMatchObject({ tone: 'limit', state: '使用制限', sub: 'あと 8 分' });
    expect(s.stop).toEqual({ kind: 'limit', head: '5 時間の使用制限', at: '16:50 にリセット（あと 8 分）', meter: 97, hint: 'リセットされると Claude Code が自動で続きを始めます。' });
    const no = present({ now, live: 'idle', reason: 'limit', limit: { kind: 'other', resetsAt, auto: false, reset: false } });
    expect(no.stop).toMatchObject({ head: '使用制限', meter: null, hint: '自動で続く予約はありません。リセットの後にターミナルで続きを指示してください。' });
  });
  it('リセット済みは入力待ちの色で、続きを指示するよう言う', () => {
    const s = present({ live: 'idle', reason: 'reset', limit: { kind: 'five_hour', resetsAt: 0, auto: false, reset: true } });
    expect(s).toMatchObject({ tone: 'wait', state: 'リセット済み' });
    expect(s.stop).toEqual({ kind: 'reset', head: '使用制限がリセットされました', body: '自動の続きは始まっていません。ターミナルで続きを指示してください。' });
  });
  it('理由が無ければ stop は null', () => {
    expect(present({ live: 'waiting' }).stop).toBeNull();
    expect(present({}).stop).toBeNull();
  });
});

describe('現在の札の状態の行', () => {
  it('入力待ちは、状態の語と待機の経過と、問いを出す（経過に「入力待ち」を重ねない）', () => {
    const s = present({ live: 'waiting', activity: { tool: 'AskUserQuestion', summary: 'q', question: '既存のテストを書き換えてよいですか？' } });
    expect(s).toMatchObject({ tone: 'wait', state: '入力待ち', sub: '4 分', detail: '既存のテストを書き換えてよいですか？', question: true });
  });
  it('質問の文が無い入力待ちは、活動の要約を出す。それも無ければ何も出さない', () => {
    expect(present({ live: 'waiting', activity: { tool: 'ExitPlanMode', summary: '計画の承認', question: null } })).toMatchObject({ detail: '計画の承認', question: true });
    expect(present({ live: 'waiting' })).toMatchObject({ detail: null, question: false });
  });
  it('許可でない待ち（許可した直後のダイアログ）では、もう答えの出た呼び出し（前の許可の命令）を問いとして出さない', () => {
    const bash = call('Bash', { command: 'echo perm4 > perm-4.txt' });
    const activity = { tool: 'Bash', summary: 'Bash echo perm4 > perm-4.txt', question: null };
    expect(present({ live: 'waiting', waitingFor: 'other', events: [bash, res(bash)], activity })).toMatchObject({ state: '入力待ち', detail: null, question: false });
    // 答えの出ていない呼び出しを待っている（計画の承認など）なら、今までどおり出す。
    const plan = call('ExitPlanMode', {});
    expect(present({ live: 'waiting', waitingFor: 'other', events: [plan], activity: { tool: 'ExitPlanMode', summary: '計画の承認', question: null } })).toMatchObject({ detail: '計画の承認', question: true });
  });
  it('入力待ちは、動いているサブエージェントや裏の印があっても入力待ちのまま', () => {
    expect(present({ live: 'waiting', aside: { shell: true, agents: 0 }, digest: digest({ agents: [agent({})] }) }).tone).toBe('wait');
  });
  it('裏だけ動いているときは、バックグラウンドで作業中と、メイン会話が空いていることを言う（問いではない）', () => {
    expect(present({ aside: { shell: true, agents: 0 } })).toMatchObject({ tone: 'aside', state: 'バックグラウンドで作業中', detail: 'シェルが実行中、メイン会話は入力を受け付けている', question: false });
    const two = present({ aside: { shell: false, agents: 2 }, digest: digest({ agents: [agent({ agentId: 'a' }), agent({ agentId: 'b' })] }) });
    expect(two).toMatchObject({ tone: 'aside', state: 'バックグラウンドで作業中', detail: 'サブエージェント 2 件が実行中、メイン会話は入力を受け付けている' });
  });
  it('裏の担当が数えられないとき（workflow など）は、何が動いているかを言わず、メイン会話が空いていることだけを言う', () => {
    expect(present({ aside: { shell: false, agents: 0 } }).detail).toBe('メイン会話は入力を受け付けている');
  });
  it('作業中は、手の数とターンの経過を添える（hangar 自身の MCP は数えず、Agent の起こしは数える）', () => {
    seq = 0;
    const c1 = call('Read', { file_path: '/w/a.ts' });
    const m1 = call('mcp__hangar__set_turn_intent', { text: 'x' });
    const a1 = call('Agent', { description: '担当' });
    const s = present({ events: [prompt('x', 0), c1, res(c1), m1, res(m1), a1, res(a1), call('Bash', { command: 'npm test', description: 'テスト' })] });
    expect(s).toMatchObject({ tone: 'busy', state: '作業中', sub: '3 手目 · 3 分', detail: null });
  });
  it('ターンの始まりの時刻が分からなければ手の数だけ、サブエージェントの transcript を開いている間は何も添えない', () => {
    seq = 0;
    const c1 = call('Read', { file_path: '/w/a.ts' });
    const events = [prompt('x'), c1, res(c1), call('Bash', { command: 'ls' })];
    expect(present({ events }).sub).toBe('2 手目');
    expect(present({ events, viewingAgent: true }).sub).toBe('');
  });
  it('サブエージェントが動いている作業中は、その件数と、メイン会話も手を動かしているかを言う', () => {
    seq = 0;
    const running = digest({ agents: [agent({ agentId: 'a' }), agent({ agentId: 'b' }), agent({ agentId: 'c', state: 'done' })] });
    const open = call('Read', { file_path: '/w/a.ts' });
    expect(present({ digest: running, events: [prompt('x'), open] })).toMatchObject({ tone: 'busy', state: '作業中', sub: 'サブエージェント 2 件が実行中', detail: 'メイン会話も作業中' });
    const done = call('Read', { file_path: '/w/b.ts' });
    expect(present({ digest: running, events: [prompt('x'), done, res(done)] }).detail).toBeNull();
  });
  it('アイドルは、アイドルの語と経過', () => {
    expect(present({ live: 'idle' })).toMatchObject({ tone: 'idle', state: 'アイドル', sub: '3 分', detail: null });
  });
  it('英語では、辞書の英語の文が出る', () => {
    expect(present({ live: 'waiting', activity: { tool: 'AskUserQuestion', summary: 'q', question: 'Overwrite?' } }, en)).toMatchObject({ state: 'Needs input', sub: 'for 4 分', detail: 'Overwrite?' });
    expect(present({ live: 'idle' }, en)).toMatchObject({ state: 'Idle', sub: 'for 3 分' });
    expect(present({ aside: { shell: true, agents: 0 } }, en)).toMatchObject({ state: 'Working in background', detail: 'A shell is running, Main conversation is accepting input' });
    seq = 0;
    expect(present({ events: [prompt('x'), call('Read', { file_path: '/w/a.ts' })] }, en).sub).toBe('Step 1');
  });
});

describe('現在の札の意図', () => {
  it('今のターンの意図は、引用符で囲まずに出し、「Claude の意図 · 時刻」の小見出しを添え、30 回を超えたら薄くする', () => {
    const said = present({ digest: digest({ intent: { text: '検証をサーバ側へ寄せる', at: 0, stepsSince: 3, inThisTurn: true } }) }).intent;
    expect(said).toEqual({ kind: 'said', text: '検証をサーバ側へ寄せる', label: 'Claude の意図 · t0', title: 'Claude が記入、t0、以降のツール呼び出し 3 回', stale: false });
    expect(present({ digest: digest({ intent: { text: 'x', at: 0, stepsSince: 31, inThisTurn: true } }) }).intent).toMatchObject({ kind: 'said', stale: true });
  });
  it('意図が無い、前のターンのものしか無い、を言い分ける', () => {
    expect(present().intent).toEqual({ kind: 'none', text: 'まだ意図が届いていません' });
    expect(present({ digest: digest({ intent: { text: '前の', at: 0, stepsSince: 1, inThisTurn: false } }) }).intent).toEqual({ kind: 'none', text: 'このターンの意図はまだ届いていません' });
  });
});

describe('現在の札のツール呼び出し', () => {
  it('今のターンの、メイン会話の呼び出しを、道具の名前と引数の短い形で出す。札には直近 3 つ。hangar の MCP と Agent は出さない', () => {
    seq = 0;
    const events: TranscriptEvent[] = [];
    const step = (name: string, input: unknown) => { const c = call(name, input); events.push(c, res(c)); };
    step('Read', { file_path: '/w/old.ts' });
    const turn = prompt('x');
    events.push(turn);
    step('Read', { file_path: '/w/src/checkout/form.ts' });
    step('Edit', { file_path: '/w/src/checkout/form.test.ts', old_string: 'a', new_string: 'b' });
    step('Grep', { pattern: 'validate' });
    step('Bash', { command: 'npm test -- form', description: 'フォームのテストを走らせる' });
    step('Bash', { command: 'git status' });
    step('mcp__hangar__set_turn_intent', { text: 'x' });
    step('Agent', { description: '担当' });
    const s = present({ events, turnFrom: turn.seq, live: 'idle' });
    // 前のターンの old は含めない。直近 3 つだけが札に並び、全部は stepsAll に入る。
    expect(s.stepsTotal).toBe(5);
    expect(s.steps.map((x) => [x.name, x.arg, x.mark])).toEqual([
      ['Grep', 'validate', 'done'], ['Bash', 'フォームのテストを走らせる', 'done'], ['Bash', 'git status', 'done'],
    ]);
    expect(s.stepsAll.map((x) => x.name)).toEqual(['Read', 'Edit', 'Grep', 'Bash', 'Bash']);
  });
  it('Windows のパスのファイルも、名前だけを引数に出す', () => {
    seq = 0;
    const turn = prompt('x');
    const e1 = call('Edit', { file_path: 'C:\\w\\app\\src\\フォーム.test.ts' }); const r1 = res(e1);
    const e2 = call('Read', { file_path: '\\\\server\\share\\notes\\a.md' }); const r2 = res(e2);
    const s = present({ events: [turn, e1, r1, e2, r2], turnFrom: turn.seq, live: 'idle' });
    expect(s.steps.map((x) => x.arg)).toEqual(['フォーム.test.ts', 'a.md']);
  });
  it('結果の無い最後の呼び出しは、作業中なら「いま」、入力待ちなら「入力待ち」、失敗した呼び出しは「失敗」', () => {
    seq = 0;
    const r1 = call('Read', { file_path: '/w/a.ts' });
    const r2 = call('Read', { file_path: '/w/b.ts' });
    const q = call('AskUserQuestion', { questions: [] });
    const evs = [prompt('x'), r1, res(r1, true), r2, res(r2), q];
    expect(present({ events: evs, live: 'busy' }).steps.map((x) => x.mark)).toEqual(['fail', 'done', 'now']);
    expect(present({ events: evs, live: 'waiting' }).steps.map((x) => [x.name, x.arg, x.mark]).at(-1)).toEqual(['AskUserQuestion', '', 'wait']);
  });
  it('サブエージェントの transcript を開いている間は、呼び出しを出さない', () => {
    seq = 0;
    const c = call('Read', { file_path: '/w/a.ts' });
    expect(present({ events: [prompt('x'), c], viewingAgent: true })).toMatchObject({ steps: [], stepsTotal: 0, stepsAll: [] });
  });
  it('全部の一覧（ポップオーバー用）は直近 30 回までにする', () => {
    seq = 0;
    const evs: TranscriptEvent[] = [prompt('x')];
    for (let n = 0; n < 40; n++) { const c = call('Read', { file_path: `/w/f${n}.ts` }); evs.push(c, res(c)); }
    const s = present({ events: evs, live: 'idle' });
    expect(s.stepsTotal).toBe(40);
    expect(s.stepsAll).toHaveLength(30);
    expect(s.stepsAll.at(-1)).toMatchObject({ arg: 'f39.ts' });
  });
});

describe('現在の札のサブエージェントとアーティファクト', () => {
  it('サブエージェントは、失敗、実行中、完了の順に並べ、件数と、いちばん強い状態を札の色にする', () => {
    const lanes = present({ digest: digest({ agents: [agent({ agentId: 'd', title: '済み', state: 'done', report: '12 件を列挙した' }), agent({ agentId: 'r', title: '動いている', last: { text: 'a.ts を読んだ', mono: false, kind: 'read', isError: false } }), agent({ agentId: 'e', title: '失敗', state: 'error', report: null })] }) }).lanes;
    expect(lanes.count).toBe(3);
    expect(lanes.tone).toBe('error');
    expect(lanes.items.map((l) => [l.agentId, l.tone, l.stateLabel, l.line, l.quoted])).toEqual([
      ['e', 'error', '失敗', '失敗', false],
      ['r', 'running', '実行中', 'a.ts を読んだ', false],
      ['d', 'done', '完了', '12 件を列挙した', true],
    ]);
  });
  it('動いているものがあれば実行中、全部済みなら完了の色。1 本も無ければ件数 0', () => {
    expect(present({ digest: digest({ agents: [agent({}), agent({ agentId: 'b', state: 'done' })] }) }).lanes.tone).toBe('running');
    expect(present({ digest: digest({ agents: [agent({ state: 'done' })] }) }).lanes).toMatchObject({ count: 1, tone: 'done' });
    expect(present().lanes).toMatchObject({ count: 0, items: [] });
  });
  it('済みの 1 行は、報告が無ければ完了（終わりの知らせの訳）。始めたばかりは開始直後', () => {
    const items = present({ digest: digest({ agents: [agent({ agentId: 'a', state: 'done', endNote: 'killed' }), agent({ agentId: 'b', state: 'done', endNote: 'rate-limited' }), agent({ agentId: 'c', state: 'done' }), agent({ agentId: 'd', last: null })] }) }).lanes.items;
    expect(items.map((l) => [l.agentId, l.line])).toEqual([['d', '開始直後'], ['a', '完了（停止済み）'], ['b', '完了（rate-limited）'], ['c', '完了']]);
  });
  it('経過は、動いている本は今まで、済みは最後の動きまで', () => {
    const items = present({ now: 5 * 60_000, digest: digest({ agents: [agent({ agentId: 'r', startedAt: 0 }), agent({ agentId: 'd', state: 'done', startedAt: 0, lastAt: 60_000 }), agent({ agentId: 'n', startedAt: null })] }) }).lanes.items;
    expect(Object.fromEntries(items.map((l) => [l.agentId, l.elapsed]))).toEqual({ r: '5 分', d: '1 分', n: '' });
  });
  it('アーティファクトは件数と一覧を、そのまま渡す', () => {
    const s = present({ artifacts: [artifact('a1'), artifact('a2')] });
    expect(s.artifacts.count).toBe(2);
    expect(s.artifacts.items.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(present().artifacts.count).toBe(0);
  });
});

describe('ノート', () => {
  it('札はノートを持たない（ノートは 0.4.0 で外した）', () => {
    expect(present()).not.toHaveProperty('note');
  });
});
