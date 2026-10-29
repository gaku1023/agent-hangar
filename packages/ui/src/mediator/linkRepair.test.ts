import { describe, expect, it } from 'vitest';
import type { LinkConflictsDto } from '@agent-hangar/shared';
import { codexAccountsFixture } from '../test/accounts.ts';
import { initialStore, type Store } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

const action = (i: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: i });
const runtime = (event: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event });

const store: Store = { ...initialStore(), accounts: codexAccountsFixture };
const side = (text: string | null) => ({ text, mtimeMs: 1, size: 10 });
const detail = (names: string[] = ['settings.json']): LinkConflictsDto => ({
  accountId: 'a1', agent: 'claude-code',
  entries: names.map((name) => ({ name, kind: 'file' as const, mine: side('a'), shared: side('b') })),
});
const base = (): State => ({ ...initialState(), screen: { name: 'home', q: '' } }) as State;
const opened = (s: State = base()): State => transition(s, store, action({ type: 'linkRepair.open', agent: 'claude-code', accountId: 'a1' })).state;
const loaded = (s: State = opened()): State => transition(s, store, runtime({ type: 'linkRepair.loaded', detail: detail() })).state;

describe('リンクの修復のダイアログを開く', () => {
  it('何も出ていなければ開き、両側の中身を読みに行く', () => {
    const r = transition(base(), store, action({ type: 'linkRepair.open', agent: 'codex', accountId: 'cw' }));
    expect(r.state.overlay).toEqual({ kind: 'linkRepair', agent: 'codex', accountId: 'cw', back: null });
    expect(r.state.linkRepair).toEqual({ detail: null, working: false, error: null });
    expect(r.effects).toEqual([{ kind: 'api.linkRepair.load', agent: 'codex', accountId: 'cw' }]);
  });
  it('新しいセッションのダイアログから開いたときは、そのダイアログを戻り先に覚える', () => {
    const ns = transition(base(), store, action({ type: 'session.new.open', projectId: 'p1' })).state;
    const r = transition(ns, store, action({ type: 'linkRepair.open', agent: 'claude-code', accountId: 'a1' }));
    expect(r.state.overlay).toMatchObject({ kind: 'linkRepair', back: { kind: 'newSession', projectId: 'p1' } });
    expect(r.effects).toHaveLength(1);
  });
  it('確認など、決めるまで閉じないダイアログの上には重ねない', () => {
    const confirm = transition(base(), store, action({ type: 'account.remove', accountId: 'a1' })).state;
    const r = transition(confirm, store, action({ type: 'linkRepair.open', agent: 'claude-code', accountId: 'a1' }));
    expect(r.state.overlay.kind).toBe('confirm');
    expect(r.effects).toEqual([]);
  });
});

describe('読み込みと直す操作', () => {
  it('届いた中身を持つ。ダイアログが閉じたあとに届いたものは捨てる', () => {
    expect(loaded().linkRepair.detail).toEqual(detail());
    const r = transition(base(), store, runtime({ type: 'linkRepair.loaded', detail: detail() }));
    expect(r.state.linkRepair.detail).toBeNull();
  });
  it('項目が 1 つも無ければ（ほかで直した）、閉じる', () => {
    const r = transition(opened(), store, runtime({ type: 'linkRepair.loaded', detail: detail([]) }));
    expect(r.state.overlay.kind).toBe('none');
  });
  it('読めなかった理由はダイアログに残す', () => {
    const r = transition(opened(), store, runtime({ type: 'linkRepair.loadFailed', message: '読めません' }));
    expect(r.state.linkRepair.error).toBe('読めません');
    expect(r.state.overlay.kind).toBe('linkRepair');
  });
  it('apply は選んだとおりに送り、直している最中にする。二重には送らない', () => {
    const entries = [{ name: 'settings.json', keep: 'mine' as const }];
    const r = transition(loaded(), store, action({ type: 'linkRepair.apply', entries }));
    expect(r.state.linkRepair).toMatchObject({ working: true, error: null });
    expect(r.effects).toEqual([{ kind: 'api.linkRepair.apply', agent: 'claude-code', accountId: 'a1', entries }]);
    expect(transition(r.state, store, action({ type: 'linkRepair.apply', entries })).effects).toEqual([]);
  });
  it('中身が届く前と、選びが空のときは送らない', () => {
    const entries = [{ name: 'settings.json', keep: 'shared' as const }];
    expect(transition(opened(), store, action({ type: 'linkRepair.apply', entries })).effects).toEqual([]);
    expect(transition(loaded(), store, action({ type: 'linkRepair.apply', entries: [] })).effects).toEqual([]);
  });
  it('断られたら、理由をダイアログに残して押せる状態に戻す', () => {
    const working = transition(loaded(), store, action({ type: 'linkRepair.apply', entries: [{ name: 'settings.json', keep: 'mine' }] })).state;
    const r = transition(working, store, runtime({ type: 'linkRepair.failed', message: '断られました' }));
    expect(r.state.linkRepair).toMatchObject({ working: false, error: '断られました' });
    expect(r.state.overlay.kind).toBe('linkRepair');
  });
});

