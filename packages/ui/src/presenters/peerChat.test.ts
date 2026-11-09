import { describe, expect, it } from 'vitest';
import { translator, type PeerChatItem, type PeerChatQueued, type SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { emptySlice, type PeerChatSlice } from '../store/peerChat.ts';
import { isPeerChatCandidate, permissionWord, presentPeerChat } from './peerChat.ts';
import { presentSession } from './session.ts';

const ja = translator('ja');
const NOW = Date.parse('2026-11-06T12:00:00Z');
const MAC = { deviceId: 'd-mac', deviceName: 'Mac' };
const stats = { turns: 3, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: 0 };
const session = (over: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: '同期の衝突を調べる', cwd: '/w/app', firstPrompt: null, aiTitle: null, startedAt: NOW - 3_600_000, lastActivityAt: NOW - 1000, lastTurnAt: NOW - 1000,
  hasTranscript: true, live: null, summary: null, stats, fromScratch: false, lock: { deviceId: 'd-mac', deviceName: 'Mac', runId: 'r9', heartbeatAt: NOW, stale: false }, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, ...over,
} as SessionDto);
const user = (uuid: string, text: string, from?: typeof MAC): PeerChatItem => ({ uuid, at: 1, kind: 'user', text, ...(from ? { from } : {}) });
const ai = (uuid: string, text: string): PeerChatItem => ({ uuid, at: 2, kind: 'assistant', text });
const tool = (uuid: string): PeerChatItem => ({ uuid, at: 3, kind: 'tool', text: 'Grep', tool: { name: 'Grep', summary: '"parent row" packages/server', ok: true } });
const ask = (answered = false): PeerChatItem => ({
  uuid: 'k1', at: 4, kind: 'permission', text: 'git push origin fix',
  ask: { askId: 'ask-1', kind: 'permission', tool: 'Bash', input: 'git push origin fix', options: [{ key: 'allow', label: 'Yes' }, { key: 'deny', label: 'No' }], multi: false, allowText: false, ...(answered ? { answered: { by: MAC, label: 'Yes', at: 9 } } : {}) },
});
const queued = (queueId: string, deviceId: string, text: string): PeerChatQueued => ({ queueId, from: { deviceId, deviceName: deviceId === 'me' ? 'Win' : 'Phone-PC' }, text, images: 0, at: 5, state: 'waiting' });

function store(slice: Partial<PeerChatSlice> | null, s: SessionDto = session()): Store {
  const st = initialStore();
  st.bootstrapped = true;
  st.device = { id: 'me', name: 'Win' };
  st.sessions = { [s.id]: s };
  if (slice) st.peerChat = { s1: { ...emptySlice('v1'), phase: 'live', device: MAC, status: 'idle', ...slice } };
  return st;
}
const view = (st: Store) => presentPeerChat(st, 's1', ja);

