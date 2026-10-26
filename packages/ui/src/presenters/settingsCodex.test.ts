import { describe, expect, it } from 'vitest';
import type { CodexStatusDto, SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentSettings } from './settings.ts';

// 設定の「連携 › Codex」（ベータ、C4 の案 A）。
const FOUND: CodexStatusDto = { found: true, version: '0.164.2', verified: true, loggedIn: true };
const store = (settings: Partial<SettingsDto> = {}, status: CodexStatusDto | null = FOUND): Store => ({ ...initialStore(), settings: { ...(initialStore().settings ?? {}), ...settings } as SettingsDto, codexStatus: status });
const present = (s: Store, platform = 'darwin') => presentSettings({ ...initialState(), screen: { name: 'settings' } }, s, Date.now(), platform).codex;

describe('設定の Codex の面', () => {
  it('この項目を知らない古いサーバの答えでは、切と最小限として読む', () => {
    const p = present(store());
    expect(p.enabled).toBe(false);
    expect(p.injection).toBe('minimal');
    expect(p.intercept.on).toBe(false);
  });
  it('追記の選択肢は最小限、Claude Code と同じ、追記しないの順', () => {
    expect(present(store()).injectionOptions.map((o) => o.value)).toEqual(['minimal', 'claude', 'none']);
  });
  it('検証済みの版は、手元の版と確かめた範囲と「検証済み」の札を出す', () => {
    const p = present(store({ codexEnabled: true }));
    expect(p.version).toEqual({ kind: 'verified', installed: '0.164.2', verified: '0.164.x', note: null, login: null });
    expect(p.badge).toEqual({ text: '検証済み', tone: 'ok' });
  });
  it('範囲の外の版は「未検証のバージョン」と注記（app-server の変更）', () => {
    const p = present(store({ codexEnabled: true }, { ...FOUND, version: '0.170.0', verified: false }));
    expect(p.version?.kind).toBe('unverified');
    expect(p.version?.note).toContain('app-server');
    expect(p.badge).toEqual({ text: '未検証のバージョン', tone: 'info' });
  });
  it('見つからないときは「見つかりません」の札と PATH の注記で、ログインの注記は出さない', () => {
    const p = present(store({ codexEnabled: true }, { found: false, version: null, verified: false, loggedIn: false }));
    expect(p.version).toEqual({ kind: 'missing', installed: null, verified: '0.164.x', note: 'codex が見つかりません（PATH を確認してください）。', login: null });
    expect(p.badge).toEqual({ text: '見つかりません', tone: 'warn' });
  });
  it('ログインしていないときだけ、版の行の下に注記を足す（札は検証済みのまま）', () => {
    const p = present(store({ codexEnabled: true }, { ...FOUND, loggedIn: false }));
    expect(p.version?.login).toBe('codex にログインしていません（ターミナルで codex login を実行してください）。');
    expect(p.badge).toEqual({ text: '検証済み', tone: 'ok' });
  });
  it('ログインが分からないとき（null）は、注記を出さない', () => {
    const p = present(store({ codexEnabled: true }, { ...FOUND, loggedIn: null }));
    expect(p.version?.login).toBeNull();
  });
  it('答えが届く前は版も札も無い。コマンドの横取りは Windows では出さない', () => {
    const p = present(store({ codexEnabled: true }, null));
    expect([p.version, p.badge]).toEqual([null, null]);
    expect(present(store(), 'win32').intercept.available).toBe(false);
    expect(present(store(), 'darwin').intercept.available).toBe(true);
  });
});
