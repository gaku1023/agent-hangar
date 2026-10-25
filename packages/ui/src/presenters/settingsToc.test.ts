import { describe, expect, it } from 'vitest';
import type { ReadinessDto, SettingsDto, SummarizerTestDto, SyncStatusBody } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { initialUpdate } from '../store/update.ts';
import { presentSettings, type SettingsTocRow } from './settings.ts';

const NOW = Date.parse('2026-10-09T12:00:00Z');

const SETTINGS: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
const SYNC: SyncStatusBody = { state: 'idle', paused: false, url: 'https://h.example', lastPushAt: null, lastPullAt: NOW - 3 * 60_000, pending: 0, error: null, deviceCount: 2, limitedUntil: null, skipped: [], sweepPending: null, oncePass: false, diskShort: null };
const READY: ReadinessDto = {
  tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/opt/homebrew/bin/claude', ok: true, problem: null, version: '2.1.0' }, git: { path: '/usr/bin/git', ok: true, problem: null, version: '2.51.0' }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/w', exists: true, projectCount: 12 }, mcp: { registered: true, file: '/h/.claude.json' }, statusline: { command: null, scriptPath: '/h/s.sh', installed: true },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install', join: 'hangar cloud join <URL>' },
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
};
const store = (over: Partial<Store> = {}): Store => ({ ...initialStore(), settings: SETTINGS, ...over });
const present = (s: Store, screen: State['screen'] = { name: 'settings' }) => presentSettings({ ...initialState(), screen }, s, NOW);
const row = (rows: SettingsTocRow[], id: string) => rows.find((r) => r.id === id)!;

