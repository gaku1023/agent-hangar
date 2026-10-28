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
    for (const at of ['general', 'sessions', 'summary', 'cloud', 'environment', 'usage', 'agentClaude', 'agentCodex', 'agentOpencode', 'about'] as const) expect(parseRoute(`#/settings?at=${at}`)).toEqual({ name: 'settings', at });
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
      { name: 'settings', at: 'general' }, { name: 'settings', at: 'cloud' }, { name: 'settings', at: 'agentCodex' }, { name: 'settings', at: 'summary' }, { name: 'settings', at: 'sessions' }, { name: 'settings', at: 'environment' }, { name: 'settings', at: 'usage' }, { name: 'settings', at: 'about' },
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
    for (const at of ['general', 'sessions', 'summary', 'cloud', 'environment', 'usage', 'agentClaude', 'agentCodex', 'agentOpencode', 'about'] as const) expect(settingsSectionOf(at)).toBe(at);
  });
  it('連携の節（integrations）は Claude Code の節の別名', () => {
    expect(settingsSectionOf('integrations')).toBe('agentClaude');
    expect(parseRoute('#/settings?at=integrations')).toEqual({ name: 'settings', at: 'integrations' });
  });
  it('0.9.3 までの節の名前は、移った先の節', () => {
    expect(settingsSectionOf('tools')).toBe('environment');
    expect(settingsSectionOf('update')).toBe('about');
    expect(settingsSectionOf('info')).toBe('about');
  });
  it('sync と unsent はクラウド同期、accounts は Claude Code の節の別名', () => {
    expect(settingsSectionOf('sync')).toBe('cloud');
    expect(settingsSectionOf('unsent')).toBe('cloud');
    expect(settingsSectionOf('accounts')).toBe('agentClaude');
  });
  it('作成先の欄はセッション、tmux の欄は環境、claude の欄と互換は Claude Code の節にある', () => {
    expect(settingsSectionOf('workspace')).toBe('sessions');
    expect(settingsSectionOf('tmux')).toBe('environment');
    for (const at of ['claude', 'compat'] as const) expect(settingsSectionOf(at)).toBe('agentClaude');
  });
  it('opencode の面は opencode の節にある（モデルの小窓の「プロバイダーを管理…」が開く）', () => {
    expect(settingsSectionOf('opencode')).toBe('agentOpencode');
    expect(parseRoute('#/settings?at=opencode')).toEqual({ name: 'settings', at: 'opencode' });
  });
  it('エディタの欄は一般の節にある', () => {
    expect(settingsSectionOf('editor')).toBe('general');
    expect(parseRoute('#/settings?at=editor')).toEqual({ name: 'settings', at: 'editor' });
  });
});

describe('codex の面', () => {
  it('Codex の面は Codex の節にある（未検証の版の札の「設定を開く」が開く）', () => {
    expect(settingsSectionOf('codex')).toBe('agentCodex');
    expect(parseRoute('#/settings?at=codex')).toEqual({ name: 'settings', at: 'codex' });
    expect(formatRoute({ name: 'settings', at: 'codex' })).toBe('#/settings?at=codex');
  });
});
