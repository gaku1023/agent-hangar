import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSuiteRef, normalizeGithub, verifyGithubSignature } from './normalize.ts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const ME = 'alice-dev';
const AT = 1_700_000_000_000;
const at = { receivedAt: AT };

describe('normalizeGithub', () => {
  it('normalizes a failed check suite into ci_done failure', () => {
    const f = normalizeGithub('check_suite', fx('check_suite.completed.failure'), ME, at);
    expect(f).toEqual({
      source: 'github', event: 'ci_done', repo: 'octo-org/demo-repo', number: 42, outcome: 'failure',
      url: 'https://github.com/octo-org/demo-repo/pull/42', actor: 'alice-dev', receivedAt: AT,
    });
  });

  it('normalizes a passed check suite into ci_done success', () => {
    const f = normalizeGithub('check_suite', fx('check_suite.completed.success'), ME, at);
    expect(f).toMatchObject({ event: 'ci_done', outcome: 'success', number: 42 });
  });

  it('names the repo and head sha a completed suite points at', () => {
    expect(checkSuiteRef(fx('check_suite.completed.failure'))).toEqual({ repo: 'octo-org/demo-repo', sha: '3f2a9c0d41b7e85a6c1d2e3f405162738495a6b7', suiteId: 1001 });
    expect(checkSuiteRef({ check_suite: {} })).toBeNull();
    expect(checkSuiteRef(null)).toBeNull();
  });

  it('maps conclusions: neutral and skipped pass, cancelled stays, unknown fails', () => {
    const of = (conclusion: string) => normalizeGithub('check_suite', { ...(fx('check_suite.completed.success') as object), check_suite: { id: 1, head_sha: 'abc', conclusion, pull_requests: [] } }, ME, at)?.outcome;
    expect(of('neutral')).toBe('success');
    expect(of('skipped')).toBe('success');
    expect(of('cancelled')).toBe('cancelled');
    expect(of('timed_out')).toBe('failure');
    expect(of('action_required')).toBe('failure');
  });

  it('links a suite without a pull request to the commit', () => {
    const f = normalizeGithub('check_suite', { ...(fx('check_suite.completed.success') as object), check_suite: { id: 1, head_sha: 'abc123', conclusion: 'success', pull_requests: [] } }, ME, at);
    expect(f).toMatchObject({ url: 'https://github.com/octo-org/demo-repo/commit/abc123' });
    expect(f?.number).toBeUndefined();
  });

  it('normalizes merged pull_request', () => {
    expect(normalizeGithub('pull_request', fx('pull_request.merged'), ME, at)).toEqual({
      source: 'github', event: 'merged', repo: 'octo-org/demo-repo', number: 42, title: 'Add retry to the sync loop', authorLogin: 'alice-dev',
      url: 'https://github.com/octo-org/demo-repo/pull/42', actor: 'alice-dev', labels: ['ready'], receivedAt: AT,
    });
  });

  it('normalizes a pull_request closed without merging', () => {
    expect(normalizeGithub('pull_request', fx('pull_request.closed'), ME, at)).toMatchObject({ event: 'closed', number: 43, title: 'Try a different cache' });
  });

  it('normalizes a submitted review with its body', () => {
    expect(normalizeGithub('pull_request_review', fx('pull_request_review.submitted'), ME, at)).toEqual({
      source: 'github', event: 'review', repo: 'octo-org/demo-repo', number: 42, title: 'Add retry to the sync loop', authorLogin: 'alice-dev',
      url: 'https://github.com/octo-org/demo-repo/pull/42#pullrequestreview-9001', actor: 'bob-reviewer', body: 'Please add a test for the empty case.', receivedAt: AT,
    });
  });

  it('normalizes issue_comment and pull_request_review_comment', () => {
    expect(normalizeGithub('issue_comment', fx('issue_comment.created'), ME, at)).toMatchObject({
      event: 'comment', number: 42, actor: 'bob-reviewer', authorLogin: 'alice-dev', body: 'Looks good, ship it.', url: 'https://github.com/octo-org/demo-repo/pull/42#issuecomment-7001',
    });
    expect(normalizeGithub('pull_request_review_comment', fx('pull_request_review_comment.created'), ME, at)).toMatchObject({
      event: 'comment', number: 42, actor: 'bob-reviewer', authorLogin: 'alice-dev', body: 'Nit: rename this variable.', title: 'Add retry to the sync loop',
    });
  });

  it('leaves labels out when the payload has none', () => {
    expect(normalizeGithub('pull_request', fx('pull_request.closed'), ME, at)).not.toHaveProperty('labels');
  });

  it('normalizes an opened issue', () => {
    expect(normalizeGithub('issues', fx('issues.opened'), ME, at)).toEqual({
      source: 'github', event: 'issue_opened', repo: 'octo-org/demo-repo', number: 51, title: 'Sync stalls after wake', authorLogin: 'carol-user',
      url: 'https://github.com/octo-org/demo-repo/issues/51', actor: 'carol-user', body: 'It stalls after the laptop wakes.', labels: ['bug', 'needs-triage'], receivedAt: AT,
    });
  });

  it('returns null for unrelated events', () => {
    expect(normalizeGithub('star', fx('star.created'), ME, at)).toBeNull();
    expect(normalizeGithub('ping', { zen: 'Keep it logically awesome.' }, ME, at)).toBeNull();
    // 種類は扱うが、動きが対象でないもの。
    expect(normalizeGithub('pull_request', fx('pull_request.opened'), ME, at)).toBeNull();
    expect(normalizeGithub('check_suite', { ...(fx('check_suite.completed.failure') as object), action: 'requested' }, ME, at)).toBeNull();
    const edited = { ...(fx('issue_comment.created') as object), action: 'edited' };
    expect(normalizeGithub('issue_comment', edited, ME, at)).toBeNull();
    const reviewDismissed = { ...(fx('pull_request_review.submitted') as object), action: 'dismissed' };
    expect(normalizeGithub('pull_request_review', reviewDismissed, ME, at)).toBeNull();
  });

  it('returns null for payloads of the wrong shape instead of throwing', () => {
    for (const p of [null, 'text', 42, [], {}, { action: 'completed' }, { action: 'completed', check_suite: 'x' }]) {
      for (const e of ['check_suite', 'pull_request', 'pull_request_review', 'issue_comment', 'pull_request_review_comment', 'issues']) {
        expect(normalizeGithub(e, p, ME, at)).toBeNull();
      }
    }
  });
});

