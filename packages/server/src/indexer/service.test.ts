import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_BETA } from '../../test/fixtures.ts';
import { IndexerService } from './service.ts';

let dir: string;
let db: Db;
let cleanups: (() => void)[] = [];
beforeEach(() => { dir = copyFixtureClaudeDir(); db = openDb(':memory:'); cleanups = []; });
afterEach(() => {
  for (const c of cleanups) c();
  fs.rmSync(dir, { recursive: true, force: true });
});

const make = (extra: Partial<ConstructorParameters<typeof IndexerService>[0]> = {}) =>
  new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: (id) => id === SESSION_ALPHA, ...extra });
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;
const alphaPath = () => path.join(dir, 'projects/-Users-me-workspace-alpha', `${SESSION_ALPHA}.jsonl`);
const userLine = (sessionId: string, cwd: string, text: string, uuid: string, ts: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid, timestamp: ts, cwd, sessionId }) + '\n';

describe('IndexerService', () => {
  it('fullScan は全ファイルを索引化し、進行を通知し、本文なしセッションも作る', async () => {
    const svc = make();
    const progress: unknown[] = [];
    const changed: string[] = [];
    svc.on({ progress: (p) => progress.push(p), sessionChanged: (e) => changed.push(e.providerSessionId + ':' + (e.agentId ?? '')) });
    const r = await svc.fullScan();
    expect(r).toEqual({ files: 3, changed: 3 });
    expect(progress[0]).toEqual({ phase: 'scanning', done: 0, total: 0 });
    expect(progress.at(-1)).toEqual({ phase: 'idle', done: 3, total: 3 });
    expect(svc.progress()).toEqual({ phase: 'idle', done: 3, total: 3 });
    expect(changed.sort()).toEqual([`${SESSION_ALPHA}:`, `${SESSION_ALPHA}:abc123`, 'aaaaaaaa-0000-4000-8000-000000000003:']);
    expect(count('select count(*) c from sessions')).toBe(3);
    const beta = db.prepare('select * from sessions where provider_session_id = ?').get(SESSION_BETA) as Record<string, unknown>;
    expect(beta).toMatchObject({ cwd: '/Users/me/workspace/beta', first_prompt: 'beta の README を書いて', started_at: 1788343200000, last_activity_at: 1788343200000 });
    expect(count('select count(*) c from session_summaries')).toBe(3);
    const alpha = db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string };
    expect((db.prepare('select state from session_summaries where session_id = ?').get(alpha.id) as { state: string }).state).toBe('in_progress');
  });

  it('何も変わっていない 2 回目の fullScan は changes を増やさない', async () => {
    const svc = make();
    await svc.fullScan();
    const before = count('select count(*) c from changes');
    const r = await svc.fullScan();
    expect(r).toEqual({ files: 3, changed: 0 });
    expect(count('select count(*) c from changes')).toBe(before);
  });

  it('tick は変わったファイルだけを索引化する', async () => {
    const svc = make();
    await svc.fullScan();
    const changed: number[] = [];
    svc.on({ sessionChanged: (e) => changed.push(e.appended) });
    expect(svc.tick()).toEqual({ changed: 0 });
    fs.appendFileSync(alphaPath(), userLine(SESSION_ALPHA, '/Users/me/workspace/alpha', '追加', 'u9', '2026-09-01T11:00:00.000Z'));
    expect(svc.tick()).toEqual({ changed: 1 });
    expect(changed).toEqual([1]);
  });

  it('新しいファイルは tick で拾う', async () => {
    const svc = make();
    await svc.fullScan();
    const p = path.join(dir, 'projects/-Users-me-workspace-beta');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, `${SESSION_BETA}.jsonl`), userLine(SESSION_BETA, '/Users/me/workspace/beta', 'beta の README を書いて', 'b1', '2026-09-02T10:00:00.000Z'));
    expect(svc.tick()).toEqual({ changed: 1 });
    expect(count('select count(*) c from sessions')).toBe(3);
    expect(count('select count(*) c from transcript_files where session_id = (select id from sessions where provider_session_id = ?)', SESSION_BETA)).toBe(1);
  });

  it('rebuild は全件を作り直し、行を重複させない', async () => {
    const svc = make();
    await svc.fullScan();
    const before = count('select count(*) c from event_index');
    const phases: string[] = [];
    svc.on({ progress: (p) => phases.push(p.phase) });
    await svc.rebuild();
    expect(phases).toContain('rebuilding');
    expect(phases.at(-1)).toBe('idle');
    expect(count('select count(*) c from event_index')).toBe(before);
    expect(count('select count(*) c from event_fts')).toBe(7 + 2 + 1 + 1);
  });

  it('壊れたファイルは error に流し、他は進む', async () => {
    fs.mkdirSync(path.join(dir, 'projects/-x'));
    const bad = path.join(dir, 'projects/-x', 'cccccccc-0000-4000-8000-000000000001.jsonl');
    // 読めない通常ファイルを置き、statSync は通るが読み取りで失敗させる。
    fs.writeFileSync(bad, '{}\n');
    fs.chmodSync(bad, 0o000);
    cleanups.push(() => fs.chmodSync(bad, 0o600));
    const svc = make();
    const errors: string[] = [];
    svc.on({ error: (e) => errors.push(e.path) });
    const r = await svc.fullScan();
    expect(errors).toEqual([bad]);
    expect(r.changed).toBe(3);
    expect(svc.progress()).toEqual({ phase: 'idle', done: 4, total: 4 });
  });

  it('読めないままのファイルは、中身が変わるまで一度しか知らせない', async () => {
    fs.mkdirSync(path.join(dir, 'projects/-y'));
    const bad = path.join(dir, 'projects/-y', 'dddddddd-0000-4000-8000-000000000001.jsonl');
    fs.writeFileSync(bad, '{}\n');
    fs.chmodSync(bad, 0o000);
    cleanups.push(() => fs.chmodSync(bad, 0o600));
    const svc = make();
    const errors: string[] = [];
    svc.on({ error: (e) => errors.push(e.path) });
    await svc.fullScan();
    expect(errors).toEqual([bad]);
    svc.tick();
    svc.tick();
    expect(errors).toEqual([bad]);
    // 中身が変わったら、もう一度知らせる。
    fs.chmodSync(bad, 0o600);
    fs.appendFileSync(bad, '{}\n');
    fs.chmodSync(bad, 0o000);
    svc.tick();
    expect(errors).toEqual([bad, bad]);
  });

  it('start は全走査してから定期 tick で追記を拾い、stop で止まる', async () => {
    const svc = make({ pollMs: 30 });
    cleanups.push(() => svc.stop());
    const appended: number[] = [];
    const seen = new Promise<void>((resolve) => svc.on({ sessionChanged: (e) => { appended.push(e.appended); if (e.appended === 1) resolve(); } }));
    await svc.start();
    expect(count('select count(*) c from transcript_files')).toBe(3);
    fs.appendFileSync(alphaPath(), userLine(SESSION_ALPHA, '/Users/me/workspace/alpha', '追加', 'u9', '2026-09-01T11:00:00.000Z'));
    await Promise.race([seen, new Promise<void>((_, reject) => setTimeout(() => reject(new Error('tick did not run')), 3000))]);
    expect(appended).toContain(1);
    svc.stop();
    const afterStop = count('select count(*) c from event_index');
    fs.appendFileSync(alphaPath(), userLine(SESSION_ALPHA, '/Users/me/workspace/alpha', 'もう一度', 'u10', '2026-09-01T11:01:00.000Z'));
    await new Promise<void>((r) => setTimeout(r, 120));
    expect(count('select count(*) c from event_index')).toBe(afterStop);
  });
});
