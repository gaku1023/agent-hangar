import { describe, expect, it } from 'vitest';
import type { OpencodeStatusDto, SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentSettings } from './settings.ts';

// 設定の「連携 › opencode」（ベータ、試作の D1）。
const SETTINGS: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
const FOUND: OpencodeStatusDto = { found: true, version: '2.2.4', verified: true };
const store = (settings: Partial<SettingsDto> = {}, status: OpencodeStatusDto | null = FOUND): Store => ({ ...initialStore(), settings: { ...SETTINGS, ...settings }, opencodeStatus: status });
const present = (s: Store, platform = 'darwin') => presentSettings({ ...initialState(), screen: { name: 'settings' } }, s, Date.now(), platform).opencode;

describe('設定の opencode の面', () => {
  it('この項目を知らない古いサーバの答えでは、切と最小限として読む', () => {
    const p = present(store());
    expect(p.available).toBe(true);
    expect(p.enabled).toBe(false);
    expect(p.injection).toBe('minimal');
    expect(p.claudeNote).toBeNull();
  });

  it('追記の選択肢は最小限、Claude Code と同じ、追記しないの順', () => {
    expect(present(store()).injectionOptions).toEqual([
      { value: 'minimal', label: '最小限（意図・要約・状態）' },
      { value: 'claude', label: 'Claude Code と同じ' },
      { value: 'none', label: '追記しない' },
    ]);
  });

  it('「Claude Code と同じ」を選んでいるときだけ注記を添える', () => {
    expect(present(store({ opencodeEnabled: true, opencodeInjection: 'claude' })).claudeNote).toBe('モデルによっては、状態の提案を確認せずに確定させることがあります。');
    expect(present(store({ opencodeEnabled: true, opencodeInjection: 'none' })).claudeNote).toBeNull();
  });

  it('検証済みの版は、手元の版と確かめた範囲と「検証済み」の札を出す', () => {
    const p = present(store({ opencodeEnabled: true }));
    expect(p.version).toEqual({ kind: 'verified', installed: '2.2.4', verified: '2.2.x', note: null });
    expect(p.badge).toEqual({ text: '検証済み', tone: 'ok' });
  });

  it('範囲の外の版は「未検証のバージョン」の札と、知らせと同じ注意を出す', () => {
    const p = present(store({ opencodeEnabled: true }, { found: true, version: '2.3.0', verified: false }));
    expect(p.version).toEqual({ kind: 'unverified', installed: '2.3.0', verified: '2.2.x', note: '未検証のバージョンです。API の変更により、状態や権限確認が正しく表示されない可能性があります。' });
    expect(p.badge).toEqual({ text: '未検証のバージョン', tone: 'info' });
  });

  it('1.x は対応していない版として出す', () => {
    const p = present(store({ opencodeEnabled: true }, { found: true, version: '1.0.150', verified: false }));
    expect(p.version).toMatchObject({ kind: 'legacy', installed: '1.0.150', note: 'opencode 1.x には対応していません。2.x に更新してください。' });
    expect(p.badge).toEqual({ text: '未対応のバージョン', tone: 'warn' });
  });

  it('見つからないときは PATH を確かめる文を出す', () => {
    const p = present(store({ opencodeEnabled: true }, { found: false, version: null, verified: false }));
    expect(p.version).toEqual({ kind: 'missing', installed: null, verified: '2.2.x', note: 'opencode が見つかりません（PATH を確認してください）。' });
    expect(p.badge).toEqual({ text: '見つかりません', tone: 'warn' });
  });

  it('見つかったが版を読めないときは、その旨を出す', () => {
    const p = present(store({ opencodeEnabled: true }, { found: true, version: null, verified: false }));
    expect(p.version).toMatchObject({ kind: 'unknown', installed: null, note: 'バージョンを読み取れませんでした。' });
    expect(p.badge).toEqual({ text: 'バージョン不明', tone: 'info' });
  });

  it('答えが届く前は版を null にし、札を出さない', () => {
    const p = present(store({ opencodeEnabled: true }, null));
    expect(p.version).toBeNull();
    expect(p.badge).toBeNull();
  });

  it('Windows でも面を出す（Windows の実機で確かめた）', () => {
    expect(present(store({ opencodeEnabled: true }), 'win32').available).toBe(true);
    expect(present(store({ opencodeEnabled: true }), 'linux').available).toBe(true);
  });

  it('コマンドの横取りは、古いサーバの答えでは切。macOS と Linux だけで出し、Windows では出さない', () => {
    expect(present(store({ opencodeEnabled: true })).intercept).toEqual({ available: true, on: false, note: null });
    expect(present(store({ opencodeEnabled: true, opencodeIntercept: true })).intercept.on).toBe(true);
    expect(present(store({ opencodeEnabled: true }), 'linux').intercept.available).toBe(true);
    expect(present(store({ opencodeEnabled: true }), 'win32').intercept.available).toBe(false);
  });

  it('コマンドの実行前の確認（許可のひな形）は、古いサーバの答えでは入り。利用者の opencode.json が許可を決めていれば、切に見せて無効にし、注記を添える', () => {
    expect(present(store({ opencodeEnabled: true })).permissionPreset).toEqual({ on: true, byConfig: false, note: null });
    expect(present(store({ opencodeEnabled: true, opencodePermissionPreset: false })).permissionPreset.on).toBe(false);
    const mine = present(store({ opencodeEnabled: true }, { ...FOUND, configPermissions: true })).permissionPreset;
    expect(mine).toEqual({ on: false, byConfig: true, note: 'opencode.json の permission 設定が適用されています。' });
  });

  it('この PC にシェル連携が入っていなければ、横取りの行に入れ方を添える。状態が届く前と入っているときは添えない', () => {
    const hook = (state: 'on' | 'off' | 'unsupported'): Store => ({ ...store({ opencodeEnabled: true }), shellHook: { state, zshrc: '/u/.zshrc', line: 'x', command: 'hangar shell install', osSupported: true } });
    expect(present(hook('off')).intercept.note).toBe('この PC にシェル連携をインストールすると使えます。');
    expect(present(hook('unsupported')).intercept.note).toBe('この PC にシェル連携をインストールすると使えます。');
    expect(present(hook('on')).intercept.note).toBeNull();
    expect(present(store({ opencodeEnabled: true })).intercept.note).toBeNull();
  });

  it('英語の文面', () => {
    const en = present(store({ language: 'en', opencodeEnabled: true, opencodeInjection: 'claude' }, { found: true, version: '2.3.0', verified: false }));
    expect(en.injectionOptions.map((o) => o.label)).toEqual(['Minimal (intent, summary, status)', 'Same as Claude Code', 'None']);
    expect(en.claudeNote).toBe('Some models may confirm status proposals without asking you.');
    expect(en.badge).toEqual({ text: 'Unverified version', tone: 'info' });
    expect(en.version?.note).toBe('This version is unverified. API changes may cause status and permission checks to display incorrectly.');
    const missing = present(store({ language: 'en', opencodeEnabled: true }, { found: false, version: null, verified: false }));
    expect(missing.version?.note).toBe('opencode not found (check your PATH).');
    expect(missing.badge?.text).toBe('Not found');
    expect(present(store({ language: 'en', opencodeEnabled: true })).badge?.text).toBe('Verified');
    expect(present({ ...store({ language: 'en', opencodeEnabled: true }), shellHook: { state: 'off', zshrc: '/u/.zshrc', line: 'x', command: 'hangar shell install', osSupported: true } }).intercept.note).toBe('Install the shell integration on this PC to use this.');
  });

  it('追記の全文は選んでいる量で組み、Claude と同じスイッチが効く', () => {
    expect(present(store({ opencodeEnabled: true })).full.map((p) => p.label)).toEqual(['最小限（意図・要約・状態）', '作業の区切りで Done／Paused を確認する（オン）']);
    const claude = present(store({ opencodeEnabled: true, opencodeInjection: 'claude', liveHints: false }));
    expect(claude.full).toHaveLength(5);
    expect(claude.full[4]!.off).toBe(true);
    expect(present(store({ opencodeEnabled: true, opencodeInjection: 'none' })).full).toEqual([]);
  });
});

