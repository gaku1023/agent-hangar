import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from './route.ts';

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
      { name: 'session', id: 's1' }, { name: 'home', q: '動画 x' }, { name: 'settings' }, { name: 'settings', at: 'accounts' },
    ] as const;
    for (const r of routes) expect(parseRoute(formatRoute(r))).toEqual(r);
  });
  it('ホームは #/、検索語があれば #/?q= と書き、#/sessions は書かない', () => {
    expect(formatRoute({ name: 'home' })).toBe('#/');
    expect(formatRoute({ name: 'home', q: '動画 x' })).toBe('#/?q=%E5%8B%95%E7%94%BB%20x');
  });
});
