import { describe, expect, it } from 'vitest';
import { translator, type RunDto, type SessionDto, type SettingsDto, type TranscriptEvent } from '@agent-hangar/shared';
import { defaultSessionView } from '../mediator/sessionView.ts';
import { initialState } from '../mediator/transition.ts';
import { accountsFixture } from '../test/accounts.ts';
import { applyEventsPage, eventsKey, initialStore, type Store } from '../store/store.ts';
import { absoluteTime } from './format.ts';
import { presentSession, sessionAddressLine } from './session.ts';

const ja = translator('ja');

const NOW = Date.parse('2026-09-02T12:00:00Z');
const stats = { turns: 11, model: 'claude-sonnet-4-5', effort: 'high', filesChanged: 3, prUrl: 'https://github.com/o/r/pull/88', inputTokens: 12_000, outputTokens: 8_000, contextPercent: 41, costUsd: 0.42 };
const session = (over: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: '画像の遅延読み込み', cwd: '/w/web-shop', firstPrompt: null, aiTitle: null, startedAt: NOW - 3_600_000, lastActivityAt: NOW - 60_000, lastTurnAt: null, 
  hasTranscript: true, live: null, summary: null, stats, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, pinnedAt: null, unread: null, spawnedBy: null, ...over,
});
const run = (over: Partial<RunDto> = {}): RunDto => ({ id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: NOW - 3_600_000, endedAt: null, endReason: null, heartbeatAt: NOW, ...over });
function store(s: SessionDto = session(), r: RunDto | null = null): Store {
  const st = initialStore();
  st.bootstrapped = true;
  st.sessions = { [s.id]: s };
  if (r) st.runs = { [r.id]: r };
  return st;
}
const user = (seq: number, text: string): TranscriptEvent => ({ kind: 'user', seq, text, ts: NOW - 1000 });
const present = (st: Store) => presentSession(initialState(), st, NOW, 's1');

describe('引き継がれた会話の見出しの下の 1 行', () => {
  it('takenOver があれば引き継ぎ先と時刻の 1 行を持ち、無ければ null', () => {
    const at = Date.parse('2026-10-16T10:00:00');
    expect(present(store(session({ takenOver: { deviceName: 'pc-a', at } }))).takenOver).toBe(`pc-a に引き継ぎ（${absoluteTime(ja, at)}）`);
    expect(present(store()).takenOver).toBeNull();
    expect(present(store(session({ takenOver: null, fromPhone: null }))).takenOver).toBeNull();
  });
});

