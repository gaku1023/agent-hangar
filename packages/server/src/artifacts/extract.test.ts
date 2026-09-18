import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { artifactCallOf, isArtifactPublish, parsePublishedUrl, recordArtifactPublish, resolveArtifactTitle } from './extract.ts';

// 題名の解決は既定で本物のファイルを読むので、必ず存在しないパスを使う。
// 固定の /tmp/none.html に頼ると、たまたま同名のファイルがあるだけで結果が変わる。
let tmp: string;
let missing: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-artifact-')); missing = path.join(tmp, 'none.html'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('parsePublishedUrl', () => {
  it('新旧の URL を拾い、無ければ null', () => {
    expect(parsePublishedUrl('Published /tmp/a.html at https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001\nWatching: yes')).toBe('https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001');
    expect(parsePublishedUrl('Done. https://claude.ai/artifact/abc123XYZ.')).toBe('https://claude.ai/artifact/abc123XYZ');
    expect(parsePublishedUrl('Read 3 files')).toBeNull();
  });
});

describe('artifactCallOf', () => {
  it('file_path、description、favicon を取り出す', () => {
    expect(artifactCallOf({ file_path: '/tmp/a.html', description: '説明', favicon: '📊' })).toEqual({ filePath: '/tmp/a.html', description: '説明', favicon: '📊' });
    expect(artifactCallOf({ action: 'read', url: 'x' })).toEqual({ filePath: null, description: null, favicon: null });
    expect(artifactCallOf('nope')).toEqual({ filePath: null, description: null, favicon: null });
  });
});

describe('isArtifactPublish', () => {
  it('action が無いときと publish のときだけ真', () => {
    expect(isArtifactPublish({ file_path: '/tmp/a.html' })).toBe(true);
    expect(isArtifactPublish({ action: 'publish', file_path: '/tmp/a.html' })).toBe(true);
    expect(isArtifactPublish(undefined)).toBe(true);
    for (const action of ['read', 'list', 'delete', 'open', 'pin', 'unpin', 'quickstart']) {
      expect(isArtifactPublish({ action })).toBe(false);
    }
  });
});

describe('resolveArtifactTitle', () => {
  it('ファイルがあれば title、無ければ説明の先頭 60 字', () => {
    const read = (p: string) => (p === '/tmp/a.html' ? '<!doctype html><html><head><meta charset="utf-8"><title> 週報 &amp; 集計 </title></head>' : null);
    expect(resolveArtifactTitle('/tmp/a.html', '説明', read)).toBe('週報 & 集計');
    expect(resolveArtifactTitle('/tmp/none.html', 'あ'.repeat(70), read)).toBe('あ'.repeat(60));
    expect(resolveArtifactTitle(null, null, read)).toBeNull();
    expect(resolveArtifactTitle('/tmp/a.html', null, () => '<html><body>no title</body></html>')).toBeNull();
  });

  it('ファイルはあるが title が無ければ説明へ落ちる', () => {
    const noTitle = () => '<html><body>no title</body></html>';
    expect(resolveArtifactTitle('/tmp/a.html', 'あ'.repeat(70), noTitle)).toBe('あ'.repeat(60));
    expect(resolveArtifactTitle('/tmp/a.html', '説明', () => '<html><head><title>   </title></head></html>')).toBe('説明');
  });
});

describe('recordArtifactPublish', () => {
  it('同じ URL は 1 件にまとめ、版を積み、同じ版は二重にしない', () => {
    const db = openDb(':memory:');
    for (const id of ['p1', 'p2']) upsertShared(db, 'projects', { id, name: id, status: 'active' }, 'd');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 'u2', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
    const url = 'https://claude.ai/code/artifact/0199a2b3-1111-7000-8000-000000000001';
    const call = { filePath: missing, description: '週報のダッシュボード', favicon: '📊' };
    const a = recordArtifactPublish(db, 'd', { sessionId: 's1', projectId: 'p1', url, publishedAt: 100, call });
    const b = recordArtifactPublish(db, 'd', { sessionId: 's2', projectId: 'p2', url, publishedAt: 200, call: { ...call, description: '更新した説明' } });
    expect(b).toBe(a);
    const row = db.prepare('select * from artifacts where id = ?').get(a) as Record<string, unknown>;
    // 元ファイルが無いので題名は説明の先頭で、新しい公開の説明が勝つ。
    expect(row).toMatchObject({ url, project_id: 'p2', title: '更新した説明', description: '更新した説明', favicon: '📊', first_published_at: 100, last_published_at: 200 });
    expect((db.prepare('select count(*) c from artifact_versions where artifact_id = ?').get(a) as { c: number }).c).toBe(2);
    recordArtifactPublish(db, 'd', { sessionId: 's1', projectId: 'p1', url, publishedAt: 100, call });
    expect((db.prepare('select count(*) c from artifact_versions where artifact_id = ?').get(a) as { c: number }).c).toBe(2);
    // 古い公開が後から索引化されても first は最小、last は最大を保つ。
    recordArtifactPublish(db, 'd', { sessionId: 's1', projectId: 'p1', url, publishedAt: 50, call });
    expect(db.prepare('select first_published_at f, last_published_at l from artifacts where id = ?').get(a)).toEqual({ f: 50, l: 200 });
  });
});