describe('ほかの PC の会話の画面の描き分け（presenters/peerChat）', () => {
  it('作業中は「預ける」で、中断を出し、預かりの案内を出す', () => {
    const v = view(store({ status: 'busy', items: [user('u1', '調べて')] }))!;
    expect(v).toMatchObject({ status: 'busy', statusLabel: '作業中', tone: 'busy', composer: { kind: 'queue', sendLabel: '預ける', canInterrupt: true, offline: null } });
    expect(v.composer.hint).toContain('止まってから渡します');
  });

  it('アイドルは「送る」で、中断は出さない', () => {
    const v = view(store({ status: 'idle' }))!;
    expect(v).toMatchObject({ tone: 'idle', composer: { kind: 'send', sendLabel: '送る', canInterrupt: false, hint: null, placeholder: 'Mac の会話に送る' } });
  });

  it('許可待ちは入力待ちで、送った文は預かる。中断は出さない（札が出ている間の Escape は札の断りになる）', () => {
    const v = view(store({ status: 'waiting', items: [ask()] }))!;
    expect(v).toMatchObject({ statusLabel: '入力待ち', tone: 'waiting', composer: { kind: 'queue', canInterrupt: false } });
    expect(v.composer.hint).toContain('許可か質問に答えるまで');
  });

  it('停止中は「{device} で再開して送る」で、再開して渡す', () => {
    const v = view(store({ status: 'stopped' }))!;
    expect(v).toMatchObject({ statusLabel: '停止中', tone: 'ended', composer: { kind: 'resume', sendLabel: 'Mac で再開して送る', canInterrupt: false } });
    expect(v.composer.hint).toContain('Mac は接続中です');
  });

  it('接続が切れていると、入力欄は閉じ、「この PC で再開」を出す。最後に知った状態の会話は残す', () => {
    const v = view(store({ link: 'offline', status: 'busy', items: [ai('a1', '見ます')] }))!;
    expect(v).toMatchObject({ statusLabel: '接続なし', composer: { kind: 'blocked', offline: 'Mac に接続できません', canTakeOver: true, canInterrupt: false } });
    expect(v.rows).toHaveLength(1);
  });

  describe('相手の PC の名前（見張りが一度も返事を得ていないとき）', () => {
    const peerRun = (over: Record<string, unknown> = {}) => ({ id: 'r1', sessionId: 's1', deviceId: 'd-mac', kind: 'resume', tmuxName: 't', pid: null, startedAt: 10, endedAt: null, endReason: null, heartbeatAt: 10, ...over }) as never;
    const device = (id: string, name: string) => ({ id, name, platform: 'darwin', lastSeenAt: null, self: false, shell: null });

    it('見張りの答えに名前が無くても、会話のロックの PC の名前を出す（案内にも使う）', () => {
      const v = view(store({ link: 'offline', device: null, status: null }))!;
      expect(v.device).toBe('Mac');
      expect(v.composer.offline).toBe('Mac に接続できません');
    });

    it('ロックが無くても（ほかの PC にだけ本文がある会話）、run の PC を同期の名簿で引いて名前を出す', () => {
      const st = store({ link: 'offline', device: null, status: null }, session({ lock: null, remoteOnly: true }));
      st.devices = [device('d-mac', 'MacBook-Pro.local')];
      st.runs = { r1: peerRun({ endedAt: 20, endReason: 'exit' }) };
      const v = presentPeerChat(st, 's1', ja)!;
      expect(v.device).toBe('MacBook-Pro.local');
      expect(v.composer.offline).toBe('MacBook-Pro.local に接続できません');
    });

    it('名前が空の答えでも、id を名簿で引いて補う。この PC の run は数えない', () => {
      const st = store({ link: 'offline', device: { deviceId: 'd-mac', deviceName: '' }, status: null }, session({ lock: null, remoteOnly: true }));
      st.devices = [device('d-mac', 'Mac'), device('me', 'Win')];
      st.runs = { r1: peerRun({ deviceId: 'me', startedAt: 99 }) };
      expect(presentPeerChat(st, 's1', ja)!.device).toBe('Mac');
    });

    it('どの出どころにも無ければ空のまま（落ちない）', () => {
      const st = store({ link: 'offline', device: null, status: null }, session({ lock: null, remoteOnly: true }));
      expect(presentPeerChat(st, 's1', ja)!.device).toBe('');
    });
  });

  it('元の PC の中の失敗（host-error）は、接続なしとは言わず、再試行を伝える。引き継ぎは出さない', () => {
    const v = view(store({ link: 'host-error', status: 'busy' }))!;
    expect(v).toMatchObject({ statusLabel: '再試行中', composer: { kind: 'blocked', offline: null, canTakeOver: false, canInterrupt: false, hint: '今は送れません。再試行しています' } });
  });

  it('読み込み中は loading で、状態はまだ無い', () => {
    const v = view(store({ phase: 'loading', status: null }))!;
    expect(v.loading).toBe(true);
    expect(v.status).toBeNull();
  });

  it('項目は種類ごとの行になり、ほかの PC から送った文には送り主が付く', () => {
    const v = view(store({ items: [user('u1', '調べて'), user('u2', '続けて', MAC), ai('a1', '見ます'), tool('t1')] }))!;
    expect(v.rows.map((r) => r.kind)).toEqual(['user', 'user', 'assistant', 'tool']);
    expect(v.rows[0]).toMatchObject({ from: null });
    expect(v.rows[1]).toMatchObject({ from: 'Mac から' });
    expect(v.rows[3]).toMatchObject({ name: 'Grep', ok: true });
  });

  it('許可の札は askId で行になり、答えが付けば答えの行（「Mac で許可」）になる', () => {
    const open = view(store({ status: 'waiting', items: [ask()] }))!.rows[0]!;
    expect(open).toMatchObject({ kind: 'ask', askId: 'ask-1', askKind: 'permission', title: '実行の許可', input: 'git push origin fix', answered: null });
    const closed = view(store({ status: 'busy', items: [ask(true)] }))!.rows[0]!;
    expect(closed).toMatchObject({ kind: 'ask', answered: 'Mac で許可' });
  });

  it('預かりは会話の末尾に並び、自分の預かりだけ取り消せる印が付く', () => {
    const v = view(store({ status: 'busy', items: [ai('a1', '見ます')], queued: [queued('q1', 'me', 'あとで'), queued('q2', 'phone', '別の PC の文')] }))!;
    expect(v.rows.map((r) => r.kind)).toEqual(['assistant', 'queued', 'queued']);
    expect(v.rows[1]).toMatchObject({ queueId: 'q1', mine: true, from: null, tag: '止まったら渡す' });
    expect(v.rows[2]).toMatchObject({ queueId: 'q2', mine: false, from: 'Phone-PC が預けた文' });
    // 預かりがあるときは、預かりの案内は出さない。
    expect(v.composer.hint).toBeNull();
  });

  it('渡している最中の預かりは、その旨を出す', () => {
    const v = view(store({ status: 'busy', queued: [{ ...queued('q1', 'me', 'あとで'), state: 'delivering' }] }))!;
    expect(v.rows[0]).toMatchObject({ delivering: true, tag: '渡しています' });
  });

  it('入力欄へ戻す文と、断りの理由の一言を運ぶ', () => {
    const v = view(store({ restore: { n: 2, text: '戻す文', images: [] }, notice: { n: 1, reason: 'resume-failed' } }))!;
    expect(v.restore).toEqual({ n: 2, text: '戻す文', images: [] });
    expect(v.notice).toEqual({ n: 1, text: 'Mac で再開できませんでした' });
    expect(view(store({ notice: { n: 1, reason: 'gone' } }))!.notice?.text).toBe('渡せなかったため入力欄に戻しました');
  });

  it('断りの理由は、全部に文がある（知らない理由は「送れませんでした」）', () => {
    for (const reason of ['offline', 'refused-by-setting', 'not-claude', 'session-unknown', 'expired', 'already-answered', 'ask-mismatch', 'resume-failed', 'queue-expired', 'too-large', 'rate', 'host-error', 'too-many'] as const) {
      expect(view(store({ notice: { n: 1, reason } }))!.notice?.text, reason).not.toBe('送れませんでした');
    }
    expect(view(store({ notice: { n: 1, reason: 'unreachable' } }))!.notice?.text).toBe('送れませんでした');
  });
});