describe('セッション画面の C の構成（帯、冒頭の 1 枚、見出しの札、詳細）', () => {
  describe('帯と冒頭の 1 枚の出し分け', () => {
    it('生きた run があれば帯を出し、冒頭の 1 枚は出さない', () => {
      const p = present(store(session({ live: 'busy' }), run()));
      expect(p.strip).toMatchObject({ tone: 'busy', state: '作業中' });
      expect(p.lead).toBeNull();
    });
    it('run が無ければ冒頭の 1 枚を出し、帯は出さない', () => {
      const p = present(store());
      expect(p.strip).toBeNull();
      expect(p.lead).toMatchObject({ status: { value: 'active' }, turns: '11 ターン' });
    });
    it('run が終わっていれば帯は出さない（ターミナルは残るが、いまの値は無い）', () => {
      const p = present(store(session(), run({ endedAt: NOW - 1000, endReason: 'exited' })));
      expect(p.strip).toBeNull();
    });
    it('帯にも冒頭の 1 枚にもノートは無い（ノートは 0.4.0 で外した）', () => {
      expect(present(store(session({ live: 'idle' }), run())).strip).not.toHaveProperty('note');
      expect(present(store(session())).lead).not.toHaveProperty('note');
    });
    it('冒頭の 1 枚の変更したファイルは、サーバから取った一覧を使う', () => {
      const st = store();
      st.sessionFiles = { s1: [{ path: '/w/web-shop/src/a.ts', edits: 2, agentId: null }] };
      const p = present(st);
      expect(p.lead?.files.count).toBe(1);
      expect(p.lead?.files.rows[0]).toMatchObject({ path: '/w/web-shop/src/a.ts', edits: '2 回' });
    });
    it('本文が消えた会話は、冒頭の 1 枚に「要約のみ」の印を出す', () => {
      const old = session({ hasTranscript: false, lastActivityAt: NOW - 40 * 86_400_000 });
      expect(present(store(old)).lead?.flags).toEqual(['要約のみ']);
    });
    it('英語では帯も冒頭の 1 枚も英語になる', () => {
      const en = store(session({ live: 'busy' }), run());
      en.settings = { language: 'en' } as SettingsDto;
      expect(present(en).strip?.state).toBe('Working');
      const ended = store();
      ended.settings = { language: 'en' } as SettingsDto;
      expect(present(ended).lead?.turns).toBe('11 turns');
    });
  });

  describe('ターンの少ない終わった会話の右の欄', () => {
    const peek = (open: boolean) => ({ ...initialState(), sessionView: { s1: { ...defaultSessionView(), tocPeek: open } } });
    const few = (over: Partial<SessionDto> = {}) => session({ stats: { ...stats, turns: 2 }, ...over });
    it('ターンが 2 つ以下で要約の札が無ければ、はじめは畳み、その画面で開いた間だけ開く', () => {
      expect(present(store(few())).transcriptOpen).toBe(false);
      expect(presentSession(peek(true), store(few()), NOW, 's1').transcriptOpen).toBe(true);
      // 土台の要約は札にならないので、畳む。
      const baseline = { title: 't', oneLiner: 'o', body: '最初の依頼', state: 'done' as const, nextSteps: [], source: 'baseline' as const, sourceId: null, sourceModel: null, basedOnTurns: 2, updatedAt: NOW };
      expect(present(store(few({ summary: baseline }))).transcriptOpen).toBe(false);
    });
    it('要約の札があるか、ターンが 3 つ以上なら、保存した開閉に従う', () => {
      expect(present(store(session({ stats: { ...stats, turns: 3 } }))).transcriptOpen).toBe(true);
      const written = { title: 't', oneLiner: 'o', body: 'b', state: 'done' as const, nextSteps: [], source: 'in_session' as const, sourceId: null, sourceModel: null, basedOnTurns: 2, updatedAt: NOW };
      expect(present(store(few({ summary: written }))).transcriptOpen).toBe(true);
      const pending = store(few());
      pending.summaryPending = { s1: true };
      expect(present(pending).transcriptOpen).toBe(true);
    });
    it('実行中の画面は畳まない', () => {
      expect(present(store(few({ live: 'busy' }), run())).transcriptOpen).toBe(true);
    });
  });

  describe('見出しの名前の横の札', () => {
    it('他の PC で実行中なら札を出す。無ければ空', () => {
      const lock = { deviceId: 'd2', deviceName: 'MacBook', runId: 'r9', heartbeatAt: NOW - 30_000, stale: false };
      expect(present(store(session({ lock }))).badges).toMatchObject([{ kind: 'lock', label: 'MacBook で実行中' }]);
      expect(present(store()).badges).toEqual([]);
    });
  });

  describe('詳細（i）の行', () => {
    const names = (p: ReturnType<typeof present>) => p.details.map((d) => d.name);
    it('宛先（登録が無ければ ID）の後に、モデル、effort レベル、権限モード、開始、作業ディレクトリ、起動、ターンとトークンを順に並べる', () => {
      const p = present(store(session({ live: 'busy' }), { ...run(), permissionMode: 'acceptEdits' }));
      expect(names(p)).toEqual(['ID', 'モデル', 'effort レベル', '権限モード', '開始', '作業ディレクトリ', '起動', 'ターンとトークン', 'コンテキスト使用量', 'コスト', '変更したファイル', 'PR']);
      const row = (name: string) => p.details.find((d) => d.name === name)!;
      expect(row('モデル').value).toBe('sonnet 4.5');
      expect(row('effort レベル').value).toBe('high');
      expect(row('権限モード').value).toBe('Accept edits');
      expect(row('開始').value).toBe(absoluteTime(ja, NOW - 3_600_000));
      expect(row('作業ディレクトリ')).toMatchObject({ value: '/w/web-shop', mono: true });
      expect(row('起動').value).toMatch(/^新しいセッション \d{2}:\d{2}$/);
      expect(row('ターンとトークン').value).toBe('11 ターン、20k トークン');
      expect(row('変更したファイル').value).toBe('3 件');
      expect(row('PR').value).toBe('PR #88');
    });
    it('コンテキスト使用量とコストは、届いていればターンとトークンの後に並べる（実行中の札には置かない）', () => {
      const p = present(store(session({ live: 'busy', stats: { ...session().stats, contextPercent: 41.6, costUsd: 0.86 } }), run()));
      const at = names(p).indexOf('ターンとトークン');
      expect(names(p).slice(at, at + 3)).toEqual(['ターンとトークン', 'コンテキスト使用量', 'コスト']);
      expect(p.details.find((d) => d.name === 'コンテキスト使用量')!.value).toBe('42%');
      expect(p.details.find((d) => d.name === 'コスト')!.value).toBe('$0.86');
      const none = names(present(store(session({ live: 'busy', stats: { ...stats, contextPercent: null, costUsd: null } }), run())));
      expect(none).not.toContain('コンテキスト使用量');
      expect(none).not.toContain('コスト');
    });
    it('起動の種類は、再開とフォークを言い分ける', () => {
      expect(present(store(session(), run({ kind: 'resume' }))).details.find((d) => d.name === '起動')!.value).toMatch(/^再開 /);
      expect(present(store(session(), run({ kind: 'fork' }))).details.find((d) => d.name === '起動')!.value).toMatch(/^フォーク /);
    });
    it('値が無い行は出さない（権限モード、effort、起動の run、コンテキスト使用量、コスト、変更、PR）', () => {
      const bare = session({ stats: { ...stats, effort: null, filesChanged: 0, prUrl: null, contextPercent: null, costUsd: null } });
      expect(names(present(store(bare)))).toEqual(['ID', 'モデル', '開始', '作業ディレクトリ', 'ターンとトークン']);
    });
    it('アカウントが 2 件以上あるときだけアカウントの行を出す。色の点を添える', () => {
      const two = { ...store(), accounts: accountsFixture };
      const row = present(two).details.find((d) => d.name === 'アカウント');
      expect(row).toMatchObject({ dot: expect.stringMatching(/^#/) });
      expect(names(present(store()))).not.toContain('アカウント');
    });
    it('クイックセッションの印は、詳細の行に出す', () => {
      const scratch = session({ fromScratch: true });
      expect(names(present(store(scratch)))).toContain('クイックセッション');
      expect(names(present(store()))).not.toContain('クイックセッション');
    });
    it('英語では行の名前も英語になる', () => {
      const st = store(session({ live: 'busy' }), { ...run(), permissionMode: 'plan' });
      st.settings = { language: 'en' } as SettingsDto;
      expect(names(present(st)).slice(0, 4)).toEqual(['ID', 'Model', 'Effort level', 'Permission mode']);
    });
  });

  describe('目次', () => {
    it('目次の行数を、タブの列の札に出す数として持つ', () => {
      const st = store(session({ live: 'idle' }), run());
      const key = eventsKey('s1', null);
      const filled = applyEventsPage(st, key, { sessionId: 's1', events: [user(1, 'a'), user(2, 'b')], total: 2, nextSeq: null }, false, false);
      expect(present(filled).turnRows).toHaveLength(2);
    });
    describe('見出しの数と読み込みの印', () => {
      const key = eventsKey('s1', null);
      const live = () => store(session({ live: 'idle' }), run());
      it('最初の events が届くまでは数を出さない（仮の 0 を出さない）', () => {
        expect(present(live()).turnCount).toBeNull();
        const loading = { ...live(), events: { [key]: { items: [], total: 0, nextSeq: null, loading: true } } };
        expect(present(loading).turnCount).toBeNull();
      });
      it('届いたら、(i) の「ターンとトークン」と同じ統計の数を出す。窓に入っている行の数ではない', () => {
        const filled = applyEventsPage(live(), key, { sessionId: 's1', events: [user(1, 'a'), user(2, 'b')], total: 90, nextSeq: null }, false, false);
        const p = present(filled);
        expect(p.turnRows).toHaveLength(2);
        expect(p.turnCount).toEqual({ n: 11, plus: false });
        // (i) の「N ターン」と同じ出所である。
        const usage = (q: ReturnType<typeof present>) => q.details.find((d) => d.name === 'ターンとトークン')?.value;
        expect(usage(p)).toMatch(/^11 ターン、/);
        const st2 = { ...filled, sessions: { s1: session({ live: 'idle', stats: { ...stats, turns: 104 } }) } };
        expect(present(st2).turnCount?.n).toBe(104);
        expect(usage(present(st2))).toMatch(/^104 ターン、/);
      });
      it('追記を読み足している間（loading だけ立つ）も、数と読み込みの印は動かない', () => {
        const filled = applyEventsPage(live(), key, { sessionId: 's1', events: [user(1, 'a')], total: 1, nextSeq: null }, false, false);
        const before = present(filled);
        const appending = { ...filled, events: { [key]: { ...filled.events[key]!, loading: true } } };
        const during = present(appending);
        expect(during.turnCount).toEqual(before.turnCount);
        expect(during.loadingOlder).toBe(false);
        expect(during.turnsPending).toBe(false);
      });
      it('古い側を読んでいる間だけ loadingOlder が立つ', () => {
        const filled = applyEventsPage(live(), key, { sessionId: 's1', events: [user(1, 'a')], total: 9, nextSeq: null }, false, false);
        const older = { ...filled, events: { [key]: { ...filled.events[key]!, loading: true, loadingOlder: true } } };
        expect(present(older).loadingOlder).toBe(true);
      });
      it('サブエージェントを見ている間は、メインの統計ではなく、その窓の行の数を出す', () => {
        const st = live();
        const sub = eventsKey('s1', 'ag1');
        const filled = applyEventsPage(st, sub, { sessionId: 's1', events: [user(1, 'a')], total: 1, nextSeq: null }, false, false);
        const state = initialState();
        state.sessionView = { s1: { ...defaultSessionView(), agentId: 'ag1' } };
        expect(presentSession(state, filled, NOW, 's1').turnCount).toEqual({ n: 1, plus: false });
      });
    });
  });
});

describe('宛先のコピー（別の Claude に渡す 1 行）', () => {
  const liveStore = (address?: string) => {
    const st = store(session({ live: 'idle' }), run());
    st.live = [{ sessionId: 'u1', status: 'idle', name: address ?? null, nameSource: 'user', cwd: '/w/web-shop', pid: 1, ...(address ? { address } : {}) }];
    return st;
  };
  it('動いていれば、宛先と session_id の 1 行にする', () => {
    expect(sessionAddressLine(liveStore('agent-hangar-ae [7cb314]'), 's1')).toBe('hangar のセッション「画像の遅延読み込み」（宛先: agent-hangar-ae [7cb314]、session_id: s1）');
  });
  it('登録に名前が無ければ session_id だけ、終わっていれば終了と添える', () => {
    expect(sessionAddressLine(liveStore(), 's1')).toBe('hangar のセッション「画像の遅延読み込み」（session_id: s1）');
    expect(sessionAddressLine(store(), 's1')).toBe('hangar のセッション「画像の遅延読み込み」（session_id: s1、終了）');
    expect(sessionAddressLine(store(), 'ghost')).toBeNull();
  });
  it('英語でも 1 行にする', () => {
    const st = liveStore('alpha');
    st.settings = { ...st.settings, language: 'en' } as SettingsDto;
    expect(sessionAddressLine(st, 's1')).toBe('hangar session "画像の遅延読み込み" (address: alpha, session_id: s1)');
  });
  it('(i) の先頭に宛先の行を置き、コピーの印を添える。終わったら ID の行にする', () => {
    const p = present(liveStore('agent-hangar-ae'));
    expect(p.details[0]).toEqual({ name: '宛先', value: 'agent-hangar-ae', mono: true, link: { label: 'コピー', send: { type: 'session.copyAddress', id: 's1' } } });
    expect(present(store()).details[0]).toEqual({ name: 'ID', value: 's1', mono: true, link: { label: 'コピー', send: { type: 'session.copyAddress', id: 's1' } } });
  });
  it('「…」のメニューに「宛先をコピー」を、動いていても終わっていても置く', () => {
    for (const st of [liveStore('a'), store()]) {
      expect(present(st).actions.menu.find((a) => a.id === 'copyAddress')).toMatchObject({ label: '宛先をコピー', disabled: null });
      expect(present(st).actions.menu.find((a) => a.id === 'copyId')).toMatchObject({ label: 'セッション ID をコピー', disabled: null });
    }
  });
});

describe('見出しの状態の札（4A）', () => {
  it('状態の無い会話は Active、付いていればその状態を、実行中でも終わった後でも渡す', () => {
    expect(present(store()).statusPick).toMatchObject({ value: 'active', auto: false });
    expect(present(store(session({ live: 'busy' }), run())).statusPick).toMatchObject({ value: 'active' });
    const paused = session({ state: { status: 'paused', note: null, returnOn: '2026-09-05', returnTime: null, setBy: 'user', setAt: NOW, candidate: null } });
    expect(present(store(paused)).statusPick).toMatchObject({ value: 'paused', auto: false });
  });
  it('自動で付いた Done は印と理由を添える', () => {
    const auto = session({ stats: { ...stats, turns: 2 }, state: { status: 'done', note: null, returnOn: null, returnTime: null, setBy: 'import', setAt: NOW, candidate: null } });
    expect(present(store(auto)).statusPick).toEqual({ value: 'done', auto: true, title: 'hangar が自動で Done にしました（3 ターン以下で終了した会話）' });
  });
  it('本文が消えた会話には出さない', () => {
    expect(present(store(session({ hasTranscript: false, lastActivityAt: NOW - 40 * 86_400_000 }))).statusPick).toBeNull();
  });
});

describe('opencode の会話の「いま」の札（計画の C5）', () => {
  const ocStats = { ...stats, model: 'lmstudio/qwen3.8-27b', contextPercent: 34, contextTokens: 13_600, costUsd: 0, turns: 1 };
  it('使用量（コンテキストの割合、トークン、コスト、モデル）を札に渡す', () => {
    const p = present(store(session({ provider: 'opencode', live: 'busy', stats: ocStats }), run()));
    expect(p.strip?.usage).toEqual({ percent: 34, percentLabel: '34%', chips: ['13.6k トークン', '$0.00', 'lmstudio/qwen3.8-27b'] });
  });
  it('意図が無ければ会話の最初の依頼を「初期プロンプト」で出す', () => {
    const p = present(store(session({ provider: 'opencode', live: 'busy', stats: ocStats, firstPrompt: 'tests/ に pytest の雛形を 3 本書いて' }), run()));
    expect(p.strip?.intent).toEqual({ kind: 'request', text: 'tests/ に pytest の雛形を 3 本書いて', label: '初期プロンプト' });
  });
  it('目次から左の画面を跳ばせるのは Claude Code の会話だけ（サーバの caps.promptJump）', () => {
    expect(present(store(session({ provider: 'opencode', live: 'busy', stats: ocStats }), run())).promptJump).toBe(false);
    expect(present(store(session({ live: 'busy' }), run())).promptJump).toBe(true);
  });
  it('Codex の会話も、同じ使用量の欄を出す（コスト無しならトークンとモデルだけ。caps.usagePanel）', () => {
    const cx = { ...stats, model: 'gpt-6-astra', contextPercent: 23, contextTokens: 61_200, costUsd: null, turns: 1 };
    const p = present(store(session({ provider: 'codex', live: 'busy', stats: cx }), run()));
    expect(p.strip?.usage).toEqual({ percent: 23, percentLabel: '23%', chips: ['61.2k トークン', 'gpt-6-astra'] });
  });
  it('Claude の会話には使用量を渡さない（ヘッダの 5 時間・週と見出しの (i) のまま）', () => {
    const p = present(store(session({ live: 'busy', stats: { ...stats, contextTokens: 13_600 } }), run()));
    expect(p.strip?.usage).toBeNull();
  });
});

describe('起動元と起こしたセッション（spawnedBy）', () => {
  const many = (...ss: SessionDto[]): Store => { const st = store(ss[0]!); st.sessions = Object.fromEntries(ss.map((s) => [s.id, s])); return st; };
  it('子の画面は起動元の id と名前を持ち、起動元が無ければ null（古いサーバの undefined も null）', () => {
    const parent = session({ id: 'p', name: '親の会話' });
    const child = session({ id: 's1', spawnedBy: 'p' });
    expect(present(many(child, parent)).spawnedFrom).toEqual({ id: 'p', name: '親の会話' });
    expect(present(many(child)).spawnedFrom).toBeNull();
    expect(present(many(session({ spawnedBy: null }))).spawnedFrom).toBeNull();
    expect(present(many(session())).spawnedFrom).toBeNull();
  });
  it('起動元の画面は、起こしたセッションを起動の古い順に並べ、状態を添える。無ければ空', () => {
    const me = session({ id: 's1' });
    const b = session({ id: 'b', name: 'B', spawnedBy: 's1', startedAt: NOW - 100, live: 'busy' });
    const a = session({ id: 'a', name: 'A', spawnedBy: 's1', startedAt: NOW - 200 });
    const other = session({ id: 'o', name: 'O', spawnedBy: 'zzz' });
    const kids = present(many(me, b, a, other)).spawned ?? [];
    expect(kids.map((k) => k.id)).toEqual(['a', 'b']);
    expect(kids[1]).toMatchObject({ name: 'B', live: 'busy' });
    expect(present(many(me, other)).spawned).toEqual([]);
  });
});
