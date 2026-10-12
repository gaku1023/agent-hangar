import { describe, expect, it } from 'vitest';
import { translator, type RunDto, type SessionDto, type SettingsDto, type TranscriptEvent } from '@agent-hangar/shared';
import { defaultSessionView } from '../mediator/sessionView.ts';
import { initialState } from '../mediator/transition.ts';
import { accountsFixture } from '../test/accounts.ts';
import { applyEventsPage, eventsKey, initialStore, type Store } from '../store/store.ts';
import { absoluteTime } from './format.ts';
import { presentSession } from './session.ts';

const ja = translator('ja');

const NOW = Date.parse('2026-09-02T12:00:00Z');
const stats = { turns: 11, model: 'claude-sonnet-4-5', effort: 'high', filesChanged: 3, prUrl: 'https://github.com/o/r/pull/88', inputTokens: 12_000, outputTokens: 8_000, contextPercent: 41, costUsd: 0.42 };
const session = (over: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: '画像の遅延読み込み', cwd: '/w/web-shop', firstPrompt: null, aiTitle: null, startedAt: NOW - 3_600_000, lastActivityAt: NOW - 60_000, 
  hasTranscript: true, live: null, summary: null, stats, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, ...over,
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

  describe('見出しの名前の横の札', () => {
    it('他の PC で実行中なら札を出す。無ければ空', () => {
      const lock = { deviceId: 'd2', deviceName: 'MacBook', runId: 'r9', heartbeatAt: NOW - 30_000, stale: false };
      expect(present(store(session({ lock }))).badges).toMatchObject([{ kind: 'lock', label: 'MacBook で実行中' }]);
      expect(present(store()).badges).toEqual([]);
    });
  });

  describe('詳細（i）の行', () => {
    const names = (p: ReturnType<typeof present>) => p.details.map((d) => d.name);
    it('モデル、effort レベル、権限モード、開始、作業ディレクトリ、起動、ターンとトークンを順に並べる', () => {
      const p = present(store(session({ live: 'busy' }), { ...run(), permissionMode: 'acceptEdits' }));
      expect(names(p)).toEqual(['モデル', 'effort レベル', '権限モード', '開始', '作業ディレクトリ', '起動', 'ターンとトークン', 'コンテキスト使用量', 'コスト', '変更したファイル', 'PR']);
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
      expect(names(present(store(bare)))).toEqual(['モデル', '開始', '作業ディレクトリ', 'ターンとトークン']);
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
      expect(names(present(st)).slice(0, 3)).toEqual(['Model', 'Effort level', 'Permission mode']);
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
