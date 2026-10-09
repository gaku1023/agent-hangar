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
    expect(parseRoute('#/sessions')).toEqual({ name: 'sessions' });
    expect(parseRoute('#/sessions?q=%E5%8B%95%E7%94%BB%20x')).toEqual({ name: 'sessions', q: '動画 x' });
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('#/settings?at=accounts')).toEqual({ name: 'settings', at: 'accounts' });
    expect(parseRoute('#/settings?at=sync')).toEqual({ name: 'settings', at: 'sync' });
    for (const at of ['general', 'cloud', 'integrations', 'summary', 'tools', 'info'] as const) expect(parseRoute(`#/settings?at=${at}`)).toEqual({ name: 'settings', at });
    // 知らない行き先は印なしの設定として読む。
    expect(parseRoute('#/settings?at=nope')).toEqual({ name: 'settings' });
  });
  it('知らない経路は home', () => {
    expect(parseRoute('#/nope/1')).toEqual({ name: 'home' });
  });
});

describe('formatRoute', () => {
  it('parseRoute と往復する', () => {
    const routes = [
      { name: 'home' }, { name: 'projects' }, { name: 'project', id: 'p1' },
      { name: 'session', id: 's1' }, { name: 'sessions', q: '動画 x' }, { name: 'sessions' }, { name: 'settings' }, { name: 'settings', at: 'accounts' }, { name: 'settings', at: 'sync' },
      { name: 'settings', at: 'general' }, { name: 'settings', at: 'cloud' }, { name: 'settings', at: 'integrations' }, { name: 'settings', at: 'summary' }, { name: 'settings', at: 'tools' }, { name: 'settings', at: 'info' },
    ] as const;
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
  });
});

describe('settingsSectionOf', () => {
  it('無ければ「一般」、節の名前ならその節', () => {
    expect(settingsSectionOf(undefined)).toBe('general');
    for (const at of ['general', 'cloud', 'integrations', 'summary', 'tools', 'info'] as const) expect(settingsSectionOf(at)).toBe(at);
  });
  it('sync はクラウド同期、accounts は連携の別名', () => {
    expect(settingsSectionOf('sync')).toBe('cloud');
    expect(settingsSectionOf('accounts')).toBe('integrations');
  });
});
