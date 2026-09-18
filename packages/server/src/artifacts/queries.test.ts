import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { recordArtifactPublish } from './extract.ts';
import { addManualArtifact, getArtifact, listArtifacts } from './queries.ts';

function seed() {
  const db = openDb(':memory:');
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'projects', { id: 'p2', name: 'beta', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
  upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 'u2', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
  upsertShared(db, 'sessions', { id: 's3', provider: 'claude-code', provider_session_id: 'u3', cwd: '/y', home_device: 'd', project_id: 'p2' }, 'd');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-art-'));
  const file = path.join(tmp, 'a.html');
  fs.writeFileSync(file, '<title>実在</title>');
  const a = recordArtifactPublish(db, 'd', { sessionId: 's1', projectId: 'p1', url: 'https://claude.ai/code/artifact/a', publishedAt: 100, call: { filePath: '/tmp/gone.html', description: 'A', favicon: '📊' } });
  recordArtifactPublish(db, 'd', { sessionId: 's2', projectId: 'p1', url: 'https://claude.ai/code/artifact/a', publishedAt: 300, call: { filePath: file, description: 'A2', favicon: '📊' } });
  const b = recordArtifactPublish(db, 'd', { sessionId: 's3', projectId: 'p2', url: 'https://claude.ai/artifact/b', publishedAt: 200, call: { filePath: null, description: 'B', favicon: null } });
  return { db, a, b, file, tmp };
}

describe('artifacts/queries', () => {
  it('一覧は新しい順で、版の数とセッションとファイルの有無を持つ', () => {
    const { db, a, b, file, tmp } = seed();
    const all = listArtifacts(db);
    expect(all.map((x) => x.id)).toEqual([a, b]);
    expect(all[0]).toMatchObject({ url: 'https://claude.ai/code/artifact/a', title: '実在', description: 'A2', favicon: '📊', filePath: file, fileExists: true, firstPublishedAt: 100, lastPublishedAt: 300, versionCount: 2, sessionIds: ['s2', 's1'] });
    expect(all[1]).toMatchObject({ id: b, title: 'B', fileExists: false, filePath: null, versionCount: 1 });
    expect(listArtifacts(db, { projectId: 'p1' }).map((x) => x.id)).toEqual([a]);
    expect(listArtifacts(db, { sessionId: 's3' }).map((x) => x.id)).toEqual([b]);
    expect(listArtifacts(db, { ids: [b] }).map((x) => x.id)).toEqual([b]);
    expect(listArtifacts(db, { ids: [] })).toEqual([]);
    expect(getArtifact(db, a)).toMatchObject({ id: a, versionCount: 2 });
    expect(getArtifact(db, 'nope')).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('セッションが別のプロジェクトへ移っても版から辿れる', () => {
    const { db, a, tmp } = seed();
    db.prepare("update sessions set project_id = 'p2' where id in ('s1', 's2')").run();
    expect(listArtifacts(db, { projectId: 'p2' }).map((x) => x.id).sort()).toEqual(listArtifacts(db).map((x) => x.id).sort());
    expect(listArtifacts(db, { projectId: 'p1' }).map((x) => x.id)).toEqual([a]); // artifacts.project_id はまだ p1
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('手で URL を追加する。claude.ai 以外は拒む。同じ URL は既存を返す', () => {
    const { db, a, tmp } = seed();
    const m = addManualArtifact(db, 'd', 'p1', 'https://claude.ai/code/artifact/manual-1', 500);
    expect(m).toMatchObject({ projectId: 'p1', title: null, versionCount: 0, sessionIds: [], firstPublishedAt: 500, lastPublishedAt: 500 });
    expect(addManualArtifact(db, 'd', 'p2', 'https://claude.ai/code/artifact/a').id).toBe(a);
    expect(() => addManualArtifact(db, 'd', 'p1', 'https://example.com/x')).toThrow(/claude\.ai/);
    expect(() => addManualArtifact(db, 'd', 'p1', 'not a url')).toThrow();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('論理削除した版と記事は一覧から消える。手で足し直すと復活する', () => {
    const { db, a, tmp } = seed();
    const url = 'https://claude.ai/code/artifact/a';
    db.prepare('update artifacts set deleted_at = 1 where id = ?').run(a);
    expect(listArtifacts(db).map((x) => x.id)).not.toContain(a);
    expect(getArtifact(db, a)).toBeNull();
    const again = addManualArtifact(db, 'd', 'p2', url, 900);
    expect(again.id).toBe(a);
    expect(listArtifacts(db).map((x) => x.id)).toContain(a);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