describe('設定の目次（S1）', () => {
  it('節は 8 つで、一般、セッション、要約、連携、環境、クラウド同期、使用量、Hangar についての順。クラウド同期だけにベータの印', () => {
    const p = present(store());
    expect(p.toc.map((r) => r.id)).toEqual(['general', 'sessions', 'summary', 'integrations', 'environment', 'cloud', 'usage', 'about']);
    expect(p.toc.map((r) => r.title)).toEqual(['一般', 'セッション', '要約', '連携', '環境', 'クラウド同期', '使用量', 'Hangar について']);
    expect(p.toc.filter((r) => r.beta).map((r) => r.id)).toEqual(['cloud']);
    expect(row(p.toc, 'cloud').label).toBe('クラウド同期 ベータ、同期オフ');
  });
  it('殻の中では、「Hangar について」が更新の状態を言う。節の並びはブラウザと同じ', () => {
    const update = { ...initialUpdate(), supported: true, current: '1.4.2', phase: { kind: 'latest' as const }, checkedAt: NOW };
    const p = present(store({ desktop: true, update }));
    expect(p.toc.map((r) => r.id)).toEqual(['general', 'sessions', 'summary', 'integrations', 'environment', 'cloud', 'usage', 'about']);
    expect(row(p.toc, 'about')).toMatchObject({ title: 'Hangar について', state: '最新', tone: 'default', label: 'Hangar について、最新' });
    expect(row(present(store({ desktop: true, update: { ...update, phase: { kind: 'ready', version: '1.5.0' } } })).toc, 'about')).toMatchObject({ state: '再起動待ち', tone: 'warn' });
    expect(row(present(store({ desktop: true, update: { ...update, phase: { kind: 'failed', step: 'download', version: '1.5.0', reason: 'network' } } })).toc, 'about')).toMatchObject({ state: '失敗', tone: 'warn' });
    // 節の中身は presentUpdateSection が組む。
    expect(p.update.badge).toEqual({ text: '最新', tone: 'ok' });
  });
  it('ブラウザでも「Hangar について」を出し、更新の状態の代わりにバージョンを言う', () => {
    const p = present(store({ desktop: false, version: '0.9.4' }));
    expect(row(p.toc, 'about')).toMatchObject({ title: 'Hangar について', state: 'バージョン 0.9.4', tone: 'default', label: 'Hangar について、バージョン 0.9.4' });
    expect(row(present(store({ desktop: false, version: '0.9.4', settings: { ...SETTINGS, language: 'en' } })).toc, 'about')).toMatchObject({ title: 'About Hangar', state: 'Version 0.9.4' });
  });
  it('どの行も、読み上げの名前に節の名前と今の状態を含む', () => {
    expect(row(present(store()).toc, 'cloud').label).toBe('クラウド同期 ベータ、同期オフ');
  });
  it('準備の確かめが届く前、連携と環境は「確認中」と言う', () => {
    const p = present(store());
    expect(row(p.toc, 'integrations')).toMatchObject({ state: '確認中', tone: 'default' });
    expect(row(p.toc, 'environment')).toMatchObject({ state: '確認中', tone: 'default' });
  });
  it('連携は、直すものがあれば「要修正 N」を注意の色で、無ければ「問題なし」と言う', () => {
    const fix = present(store({ readiness: { ...READY, mcp: { registered: false, file: '/h/.claude.json' }, statusline: { command: null, scriptPath: null, installed: false } } }));
    expect(row(fix.toc, 'integrations')).toMatchObject({ state: '要修正 2', tone: 'warn', label: '連携、要修正 2' });
    expect(row(present(store({ readiness: READY })).toc, 'integrations')).toMatchObject({ state: '問題なし', tone: 'default' });
  });
  it('環境は、動かせない道具（code は数えない）の数を「要修正 N」で、そろっていれば「すべて検出」と言う', () => {
    expect(row(present(store({ readiness: READY })).toc, 'environment')).toMatchObject({ state: 'すべて検出', tone: 'default' });
    const bad = { ...READY, tools: { ...READY.tools, tmux: { path: null, ok: false, problem: 'unset' as const, version: null } } };
    expect(row(present(store({ readiness: bad })).toc, 'environment')).toMatchObject({ state: '要修正 1', tone: 'warn' });
  });
  it('クラウド同期は、同期していなければ「同期オフ」、していれば状態と最終受信の相対時刻を言う', () => {
    expect(row(present(store()).toc, 'cloud').state).toBe('同期オフ');
    expect(row(present(store({ sync: SYNC })).toc, 'cloud')).toMatchObject({ state: '同期済み、3 分前', tone: 'default' });
    // 受信の時刻がまだ無ければ状態だけ。
    expect(row(present(store({ sync: { ...SYNC, lastPullAt: null } })).toc, 'cloud').state).toBe('同期済み');
  });
  it('クラウド同期は、一時停止、エラー、無料枠の上限で停止を、それぞれの語で言う', () => {
    expect(row(present(store({ sync: { ...SYNC, state: 'paused', paused: true } })).toc, 'cloud').state).toBe('同期を一時停止中');
    expect(row(present(store({ sync: { ...SYNC, state: 'error', error: 'x' } })).toc, 'cloud')).toMatchObject({ state: '同期エラー', tone: 'warn' });
    // 無料枠の上限で停止は、目次の幅に入るよう戻る時刻を添えない（時刻は節の中に出る）。
    expect(row(present(store({ sync: { ...SYNC, state: 'paused', limitedUntil: NOW + 3_600_000 } })).toc, 'cloud')).toMatchObject({ state: '無料枠の上限で停止', tone: 'warn' });
  });
  it('一般は、通知の状態を言う。言語の行がまだ出ない間は、言語を言わない', () => {
    expect(row(present(store({ notify: { available: true, on: true, blocked: false } })).toc, 'general').state).toBe('通知オン');
    expect(row(present(store({ notify: { available: true, on: false, blocked: false } })).toc, 'general').state).toBe('通知オフ');
    expect(row(present(store({ notify: { available: false, on: false, blocked: false } })).toc, 'general').state).toBe('通知は使えません');
  });
  it('要約は、使わないなら淡く「オフ」と言い、LM Studio に繋がらない警告を出さない', () => {
    expect(row(present(store()).toc, 'summary')).toMatchObject({ state: 'オフ', tone: 'default', label: '要約、オフ' });
    expect(row(present(store({ summarizerModels: [] })).toc, 'summary')).toMatchObject({ state: 'オフ', tone: 'default' });
    // 鍵を知らない古いサーバーの設定も「使わない」として読む。
    expect(row(present(store({ settings: { ...SETTINGS, summaryEngine: undefined } })).toc, 'summary').state).toBe('オフ');
  });
  it('要約のエンジンが Claude なら、使用枠を使うことを言う', () => {
    expect(row(present(store({ settings: { ...SETTINGS, summaryEngine: 'claude' } })).toc, 'summary')).toMatchObject({ state: 'Claude（使用量を消費）', tone: 'default' });
  });
  it('要約のエンジンが OpenAI 互換なら、モデルの一覧が取れたか、接続テストの結果で言う', () => {
    const openai = (over: Partial<Store> = {}) => store({ settings: { ...SETTINGS, summaryEngine: 'openai' }, ...over });
    expect(row(present(openai()).toc, 'summary')).toMatchObject({ state: '確認中', tone: 'default' });
    expect(row(present(openai({ summarizerModels: ['a'] })).toc, 'summary')).toMatchObject({ state: 'OpenAI 互換、接続済み', tone: 'default' });
    expect(row(present(openai({ summarizerModels: [] })).toc, 'summary')).toMatchObject({ state: 'OpenAI 互換に接続できません', tone: 'warn' });
    const failed: SummarizerTestDto = { ok: false, tried: [{ id: 'lmstudio', message: 'x' }] };
    expect(row(present(openai({ summarizerModels: ['a'], summarizerTest: failed })).toc, 'summary')).toMatchObject({ state: '接続テストに失敗', tone: 'warn' });
  });
  it('セッションは、セッションの数を言う', () => {
    const s = store();
    s.sessions = { a: { id: 'a' } as never, b: { id: 'b' } as never };
    expect(row(present(s).toc, 'sessions').state).toBe('2 セッション');
  });
  // 保持期間の日数は、注意の一覧から外し、目次の状態に残した（2026-10-13 の決定、9a）。保持の欄と同じセッションの節に置く。
  it('セッションは、保持期間が分かっていれば、その日数を先に言う（狭い目次で切れても日数が残る）', () => {
    const s = store({ retention: { days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null, usage: null } });
    s.sessions = { a: { id: 'a' } as never, b: { id: 'b' } as never };
    expect(row(present(s).toc, 'sessions').state).toBe('保持期間 30 日 · 2 セッション');
    const year = store({ settings: { ...SETTINGS, language: 'en' }, retention: { days: 365, source: 'user', userValue: 365, writable: true, unwritableReason: null, usage: null } });
    expect(row(present(year).toc, 'sessions').state).toBe('Retention 1 year · 0 sessions');
  });
  it('使用量は、直近 30 日のセッションの数をプロジェクト別の件数の和で言い、届く前は「確認中」', () => {
    expect(row(present(store()).toc, 'usage')).toMatchObject({ state: '確認中', tone: 'default' });
    const proj = (name: string, sessions: number) => ({ projectId: name, name, inputTokens: 0, outputTokens: 0, costUsd: null, sessions });
    // 日ごとの件数は日をまたぐ会話を重ねて数えるので、使わない。
    const usageAggregate = { days: [{ day: '2026-10-09', inputTokens: 0, outputTokens: 0, sessions: 99 }], projects: [proj('a', 3), proj('b', 1200)] };
    expect(row(present(store({ usageAggregate })).toc, 'usage')).toMatchObject({ state: '直近 30 日 · 1,203 セッション', tone: 'default' });
    expect(row(present(store({ usageAggregate, settings: { ...SETTINGS, language: 'en' } })).toc, 'usage').state).toBe('Last 30 days · 1,203 sessions');
  });
  it('言語が English なら、節の名前と状態も English で言う', () => {
    const p = present(store({ settings: { ...SETTINGS, language: 'en' } }));
    expect(p.toc.map((r) => r.title)).toEqual(['General', 'Sessions', 'Summary', 'Integrations', 'Environment', 'Cloud sync', 'Usage', 'About Hangar']);
    expect(row(p.toc, 'cloud').label).toBe('Cloud sync Beta: Sync off');
    expect(row(p.toc, 'integrations').state).toBe('Checking');
  });
});