describe('verifyGithubSignature', () => {
  const sign = (secret: string, body: string): string => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  const body = '{"zen":"日本語もé通る"}';

  it('accepts the right signature and refuses everything else', () => {
    expect(verifyGithubSignature('s3cret', body, sign('s3cret', body))).toBe(true);
    expect(verifyGithubSignature('other', body, sign('s3cret', body))).toBe(false);
    expect(verifyGithubSignature('s3cret', `${body} `, sign('s3cret', body))).toBe(false);
    expect(verifyGithubSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyGithubSignature('s3cret', body, '')).toBe(false);
    expect(verifyGithubSignature('s3cret', body, sign('s3cret', body).replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyGithubSignature('s3cret', body, 'sha256=abcd')).toBe(false);
    expect(verifyGithubSignature('s3cret', body, `sha256=${'z'.repeat(64)}`)).toBe(false);
    expect(verifyGithubSignature('', body, sign('', body))).toBe(false);
    // 接頭辞は小文字の sha256= だけ。
    // 16 進の部分は大文字でもよい。
    expect(verifyGithubSignature('s3cret', body, sign('s3cret', body).replace('sha256=', 'SHA256='))).toBe(false);
    const good = sign('s3cret', body);
    expect(verifyGithubSignature('s3cret', body, `sha256=${good.slice(7).toUpperCase()}`)).toBe(true);
  });
});
