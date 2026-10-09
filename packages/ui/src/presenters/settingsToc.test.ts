import { describe, expect, it } from 'vitest';
import type { ReadinessDto, SettingsDto, SummarizerTestDto, SyncStatusBody } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentSettings, type SettingsTocRow } from './settings.ts';

const NOW = Date.parse('2026-10-09T12:00:00Z');

const SETTINGS: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
const SYNC: SyncStatusBody = { state: 'idle', paused: false, url: 'https://h.example', lastPushAt: null, lastPullAt: NOW - 3 * 60_000, pending: 0, error: null, deviceCount: 2, limitedUntil: null, skipped: [], sweepPending: null, oncePass: false };
const READY: ReadinessDto = {
  tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/opt/homebrew/bin/claude', ok: true, problem: null, version: '2.1.0' }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/w', exists: true, projectCount: 12 }, mcp: { registered: true, file: '/h/.claude.json' }, statusline: { command: null, scriptPath: '/h/s.sh', installed: true },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
};
const store = (over: Partial<Store> = {}): Store => ({ ...initialStore(), settings: SETTINGS, ...over });
const present = (s: Store, screen: State['screen'] = { name: 'settings' }) => presentSettings({ ...initialState(), screen }, s, NOW);
const row = (rows: SettingsTocRow[], id: string) => rows.find((r) => r.id === id)!;

describe('設定の目次（S1）', () => {
  it('節は 6 つで、一般、クラウド同期、連携、要約エンジン、ツール、情報の順', () => {
    const p = present(store());
    expect(p.toc.map((r) => r.id)).toEqual(['general', 'cloud', 'integrations', 'summary', 'tools', 'info']);
    expect(p.toc.map((r) => r.title)).toEqual(['一般', 'クラウド同期', '連携', '要約エンジン', 'ツール', '情報']);
  });
  it('どの行も、読み上げの名前に節の名前と今の状態を含む', () => {
    expect(row(present(store()).toc, 'cloud').label).toBe('クラウド同期、同期オフ');
  });
  it('準備の確かめが届く前、連携とツールは「確認中」と言う', () => {
    const p = present(store());
    expect(row(p.toc, 'integrations')).toMatchObject({ state: '確認中', tone: 'default' });
    expect(row(p.toc, 'tools')).toMatchObject({ state: '確認中', tone: 'default' });
  });
  it('連携は、直すものがあれば「要修正 N」を注意の色で、無ければ「問題なし」と言う', () => {
    const fix = present(store({ readiness: { ...READY, mcp: { registered: false, file: '/h/.claude.json' }, statusline: { command: null, scriptPath: null, installed: false } } }));
    expect(row(fix.toc, 'integrations')).toMatchObject({ state: '要修正 2', tone: 'warn', label: '連携、要修正 2' });
    expect(row(present(store({ readiness: READY })).toc, 'integrations')).toMatchObject({ state: '問題なし', tone: 'default' });
  });
  it('ツールは、動かせない道具（code は数えない）の数を「要修正 N」で、そろっていれば「すべて検出」と言う', () => {
    expect(row(present(store({ readiness: READY })).toc, 'tools')).toMatchObject({ state: 'すべて検出', tone: 'default' });
    const bad = { ...READY, tools: { ...READY.tools, tmux: { path: null, ok: false, problem: 'unset' as const, version: null } } };
    expect(row(present(store({ readiness: bad })).toc, 'tools')).toMatchObject({ state: '要修正 1', tone: 'warn' });
  });
  it('クラウド同期は、同期していなければ「同期オフ」、していれば状態と最終受信の相対時刻を言う', () => {
    expect(row(present(store()).toc, 'cloud').state).toBe('同期オフ');
    expect(row(present(store({ sync: SYNC })).toc, 'cloud')).toMatchObject({ state: '同期済み、3 分前', tone: 'default' });
    // 受信の時刻がまだ無ければ状態だけ。
    expect(row(present(store({ sync: { ...SYNC, lastPullAt: null } })).toc, 'cloud').state).toBe('同期済み');
  });
  it('クラウド同期は、一時停止、エラー、無料枠で停止を、それぞれの語で言う', () => {
    expect(row(present(store({ sync: { ...SYNC, state: 'paused', paused: true } })).toc, 'cloud').state).toBe('同期を一時停止中');
    expect(row(present(store({ sync: { ...SYNC, state: 'error', error: 'x' } })).toc, 'cloud')).toMatchObject({ state: '同期エラー', tone: 'warn' });
    // 無料枠で停止は、目次の幅に入るよう戻る時刻を添えない（時刻は節の中に出る）。
    expect(row(present(store({ sync: { ...SYNC, state: 'paused', limitedUntil: NOW + 3_600_000 } })).toc, 'cloud')).toMatchObject({ state: '無料枠で停止', tone: 'warn' });
  });
  it('一般は、通知の状態を言う。言語の行がまだ出ない間は、言語を言わない', () => {
    expect(row(present(store({ notify: { available: true, on: true, blocked: false } })).toc, 'general').state).toBe('通知オン');
    expect(row(present(store({ notify: { available: true, on: false, blocked: false } })).toc, 'general').state).toBe('通知オフ');
    expect(row(present(store({ notify: { available: false, on: false, blocked: false } })).toc, 'general').state).toBe('通知は使えません');
  });
  it('要約エンジンは、モデルの一覧が取れたか、接続テストの結果で言う', () => {
    expect(row(present(store()).toc, 'summary')).toMatchObject({ state: '確認中', tone: 'default' });
    expect(row(present(store({ summarizerModels: ['a'] })).toc, 'summary')).toMatchObject({ state: 'LM Studio、接続済み', tone: 'default' });
    expect(row(present(store({ summarizerModels: [] })).toc, 'summary')).toMatchObject({ state: 'LM Studio に接続できません', tone: 'warn' });
    const failed: SummarizerTestDto = { ok: false, tried: [{ id: 'lmstudio', message: 'x' }] };
    expect(row(present(store({ summarizerModels: ['a'], summarizerTest: failed })).toc, 'summary')).toMatchObject({ state: '接続テストに失敗', tone: 'warn' });
  });
  it('情報は、セッションの数を言う', () => {
    const s = store();
    s.sessions = { a: { id: 'a' } as never, b: { id: 'b' } as never };
    expect(row(present(s).toc, 'info').state).toBe('2 セッション');
  });
  it('言語が English なら、節の名前と状態も English で言う', () => {
    const p = present(store({ settings: { ...SETTINGS, language: 'en' } }));
    expect(p.toc.map((r) => r.title)).toEqual(['General', 'Cloud sync', 'Integrations', 'Summary engine', 'Tools', 'Info']);
    expect(row(p.toc, 'cloud').label).toBe('Cloud sync: Sync off');
    expect(row(p.toc, 'integrations').state).toBe('Checking');
  });
});

