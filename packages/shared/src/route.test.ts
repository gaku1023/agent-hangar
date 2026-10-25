import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute, settingsSectionOf } from './route.ts';

describe('parseRoute', () => {
  it('空と #/ は home', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/')).toEqual({ name: 'home' });
  });
  it('各画面を読む', () => {
    expect(parseRoute('#/projects')).toEqual({ name: 'projects' });
    expect(parseRoute('#/project/p1')).toEqual({ name: 'project', id: 'p1' });
    expect(parseRoute('#/session/s1')).toEqual({ name: 'session', id: 's1' });
    expect(parseRoute('#/?q=%E5%8B%95%E7%94%BB%20x')).toEqual({ name: 'home', q: '動画 x' });
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('#/settings?at=accounts')).toEqual({ name: 'settings', at: 'accounts' });
    expect(parseRoute('#/settings?at=sync')).toEqual({ name: 'settings', at: 'sync' });
    expect(parseRoute('#/settings?at=unsent')).toEqual({ name: 'settings', at: 'unsent' });
    // 帯の「設定を開く」が指す欄。
    for (const at of ['workspace', 'tmux', 'claude', 'compat'] as const) expect(parseRoute(`#/settings?at=${at}`)).toEqual({ name: 'settings', at });
    for (const at of ['general', 'sessions', 'summary', 'integrations', 'environment', 'cloud', 'usage', 'about'] as const) expect(parseRoute(`#/settings?at=${at}`)).toEqual({ name: 'settings', at });
    // 0.9.3 までの節の名前も読む（殻のディープリンクと履歴に残っている）。
    for (const at of ['tools', 'update', 'info'] as const) expect(parseRoute(`#/settings?at=${at}`)).toEqual({ name: 'settings', at });
    // 知らない行き先は印なしの設定として読む。
    expect(parseRoute('#/settings?at=nope')).toEqual({ name: 'settings' });
  });
  it('セッションの一覧の画面は無くなった。#/sessions と #/sessions?q= はホームを開く別名として読み続ける', () => {
    expect(parseRoute('#/sessions')).toEqual({ name: 'home' });
    expect(parseRoute('#/sessions?q=%E5%8B%95%E7%94%BB%20x')).toEqual({ name: 'home', q: '動画 x' });
    expect(parseRoute('#/sessions?q=')).toEqual({ name: 'home' });
  });
  it('知らない経路は home', () => {
    expect(parseRoute('#/nope/1')).toEqual({ name: 'home' });
  });
});

describe('formatRoute', () => {
  it('parseRoute と往復する', () => {
    const routes = [
      { name: 'home' }, { name: 'projects' }, { name: 'project', id: 'p1' },
      { name: 'session', id: 's1' }, { name: 'home', q: '動画 x' }, { name: 'settings' }, { name: 'settings', at: 'accounts' }, { name: 'settings', at: 'sync' }, { name: 'settings', at: 'unsent' }, { name: 'settings', at: 'workspace' }, { name: 'settings', at: 'tmux' }, { name: 'settings', at: 'claude' }, { name: 'settings', at: 'compat' },
      { name: 'settings', at: 'general' }, { name: 'settings', at: 'cloud' }, { name: 'settings', at: 'integrations' }, { name: 'settings', at: 'summary' }, { name: 'settings', at: 'sessions' }, { name: 'settings', at: 'environment' }, { name: 'settings', at: 'usage' }, { name: 'settings', at: 'about' },
    ] as const;
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
  });
  it('ホームは #/、検索語があれば #/?q= と書き、#/sessions は書かない', () => {
    expect(formatRoute({ name: 'home' })).toBe('#/');
    expect(formatRoute({ name: 'home', q: '動画 x' })).toBe('#/?q=%E5%8B%95%E7%94%BB%20x');
  });
});

describe('settingsSectionOf', () => {
  it('無ければ「一般」、節の名前ならその節', () => {
    expect(settingsSectionOf(undefined)).toBe('general');
    for (const at of ['general', 'sessions', 'summary', 'integrations', 'environment', 'cloud', 'usage', 'about'] as const) expect(settingsSectionOf(at)).toBe(at);
  });
  it('0.9.3 までの節の名前は、移った先の節', () => {
    expect(settingsSectionOf('tools')).toBe('environment');
    expect(settingsSectionOf('update')).toBe('about');
    expect(settingsSectionOf('info')).toBe('about');
  });
  it('sync と unsent はクラウド同期、accounts はセッションの別名', () => {
    expect(settingsSectionOf('sync')).toBe('cloud');
    expect(settingsSectionOf('unsent')).toBe('cloud');
    expect(settingsSectionOf('accounts')).toBe('sessions');
  });
  it('作成先の欄はセッション、tmux と claude の欄は環境、互換は連携の節にある', () => {
    expect(settingsSectionOf('workspace')).toBe('sessions');
    for (const at of ['tmux', 'claude'] as const) expect(settingsSectionOf(at)).toBe('environment');
    expect(settingsSectionOf('compat')).toBe('integrations');
  });
  it('opencode の小さな節は連携の節にある（モデルの小窓の「プロバイダーを管理…」が開く）', () => {
    expect(settingsSectionOf('opencode')).toBe('integrations');
    expect(parseRoute('#/settings?at=opencode')).toEqual({ name: 'settings', at: 'opencode' });
  });
  it('エディタの欄は一般の節にある', () => {
    expect(settingsSectionOf('editor')).toBe('general');
    expect(parseRoute('#/settings?at=editor')).toEqual({ name: 'settings', at: 'editor' });
  });
});
