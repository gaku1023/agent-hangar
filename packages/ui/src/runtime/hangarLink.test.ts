import { describe, expect, it } from 'vitest';
import { hangarActionOf, hangarLinkOf } from './hangarLink.ts';

const ORIGIN = 'http://127.0.0.1:4177';

describe('hangarLinkOf（hangar 自身のリンクの見分け）', () => {
  it('127.0.0.1 と localhost の会話のリンクは、ポートを問わず通す（別の PC の hangar も同じ形）', () => {
    expect(hangarLinkOf('http://127.0.0.1:4177/#/session/s1', ORIGIN)).toEqual({ kind: 'session', id: 's1', deviceId: null });
    expect(hangarLinkOf('http://localhost:5173/#/session/s1', ORIGIN)).toEqual({ kind: 'session', id: 's1', deviceId: null });
    expect(hangarLinkOf('https://127.0.0.1:9999/#/session/s1', ORIGIN)).toEqual({ kind: 'session', id: 's1', deviceId: null });
  });
  it('?device= は手がかりとして持つ', () => {
    expect(hangarLinkOf('http://127.0.0.1:4177/#/session/s1?device=d2', ORIGIN)).toEqual({ kind: 'session', id: 's1', deviceId: 'd2' });
  });
  it('プロジェクトのリンクも通す', () => {
    expect(hangarLinkOf('http://127.0.0.1:4177/#/project/p1', ORIGIN)).toEqual({ kind: 'project', id: 'p1' });
  });
  it('いまの画面の origin のリンクも通す', () => {
    expect(hangarLinkOf('https://hangar.example:8443/#/session/s1', 'https://hangar.example:8443')).toEqual({ kind: 'session', id: 's1', deviceId: null });
    expect(hangarLinkOf('https://hangar.example:8443/#/session/s1', ORIGIN)).toBeNull();
  });
  it('hangar:// の会話とプロジェクトを通す', () => {
    expect(hangarLinkOf('hangar://session/s1', ORIGIN)).toEqual({ kind: 'session', id: 's1', deviceId: null });
    expect(hangarLinkOf('hangar://session/s1?device=d2', ORIGIN)).toEqual({ kind: 'session', id: 's1', deviceId: 'd2' });
    expect(hangarLinkOf('hangar://project/p1', ORIGIN)).toEqual({ kind: 'project', id: 'p1' });
  });
  it('会話とプロジェクト以外のハッシュ、ほかのホスト、ほかの形は通さない', () => {
    for (const u of [
      'http://127.0.0.1:4177/', 'http://127.0.0.1:4177/#/settings', 'http://127.0.0.1:4177/#/sessions', 'http://127.0.0.1:4177/#/session/',
      'https://github.com/a/b/#/session/s1', 'http://127.0.0.1.evil.example/#/session/s1', 'hangar://settings', 'hangar://session/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '',
    ]) expect(hangarLinkOf(u, ORIGIN), u).toBeNull();
  });
});

describe('hangarActionOf', () => {
  it('会話は session.open、プロジェクトは project.open にする（サイドバーの行と同じ動き）', () => {
    expect(hangarActionOf({ kind: 'session', id: 's1', deviceId: 'd2' })).toEqual({ type: 'session.open', id: 's1' });
    expect(hangarActionOf({ kind: 'project', id: 'p1' })).toEqual({ type: 'project.open', id: 'p1' });
  });
});
