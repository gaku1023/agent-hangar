import { describe, expect, it } from 'vitest';
import type { SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentSettings } from './settings.ts';

const SETTINGS: SettingsDto = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
const store = (over: Partial<SettingsDto> = {}): Store => ({ ...initialStore(), settings: { ...SETTINGS, ...over } });
const present = (s: Store, platform = 'darwin') => presentSettings({ ...initialState(), screen: { name: 'settings' } }, s, 0, platform).notifyRules;

describe('設定の知らせ方の欄', () => {
  it('決まりがあれば、引用と出し先ごとの段階を出す。全部はすべて、空はオフ、ほかは場面を done・ask・progress の順に中黒で並べる', () => {
    const p = present(store({ notifyPreference: { text: '終わったときだけ教えて', unread: ['progress', 'ask', 'done'], os: [], phone: ['ask', 'done'] } }));
    expect(p.quote).toBe('終わったときだけ教えて');
    expect(p.defaultText).toBeNull();
    expect(p.rows.map((r) => [r.name, r.level, r.off])).toEqual([
      ['未読数', 'すべて', false], ['Mac の通知', 'オフ', true], ['スマホの通知', '済んだ・判断が要る', false],
    ]);
  });
  it('未設定は、引用の代わりに既定の文を出し、決まりは既定を読む', () => {
    const p = present(store());
    expect(p.quote).toBeNull();
    expect(p.defaultText).toBe('返答のたびに未読数を増やす。Mac とスマホの通知は、依頼が済んだときと判断が要るときだけ。');
    expect(p.rows.map((r) => [r.name, r.level])).toEqual([['未読数', 'すべて'], ['Mac の通知', '済んだ・判断が要る'], ['スマホの通知', '済んだ・判断が要る']]);
  });
  it('未設定で古いスイッチが切なら、その出し先はオフに読む', () => {
    expect(present(store({ unreadOs: false })).rows[1]).toMatchObject({ name: 'Mac の通知', level: 'オフ', off: true });
  });
  it('OS の名前は画面を開いている OS で替える。英語の段階も出す', () => {
    expect(present(store(), 'win32').rows[1]!.name).toBe('Windows の通知');
    expect(present(store(), 'linux').rows[1]!.name).toBe('OS の通知');
    expect(present(store({ language: 'en' }), 'darwin').rows[1]!.name).toBe('Mac notifications');
    expect(present(store({ language: 'en', notifyPreference: { text: 'x', unread: ['done'], os: ['ask', 'progress'], phone: [] } })).rows.map((r) => r.level)).toEqual(['Done', 'Needs you · Progress', 'Off']);
  });
  it('種の依頼文は、決まりがあれば今の決まりを引用し、なければ決めたい旨にする。引用の欄は空', () => {
    expect(present(store({ notifyPreference: { text: '静かに', unread: [], os: [], phone: [] } })).seed).toEqual({ request: '知らせ方を変えたい。今の決まりは「静かに」。どう変えたいか聞いて。', quote: '' });
    expect(present(store()).seed).toEqual({ request: '知らせ方を決めたい。どう知らせてほしいか聞いて。', quote: '' });
  });
});
