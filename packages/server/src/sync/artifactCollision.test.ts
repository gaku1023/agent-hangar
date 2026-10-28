import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeOut } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import type { Db } from '../db/open.ts';
import { recordArtifactPublish } from '../artifacts/extract.ts';
import { applyRemoteBatch } from './apply.ts';
import { SyncEngine } from './engine.ts';

// 同じ URL の Artifact を、2 台がそれぞれ別の ID で記録したとき（artifacts.url は unique）。
// ID の小さい方を正とし、負けた ID の版は正の方へ付け替える。どちらの PC でも同じ結果になる。

const URL = 'https://claude.ai/artifact/abc';
const o = { ownDeviceId: 'a', skipOwn: true };

function seed(): Db {
  const db = openDb(':memory:');
  upsertShared(db, 'projects', { id: 'p1', name: 'p', status: 'active', is_scratch: 0 }, 'a');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'a', project_id: 'p1' }, 'a');
  return db;
}

const art = (id: string, over: Record<string, unknown> = {}, updatedAt = 500): ChangeOut => ({
  seq: 1, tableName: 'artifacts', rowId: id, op: 'upsert', deviceId: 'b', updatedAt,
  payload: { id, project_id: 'p1', url: URL, title: 'remote', description: null, favicon: null, first_published_at: 100, last_published_at: 100, updated_at: updatedAt, deleted_at: null, origin_device: 'b', ...over },
});
const ver = (id: string, artifactId: string, publishedAt = 100): ChangeOut => ({
  seq: 2, tableName: 'artifact_versions', rowId: id, op: 'upsert', deviceId: 'b', updatedAt: 500,
  payload: { id, artifact_id: artifactId, session_id: 's1', file_path: null, published_at: publishedAt, updated_at: 500, deleted_at: null, origin_device: 'b' },
});

const artifacts = (db: Db) => db.prepare('select id, url, first_published_at, last_published_at from artifacts order by id').all();
const versions = (db: Db) => db.prepare('select artifact_id, published_at from artifact_versions where deleted_at is null order by published_at').all();

function localArtifact(db: Db, id: string, publishedAt = 100): void {
  upsertShared(db, 'artifacts', { id, project_id: 'p1', url: URL, title: 'local', first_published_at: publishedAt, last_published_at: publishedAt }, 'a');
  upsertShared(db, 'artifact_versions', { id: `v-${id}-${publishedAt}`, artifact_id: id, session_id: 's1', published_at: publishedAt }, 'a');
}

describe('同じ URL の Artifact が別の ID で届いたとき', () => {
  it('手元の ID が小さければ手元を残し、届いた ID の版は手元へ付け替える。同じ版は重ねない', () => {
    const db = seed();
    localArtifact(db, 'a1');
    const failed: ChangeOut[] = [];
    applyRemoteBatch(db, [art('b1'), ver('vb-1', 'b1', 100), ver('vb-2', 'b1', 200)], { ...o, onFailed: (c) => failed.push(c) });
    expect(failed).toEqual([]);
    expect(artifacts(db)).toEqual([{ id: 'a1', url: URL, first_published_at: 100, last_published_at: 100 }]);
    expect(versions(db)).toEqual([{ artifact_id: 'a1', published_at: 100 }, { artifact_id: 'a1', published_at: 200 }]);
  });

  it('届いた ID が小さければ届いた方を残し、手元の版をそちらへ移す', () => {
    const db = seed();
    localArtifact(db, 'b9', 300);
    const failed: ChangeOut[] = [];
    applyRemoteBatch(db, [art('b1'), ver('vb-1', 'b1', 100)], { ...o, onFailed: (c) => failed.push(c) });
    expect(failed).toEqual([]);
    expect(artifacts(db)).toEqual([{ id: 'b1', url: URL, first_published_at: 100, last_published_at: 300 }]);
    expect(versions(db)).toEqual([{ artifact_id: 'b1', published_at: 100 }, { artifact_id: 'b1', published_at: 300 }]);
    // その後の公開は、残した方へ積む。
    recordArtifactPublish(db, 'a', { sessionId: 's1', projectId: 'p1', url: URL, publishedAt: 400, call: { filePath: null, description: null, icon: null } });
    expect(artifacts(db)).toHaveLength(1);
  });

  it('負けた ID の版は、行が後の束で届いても付け替える', () => {
    const db = seed();
    localArtifact(db, 'a1');
    applyRemoteBatch(db, [art('b1')], o);
    const failed: ChangeOut[] = [];
    applyRemoteBatch(db, [ver('vb-2', 'b1', 200)], { ...o, onFailed: (c) => failed.push(c) });
    expect(failed).toEqual([]);
    expect(versions(db)).toEqual([{ artifact_id: 'a1', published_at: 100 }, { artifact_id: 'a1', published_at: 200 }]);
  });

  it('負けた ID の行の後の書き換えや削除が届いても、当てずに落とさない', () => {
    const db = seed();
    localArtifact(db, 'a1');
    applyRemoteBatch(db, [art('b1')], o);
    const failed: ChangeOut[] = [];
    applyRemoteBatch(db, [art('b1', { title: 'newer', last_published_at: 900 }, 600), { ...art('b1', { deleted_at: 700 }, 700), op: 'delete' }], { ...o, onFailed: (c) => failed.push(c) });
    expect(failed).toEqual([]);
    expect(artifacts(db)).toEqual([{ id: 'a1', url: URL, first_published_at: 100, last_published_at: 900 }]);
  });
});

describe('2 台が同じ公開を別々に記録して同期したとき', () => {
  const engines: SyncEngine[] = [];
  afterEach(() => { for (const e of engines.splice(0)) e.stop(); });

  it('どちらの PC も ID の小さい方の 1 件にそろい、持ち越しが残らない', async () => {
    const cloud = new FakeCloudClient({ deviceId: 'a' });
    const timers = new FakeTimers();
    const dbs = { a: seed(), b: seed() };
    const engine = (device: 'a' | 'b') => {
      const e = new SyncEngine({ db: dbs[device], deviceId: device, client: device === 'a' ? cloud : cloud.asDevice(device), now: () => timers.now, timers, url: 'https://h', home: '/nonexistent-home' });
      engines.push(e);
      return e;
    };
    const publish = (db: Db, device: string, at: number) => recordArtifactPublish(db, device, { sessionId: 's1', projectId: 'p1', url: URL, publishedAt: at, call: { filePath: null, description: null, icon: null } });
    const idA = publish(dbs.a, 'a', 100);
    const idB = publish(dbs.b, 'b', 100);
    publish(dbs.b, 'b', 200);
    expect(idA < idB).toBe(true);
    const a = engine('a');
    const b = engine('b');
    await a.start();
    await b.start();
    await a.pushNow();
    await b.pushNow();
    await a.pullNow();
    await b.pullNow();
    for (const db of [dbs.a, dbs.b]) {
      expect(artifacts(db)).toEqual([{ id: idA, url: URL, first_published_at: 100, last_published_at: 200 }]);
      expect(versions(db)).toEqual([{ artifact_id: idA, published_at: 100 }, { artifact_id: idA, published_at: 200 }]);
      expect(db.prepare("select 1 from sync_state where key = 'orphans'").get()).toBeUndefined();
    }
  });
});
