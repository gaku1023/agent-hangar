import { describe, expect, it } from 'vitest';
import { compareClaudeVersions, compatState } from './claudeCompat.ts';

describe('compareClaudeVersions', () => {
  it('区切りごとに数として比べる', () => {
    expect(compareClaudeVersions('2.1.292', '2.1.292')).toBe(0);
    expect(compareClaudeVersions('2.1.9', '2.1.292')).toBeLessThan(0);
    expect(compareClaudeVersions('2.2.0', '2.1.292')).toBeGreaterThan(0);
    expect(compareClaudeVersions('3.0', '2.9.999')).toBeGreaterThan(0);
  });
  it('足りない区切りと、数でない区切りは 0 とみなす', () => {
    expect(compareClaudeVersions('2.1', '2.1.0')).toBe(0);
    expect(compareClaudeVersions('2.1.x', '2.1.0')).toBe(0);
  });
});

describe('compatState', () => {
  const base = { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 };
  it('ずれが 1 件でもあれば drift', () => {
    expect(compatState({ ...base, driftCount: 1 })).toBe('drift');
    expect(compatState({ ...base, localVersion: '2.1.300', driftCount: 2 })).toBe('drift');
  });
  it('手元の版が確かめた版より新しければ unverified', () => {
    expect(compatState({ ...base, localVersion: '2.1.293' })).toBe('unverified');
  });
  it('同じ版、古い版、手元の版が分からないときは ok', () => {
    expect(compatState(base)).toBe('ok');
    expect(compatState({ ...base, localVersion: '2.1.200' })).toBe('ok');
    expect(compatState({ ...base, localVersion: null })).toBe('ok');
  });
});
