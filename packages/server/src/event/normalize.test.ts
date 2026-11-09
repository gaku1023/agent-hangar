import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CheckSuiteTracker, normalizeGithub, verifyGithubSignature } from './normalize.ts';

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

  it('waits until all suites on the head sha complete', () => {
    const suites = new CheckSuiteTracker();
    expect(normalizeGithub('check_suite', fx('check_suite.requested'), ME, { ...at, suites })).toBeNull();
    expect(normalizeGithub('check_suite', fx('check_suite.requested.second'), ME, { ...at, suites })).toBeNull();
    // 1 つめが失敗で終わっても、2 つめが残っているあいだは出さない。
    expect(normalizeGithub('check_suite', fx('check_suite.completed.failure'), ME, { ...at, suites })).toBeNull();
    // 全部終わったところで 1 件だけ出し、1 つでも失敗していれば failure にする。
    expect(normalizeGithub('check_suite', fx('check_suite.completed.success'), ME, { ...at, suites })).toMatchObject({ event: 'ci_done', outcome: 'failure', number: 42 });
    // 出したあとの同じ head の完了は、新しい回として数え直す。
    expect(normalizeGithub('check_suite', fx('check_suite.completed.success'), ME, { ...at, suites })).toMatchObject({ event: 'ci_done', outcome: 'success' });
  });

  it('reports success only when every suite passed', () => {
    const suites = new CheckSuiteTracker();
    normalizeGithub('check_suite', fx('check_suite.requested'), ME, { ...at, suites });
    normalizeGithub('check_suite', fx('check_suite.requested.second'), ME, { ...at, suites });
    const ok = (id: number, conclusion: string) => {
      const p = JSON.parse(JSON.stringify(fx('check_suite.completed.success'))) as { check_suite: { id: number; conclusion: string } };
      p.check_suite.id = id;
      p.check_suite.conclusion = conclusion;
      return p;
    };
    expect(normalizeGithub('check_suite', ok(1001, 'success'), ME, { ...at, suites })).toBeNull();
    expect(normalizeGithub('check_suite', ok(1002, 'skipped'), ME, { ...at, suites })).toMatchObject({ outcome: 'success' });
  });

  it('forgets suites that never finish', () => {
    const suites = new CheckSuiteTracker({ ttlMs: 1000 });
    normalizeGithub('check_suite', fx('check_suite.requested'), ME, { receivedAt: AT, suites });
    normalizeGithub('check_suite', fx('check_suite.requested.second'), ME, { receivedAt: AT, suites });
    // 古い覚えは落ちるので、あとから来た 1 つの完了は単独で数える。
    expect(normalizeGithub('check_suite', fx('check_suite.completed.success'), ME, { receivedAt: AT + 5000, suites })).toMatchObject({ outcome: 'success' });
  });

  it('normalizes merged pull_request', () => {
    expect(normalizeGithub('pull_request', fx('pull_request.merged'), ME, at)).toEqual({
      source: 'github', event: 'merged', repo: 'octo-org/demo-repo', number: 42, title: 'Add retry to the sync loop',
      url: 'https://github.com/octo-org/demo-repo/pull/42', actor: 'alice-dev', receivedAt: AT,
    });
  });

  it('normalizes a pull_request closed without merging', () => {
    expect(normalizeGithub('pull_request', fx('pull_request.closed'), ME, at)).toMatchObject({ event: 'closed', number: 43, title: 'Try a different cache' });
  });

  it('normalizes a submitted review with its body', () => {
    expect(normalizeGithub('pull_request_review', fx('pull_request_review.submitted'), ME, at)).toEqual({
      source: 'github', event: 'review', repo: 'octo-org/demo-repo', number: 42, title: 'Add retry to the sync loop',
      url: 'https://github.com/octo-org/demo-repo/pull/42#pullrequestreview-9001', actor: 'bob-reviewer', body: 'Please add a test for the empty case.', receivedAt: AT,
    });
  });

  it('normalizes issue_comment and pull_request_review_comment', () => {
    expect(normalizeGithub('issue_comment', fx('issue_comment.created'), ME, at)).toMatchObject({
      event: 'comment', number: 42, actor: 'bob-reviewer', body: 'Looks good, ship it.', url: 'https://github.com/octo-org/demo-repo/pull/42#issuecomment-7001',
    });
    expect(normalizeGithub('pull_request_review_comment', fx('pull_request_review_comment.created'), ME, at)).toMatchObject({
      event: 'comment', number: 42, actor: 'bob-reviewer', body: 'Nit: rename this variable.', title: 'Add retry to the sync loop',
    });
  });

  it('normalizes an opened issue', () => {
    expect(normalizeGithub('issues', fx('issues.opened'), ME, at)).toEqual({
      source: 'github', event: 'issue_opened', repo: 'octo-org/demo-repo', number: 51, title: 'Sync stalls after wake',
      url: 'https://github.com/octo-org/demo-repo/issues/51', actor: 'carol-user', body: 'It stalls after the laptop wakes.', receivedAt: AT,
    });
  });

  it('returns null for unrelated events', () => {
    expect(normalizeGithub('star', fx('star.created'), ME, at)).toBeNull();
    expect(normalizeGithub('ping', { zen: 'Keep it logically awesome.' }, ME, at)).toBeNull();
    // 種類は扱うが、動きが対象でないもの。
    expect(normalizeGithub('pull_request', fx('pull_request.opened'), ME, at)).toBeNull();
    expect(normalizeGithub('check_suite', fx('check_suite.requested'), ME, at)).toBeNull();
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
  });
});
