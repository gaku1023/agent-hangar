import { describe, expect, it } from 'vitest';
import { REPO_RE, parseSource, parseWakeOn } from './validate.ts';

describe('REPO_RE と repo の検査', () => {
  it('owner/name を通し、点だけの部分は断る', () => {
    expect(REPO_RE.test('acme/app')).toBe(true);
    expect(REPO_RE.test('acme/.github')).toBe(true);
    for (const bad of ['./app', '../app', 'acme/.', 'acme/..']) expect(REPO_RE.test(bad), bad).toBe(false);
  });
  it('wake_on と source は点だけの repo を断る', () => {
    expect(parseWakeOn({ repo: 'acme/app', pr: 1, when: 'merged' })).toEqual({ repo: 'acme/app', pr: 1, when: 'merged' });
    expect(() => parseWakeOn({ repo: 'acme/..', pr: 1, when: 'merged' })).toThrow();
    expect(() => parseWakeOn({ repo: '../app', pr: 1, when: 'merged' })).toThrow();
    expect(() => parseSource({ kind: 'github', repo: 'acme/..', when: ['merged'] })).toThrow();
  });
});