describe('設定の節の選び方', () => {
  const at = (a: Extract<State['screen'], { name: 'settings' }>['at']) => present(store(), a ? { name: 'settings', at: a } : { name: 'settings' });
  it('URL に節が無ければ「一般」、節の名前ならその節', () => {
    expect(at(undefined).section).toBe('general');
    for (const s of ['general', 'cloud', 'integrations', 'summary', 'tools', 'info'] as const) expect(at(s).section).toBe(s);
  });
  it('ヘッダーの同期の語（at=sync）はクラウド同期の節、アカウントの設定（at=accounts）は連携の節を開く', () => {
    expect(at('sync').section).toBe('cloud');
    expect(at('accounts').section).toBe('integrations');
  });
  it('アカウントの位置へ移る印は、at=accounts のときだけ立つ', () => {
    expect(at('accounts').focus).toBe('accounts');
    expect(at('sync').focus).toBeNull();
    // ベルの「送らなかった項目」の行から来たときは、クラウド同期の節の送らなかった項目の位置へ移る。
    expect(at('unsent').section).toBe('cloud');
    expect(at('unsent').focus).toBe('unsent');
    expect(at('integrations').focus).toBeNull();
    expect(at(undefined).focus).toBeNull();
  });
  it('設定の画面でなければ「一般」で、印も立たない', () => {
    const p = present(store(), { name: 'home' });
    expect(p.section).toBe('general');
    expect(p.focus).toBeNull();
  });
});

describe('言語の行', () => {
  it('目次の「一般」の状態は通知の状態だけで、言語の名前は添えない', () => {
    expect(row(present(store({ settings: { ...SETTINGS, language: 'en' }, notify: { available: true, on: true, blocked: false } })).toc, 'general').state).toBe('Notifications on');
  });
  it('いまの言語を値として渡す', () => {
    expect(present(store({ settings: { ...SETTINGS, language: 'en' } })).language.value).toBe('en');
    expect(present(store()).language.value).toBe('ja');
  });
});