describe('チャットを出さない会話は、今までの読み取り専用のトランスクリプトのまま', () => {
  it('見続けられなかった（理由つき）ときは null にして、トランスクリプトへ戻す', () => {
    expect(view(store({ phase: 'fallback', fallback: 'device-outdated' }))).toBeNull();
    expect(view(store({ phase: 'fallback', fallback: 'too-many' }))).toBeNull();
  });

  it('Codex と opencode の会話は、見張りも張らない', () => {
    for (const provider of ['codex', 'opencode'] as const) {
      const p = presentSession(initialState(), store(null, session({ provider })), NOW, 's1');
      expect(p.peerChat).toEqual({ watch: false, view: null });
    }
  });

  it('この PC の会話（ロックもリモートだけの印も無い）は、見張りを張らない', () => {
    const p = presentSession(initialState(), store(null, session({ lock: null, remoteOnly: false })), NOW, 's1');
    expect(p.peerChat?.watch).toBe(false);
  });

  it('ほかの PC の Claude Code の会話は、見張りを張る。ロックの無い本文だけ（remoteOnly）の会話も同じ', () => {
    expect(presentSession(initialState(), store(null), NOW, 's1').peerChat).toMatchObject({ watch: true, view: { loading: true, device: 'Mac' } });
    expect(presentSession(initialState(), store(null, session({ lock: null, remoteOnly: true })), NOW, 's1').peerChat?.watch).toBe(true);
  });

  it('見張りの状態が live なら、セッションの props に画面の値を載せる', () => {
    const p = presentSession(initialState(), store({ status: 'busy' }), NOW, 's1');
    expect(p.peerChat?.view).toMatchObject({ device: 'Mac', composer: { kind: 'queue' } });
  });

  it('ほかの PC に手元より新しい続きがある（A → B → A、止まっていて手元に古い写し）会話も、チャットの対象。この PC で再開も出せる', () => {
    const newer = session({ lock: null, remoteOnly: false, newerElsewhere: true });
    expect(isPeerChatCandidate(newer)).toBe(true);
    expect(isPeerChatCandidate(session({ lock: null, remoteOnly: false, newerElsewhere: false }))).toBe(false);
    const v = view(store({ status: 'idle', link: 'offline' }, newer))!;
    expect(v.composer.canTakeOver).toBe(true);
  });

  it('間に合わなかった取り消し（cancel-late）の一言は、渡せなかったとは別の文', () => {
    const v = view(store({ status: 'busy', notice: { n: 1, reason: 'cancel-late' } }))!;
    expect(v.notice).toEqual({ n: 1, text: 'すでに渡したため取り消せません' });
  });

  it('時計のずれ（link が clock）は、入力欄を閉じ、時計を合わせるよう一言を出す。つながっていない表示にはしない', () => {
    const v = view(store({ status: 'busy', link: 'clock' }))!;
    expect(v).toMatchObject({ statusLabel: '時計が合いません', tone: 'ended', composer: { kind: 'blocked', offline: null, canInterrupt: false, canTakeOver: false } });
    expect(v.composer.hint).toBe('Mac と時計が合わないため届きません。時刻を合わせてください');
  });

  it('元の PC の手元で答えた札（label が空）は、選択肢を出さず「{device} で答えました」の行になる', () => {
    const it0 = { ...ask(true), ask: { ...ask(true).ask!, answered: { by: MAC, label: '', at: 9 } } };
    expect(view(store({ status: 'busy', items: [it0] }))!.rows[0]).toMatchObject({ kind: 'ask', answered: 'Mac で答えました' });
  });

  it('答えの付かない札でも、会話が入力待ちでなくなったか、後ろに項目が続いたら、閉じた札にする（開いたままにしない）', () => {
    const closed = (r: unknown) => (r as { answered: string | null }).answered;
    expect(closed(view(store({ status: 'busy', items: [ask()] }))!.rows[0])).toBe('確認は終わりました');
    expect(closed(view(store({ status: 'idle', items: [ask()] }))!.rows[0])).toBe('確認は終わりました');
    expect(closed(view(store({ status: 'waiting', items: [ask(), ai('a2', '続き')] }))!.rows[0])).toBe('確認は終わりました');
    // 入力待ちの最後の札と、状態がまだ分からない間（読み込み中）は開いている。
    expect(closed(view(store({ status: 'waiting', items: [ai('a0', '前'), ask()] }))!.rows[1])).toBeNull();
    expect(closed(view(store({ status: null, items: [ask()] }))!.rows[0])).toBeNull();
  });

  it('答えの行は、許可の選択肢の画面の文（Yes、Yes, and ask-again の形、No）を固定の語にする。合わなければ引用する', () => {
    expect(permissionWord(ja, 'Yes')).toBe('許可');
    expect(permissionWord(ja, "Yes, and don't ask again for mkdir -p zz commands in C:\\work\\w1")).toBe('今後も許可');
    expect(permissionWord(ja, 'No')).toBe('拒否');
    expect(permissionWord(ja, 'Yes, and switch to auto mode')).toBeNull();
    const ans = (label: string, kind: 'permission' | 'question' = 'permission') => view(store({ status: 'busy', items: [{ ...ask(true), kind, ask: { ...ask(true).ask!, kind, answered: { by: MAC, label, at: 9 } } }] }))!.rows[0] as { answered: string };
    expect(ans("Yes, and don't ask again for x").answered).toBe('Mac で今後も許可');
    expect(ans('No').answered).toBe('Mac で拒否');
    expect(ans('Yes, and switch to auto mode').answered).toBe('Mac で「Yes, and switch to auto mode」');
    // 質問は、許可の形に見えても引用する。
    expect(ans('Yes', 'question').answered).toBe('Mac で「Yes」');
  });

  it('答えを待っている札は pending、受け付けない設定の PC では札も入力欄も閉じる（理由を先に出す）', () => {
    const v = view(store({ status: 'waiting', items: [ask()], answering: ['ask-1'] }))!;
    expect(v.rows[0]).toMatchObject({ pending: true, locked: false });
    const l = view(store({ status: 'waiting', items: [ask()], locked: true }))!;
    expect(l.rows[0]).toMatchObject({ locked: true });
    expect(l.composer).toMatchObject({ kind: 'blocked', canInterrupt: false, offline: null, hint: 'Mac は、他の PC からの操作を受け付けない設定です' });
  });

  it('元の PC が答えられないと印を付けた札（answerable が false）は、元の PC で答える案内を出す。印の無い札は出さない', () => {
    const unanswerable = { ...ask(), ask: { ...ask().ask!, answerable: false as const } };
    expect(view(store({ status: 'waiting', items: [unanswerable] }))!.rows[0]).toMatchObject({ hostOnly: 'Mac で答えてください' });
    expect(view(store({ status: 'waiting', items: [ask()] }))!.rows[0]).toMatchObject({ hostOnly: null });
    // 閉じた札（入力待ちでなくなった、後ろに項目が続いた）にも案内は出さない。
    expect(view(store({ status: 'idle', items: [unanswerable] }))!.rows[0]).toMatchObject({ hostOnly: null, answered: '確認は終わりました' });
    expect(view(store({ status: 'waiting', items: [unanswerable, ai('a2', '続き')] }))!.rows[0]).toMatchObject({ hostOnly: null, answered: '確認は終わりました' });
    // 答えが付いた札は、答えの行を優先する（案内は出さない）。
    const answered = { ...unanswerable, ask: { ...unanswerable.ask, answered: { by: MAC, label: '', at: 9 } } };
    expect(view(store({ status: 'waiting', items: [answered] }))!.rows[0]).toMatchObject({ hostOnly: null, answered: 'Mac で答えました' });
  });
});
