import { describe, expect, it } from 'vitest';
import { eventsAvailable, GITHUB_REPO_RE } from './eventTrigger.ts';

describe('eventsAvailable', () => {
  const on = { state: 'idle' as const, revoked: false, workerCompat: 12 };
  it('is true with cloud set up, not revoked, and a Worker at compat 12 or newer', () => {
    expect(eventsAvailable(on)).toBe(true);
    expect(eventsAvailable({ ...on, workerCompat: 13 })).toBe(true);
    expect(eventsAvailable({ ...on, state: 'error' })).toBe(true);
  });
  it('is false without cloud', () => {
    expect(eventsAvailable(null)).toBe(false);
    expect(eventsAvailable(undefined)).toBe(false);
    expect(eventsAvailable({ ...on, state: 'off' })).toBe(false);
  });
  it('is false when revoked', () => {
    expect(eventsAvailable({ ...on, revoked: true })).toBe(false);
  });
  it('is false when the Worker is older than 12 or its version is not known yet', () => {
    expect(eventsAvailable({ ...on, workerCompat: 11 })).toBe(false);
    expect(eventsAvailable({ ...on, workerCompat: null })).toBe(false);
    expect(eventsAvailable({ state: 'idle' })).toBe(false);
  });
});

describe('GITHUB_REPO_RE', () => {
  it('accepts owner/name with letters, digits, underscore, dot and hyphen', () => {
    for (const ok of ['acme/app', 'a-b/c_d.e', 'x/.github', '.x/y', 'a/b..c', 'a.b/c']) expect(GITHUB_REPO_RE.test(ok), ok).toBe(true);
  });
  it('rejects a segment made only of dots', () => {
    for (const bad of ['./x', '../x', 'x/.', 'x/..', 'x/...', './.', '../..']) expect(GITHUB_REPO_RE.test(bad), bad).toBe(false);
  });
  it('rejects other shapes', () => {
    for (const bad of ['', 'acme', 'acme/', '/app', 'a/b/c', 'a b/c', 'a/b c', 'a/b\n']) expect(GITHUB_REPO_RE.test(bad), bad).toBe(false);
  });
});