describe('設定の opencode の面の使っていないモデルのアンロード', () => {
  it('目盛りは 1、3、5（推奨）、10、15、30 分、1 時間、しないの順。項目が無いか形が違えば 5 分', () => {
    const p = present(store({ opencodeEnabled: true })).idleUnload;
    expect(p.value).toBe(5);
    expect(p.stops.map((s) => s.value)).toEqual([1, 3, 5, 10, 15, 30, 60, 0]);
    expect(p.stops.map((s) => s.tick)).toEqual(['1 分', '3 分', '5 分', '10 分', '15 分', '30 分', '1 時間', 'しない']);
    expect(p.stops.find((s) => s.value === 5)!.label).toBe('5 分（推奨）');
    expect(p.stops.find((s) => s.value === 60)!.label).toBe('1 時間');
    expect(p.stops.find((s) => s.value === 0)!.label).toBe('しない');
    expect(present(store({ opencodeIdleUnload: 0 })).idleUnload.value).toBe(0);
    expect(present(store({ opencodeIdleUnload: 7 })).idleUnload.value).toBe(5);
  });
  it('英語の辞書で出す', () => {
    expect(present(store({ language: 'en' })).idleUnload.stops.find((s) => s.value === 5)!.label).toBe('5 min (Recommended)');
  });
});

describe('設定の opencode の面のローカルモデルのコンテキスト長', () => {
  it('選べる長さは 32K、64K（推奨）、128K。項目が無いか形が違えば 64K', () => {
    const p = present(store({ opencodeEnabled: true })).localContext;
    expect(p.value).toBe(65_536);
    expect(p.options).toEqual([{ value: 32_768, label: '32K' }, { value: 65_536, label: '64K（推奨）' }, { value: 131_072, label: '128K' }]);
    expect(present(store({ opencodeEnabled: true, opencodeLocalContext: 131_072 })).localContext.value).toBe(131_072);
    expect(present(store({ opencodeEnabled: true, opencodeLocalContext: 1234 })).localContext.value).toBe(65_536);
  });
  it('英語の辞書で出す', () => {
    expect(present(store({ language: 'en', opencodeEnabled: true })).localContext.options.map((o) => o.label)).toEqual(['32K', '64K (Recommended)', '128K']);
  });
});
