import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeTarget } from './targets/fakeTarget.ts';
import { registerTarget } from './targets/index.ts';
import { judge, type RemoteSnapshot } from './threeWay.ts';

const snap = (deviceId: string, at: number, items: Record<string, string>, targets?: string[]): RemoteSnapshot => ({
  deviceId, at, items: new Map(Object.entries(items).map(([id, sha256]) => [id, { sha256 }])), ...(targets ? { targets: new Set(targets) } : {}),
});
const m = (o: Record<string, string>) => new Map(Object.entries(o));

describe('3 方向の判定と対象（SPEC 12 章）', () => {
  let unregister: () => void;
  beforeEach(() => { unregister = registerTarget(fakeTarget('fake')); });
  afterEach(() => unregister());

  it('古い版の束（targets の無い束）を相手にしても、新しい対象の項目は delete にも forget にもならない', () => {
    const old = snap('B', 10, { 'file:a': 'x' });
    const j = judge({ local: m({ 'fake:a': 'x', 'file:a': 'x' }), base: m({ 'fake:a': 'x', 'file:a': 'x' }), remotes: [old] });
    expect(j.actions).toEqual([]);
    expect(j.forget).toEqual([]);
    const j2 = judge({ local: m({}), base: m({ 'fake:a': 'x' }), remotes: [snap('B', 10, {})] });
    expect(j2.actions).toEqual([]);
    expect(j2.forget).toEqual([]);
  });

  it('claude だけと書いた束も、新しい対象を扱わない相手として数える', () => {
    const j = judge({ local: m({ 'fake:a': 'x' }), base: m({ 'fake:a': 'x' }), remotes: [snap('B', 10, {}, ['claude'])] });
    expect(j.actions).toEqual([]);
  });

  it('対象を扱う相手が持っていなければ、今までどおり delete と forget になる', () => {
    const b = snap('B', 10, {}, ['claude', 'fake']);
    expect(judge({ local: m({ 'fake:a': 'x' }), base: m({ 'fake:a': 'x' }), remotes: [b] }).actions)
      .toEqual([{ id: 'fake:a', op: 'delete', fromDeviceId: 'B', remoteSha256: null, localSha256: 'x' }]);
    expect(judge({ local: m({}), base: m({ 'fake:a': 'x' }), remotes: [b] }).forget).toEqual(['fake:a']);
  });

  it('対象を扱う相手が holder を持つときは今までどおり判定する。古い版の相手は数えない', () => {
    const old = snap('B', 30, {});
    const neu = snap('C', 10, { 'fake:a': 'y' }, ['claude', 'fake']);
    const j = judge({ local: m({ 'fake:a': 'x' }), base: m({ 'fake:a': 'x' }), remotes: [old, neu] });
    expect(j.actions).toEqual([{ id: 'fake:a', op: 'overwrite', fromDeviceId: 'C', remoteSha256: 'y', localSha256: 'x' }]);
  });

  it('手元でその対象が切なら、その対象の項目は create されない', () => {
    const b = snap('B', 10, { 'fake:a': 'y', 'file:a': 'z' }, ['claude', 'fake']);
    const j = judge({ local: m({}), base: m({}), remotes: [b], localTargets: new Set(['claude']) });
    expect(j.actions.map((a) => [a.id, a.op])).toEqual([['file:a', 'create']]);
  });

  it('手元でその対象が切なら、基準の行も消さず、delete や conflict もしない', () => {
    const b = snap('B', 10, {}, ['claude', 'fake']);
    const j = judge({ local: m({ 'fake:a': 'x' }), base: m({ 'fake:a': 'x' }), remotes: [b], localTargets: new Set(['claude']) });
    expect(j.actions).toEqual([]);
    expect(j.forget).toEqual([]);
  });
});