describe('設定の節の選び方', () => {
  const at = (a: Extract<State['screen'], { name: 'settings' }>['at']) => present(store(), a ? { name: 'settings', at: a } : { name: 'settings' });
  it('URL に節が無ければ「一般」、節の名前ならその節', () => {
    expect(at(undefined).section).toBe('general');
    for (const s of ['general', 'sessions', 'summary', 'integrations', 'environment', 'cloud', 'usage', 'about'] as const) expect(at(s).section).toBe(s);
  });
  it('0.9.3 までの節の名前（at=tools、update、info）は、新しい節で開き、欄へ移る印は立てない', () => {
    expect(at('tools').section).toBe('environment');
    expect(at('update').section).toBe('about');
    expect(at('info').section).toBe('about');
    for (const s of ['tools', 'update', 'info'] as const) expect(at(s).focus).toBeNull();
  });
  it('ヘッダーの同期の語（at=sync）はクラウド同期の節、アカウントの設定（at=accounts）はセッションの節を開く', () => {
    expect(at('sync').section).toBe('cloud');
    expect(at('accounts').section).toBe('sessions');
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
  it('帯の「設定を開く」が指す欄（at=workspace、tmux、claude、compat）は、その節を開いて、欄へ移る印を立てる', () => {
    expect(at('workspace').section).toBe('sessions');
    expect(at('workspace').focus).toBe('workspace');
    for (const f of ['tmux', 'claude'] as const) {
      expect(at(f).section).toBe('environment');
      expect(at(f).focus).toBe(f);
    }
    expect(at('compat').section).toBe('integrations');
    expect(at('compat').focus).toBe('compat');
    // 節だけを指したとき（目次から選んだとき）は、欄へは移らない。
    expect(at('environment').focus).toBeNull();
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

describe('設定の一般：hangar が自分で行うこと', () => {
  it('自動の Done と自動の停止は、設定の値をそのまま出し、値が無ければ入り', () => {
    expect(present(store()).self).toEqual({ autoDone: true, autoDoneIdleDays: 7, autoPark: true });
    expect(present(store({ settings: { ...SETTINGS, autoDone: false, autoPark: true } })).self).toEqual({ autoDone: false, autoDoneIdleDays: 7, autoPark: true });
    expect(present(store({ settings: { ...SETTINGS, autoPark: false } })).self).toEqual({ autoDone: true, autoDoneIdleDays: 7, autoPark: false });
    // 日数を知らない古いサーバは 7 日として読み、選んだ値と 0（しない）はそのまま。
    expect(present(store({ settings: { ...SETTINGS, autoDoneIdleDays: 30 } })).self.autoDoneIdleDays).toBe(30);
    expect(present(store({ settings: { ...SETTINGS, autoDoneIdleDays: 0 } })).self.autoDoneIdleDays).toBe(0);
  });
});