describe('直せた', () => {
  it('ダイアログを閉じ、アカウントと項目を言う知らせを出す', () => {
    const r = transition(loaded(), store, runtime({ type: 'linkRepair.done', names: ['settings.json', 'CLAUDE.md'] }));
    expect(r.state.overlay.kind).toBe('none');
    expect(r.state.linkRepair).toEqual({ detail: null, working: false, error: null });
    expect(r.effects).toEqual([{ kind: 'toast', level: 'info', message: '大学 の settings.json、CLAUDE.md を共有に戻しました' }]);
  });
  it('Codex のアカウントは Codex の一覧から名前を引く', () => {
    const s = transition(base(), store, action({ type: 'linkRepair.open', agent: 'codex', accountId: 'cw' })).state;
    const r = transition(s, store, runtime({ type: 'linkRepair.done', names: ['config.toml'] }));
    expect(r.effects).toEqual([{ kind: 'toast', level: 'info', message: '会社用 の config.toml を共有に戻しました' }]);
  });
  it('新しいセッションのダイアログから来たときは、そこへ戻り、起動の失敗の行を消す', () => {
    const ns = transition(base(), store, action({ type: 'session.new.open', projectId: 'p1' })).state;
    const failed = transition(ns, store, runtime({ type: 'launch.failed', message: 'x', linkConflict: { agent: 'claude-code', accountId: 'a1' } })).state;
    const open = transition(failed, store, action({ type: 'linkRepair.open', agent: 'claude-code', accountId: 'a1' })).state;
    const r = transition(open, store, runtime({ type: 'linkRepair.done', names: ['settings.json'] }));
    expect(r.state.overlay).toMatchObject({ kind: 'newSession', projectId: 'p1' });
    expect(r.state.launch).toEqual({ kind: 'idle' });
  });
});

describe('閉じる', () => {
  it('Esc などで閉じる。直している最中は閉じない', () => {
    expect(transition(loaded(), store, action({ type: 'overlay.close' })).state.overlay.kind).toBe('none');
    const working = transition(loaded(), store, action({ type: 'linkRepair.apply', entries: [{ name: 'settings.json', keep: 'mine' }] })).state;
    expect(transition(working, store, action({ type: 'overlay.close' })).state.overlay.kind).toBe('linkRepair');
  });
  it('新しいセッションのダイアログから来たときは、閉じるとそこへ戻る（失敗の行は残す）', () => {
    const ns = transition(base(), store, action({ type: 'session.new.open', projectId: 'p1' })).state;
    const failed = transition(ns, store, runtime({ type: 'launch.failed', message: 'x', linkConflict: { agent: 'claude-code', accountId: 'a1' } })).state;
    const open = transition(failed, store, action({ type: 'linkRepair.open', agent: 'claude-code', accountId: 'a1' })).state;
    const r = transition(open, store, action({ type: 'overlay.close' })).state;
    expect(r.overlay).toMatchObject({ kind: 'newSession', projectId: 'p1' });
    expect(r.launch).toMatchObject({ kind: 'failed' });
  });
});

describe('起動の失敗から入る', () => {
  const conflict = { agent: 'claude-code' as const, accountId: 'a1' };
  it('ダイアログが無ければ、トーストに「修復…」を付ける。押すとダイアログを開く操作を送る', () => {
    const r = transition(base(), store, runtime({ type: 'launch.failed', message: 'settings.json が共有設定から外れています', linkConflict: conflict }));
    expect(r.state.toasts).toEqual([{ id: '1', level: 'error', message: 'settings.json が共有設定から外れています', action: { label: '修復…', send: { type: 'linkRepair.open', ...conflict } } }]);
    expect(r.effects).toEqual([]);
    expect(r.state.launch).toMatchObject({ kind: 'failed', linkConflict: conflict });
  });
  it('新しいセッションのダイアログが開いていれば、トーストは重ねず、失敗の行が持つ', () => {
    const ns = transition(base(), store, action({ type: 'session.new.open', projectId: 'p1' })).state;
    const r = transition(ns, store, runtime({ type: 'launch.failed', message: 'x', linkConflict: conflict }));
    expect(r.state.toasts).toEqual([]);
    expect(r.state.launch).toMatchObject({ kind: 'failed', linkConflict: conflict });
  });
  it('衝突の印が無い失敗は、今までどおりの文だけのトースト', () => {
    const r = transition(base(), store, runtime({ type: 'launch.failed', message: 'x' }));
    expect(r.effects).toEqual([{ kind: 'toast', level: 'error', message: 'x' }]);
  });
});
