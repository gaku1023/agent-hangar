import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { Publisher } from '../events/publisher.ts';
import { checkProjectRoots } from './registry.ts';
import { checkRoots } from './rootCheck.ts';

let ws: string;
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-')); });
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

describe('ルートの復帰', () => {
  /** ルートが 1 つ消えている（resolved = 0）プロジェクトと、その配下の未分類セッションを作る。 */
  function fixture(dir: string) {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: dir, resolved: 0 }, 'd');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', project_id: null, cwd: path.join(dir, 'sub'), home_device: 'd' }, 'd');
    return db;
  }
  const projectIdOf = (db: ReturnType<typeof openDb>) => (db.prepare('select project_id from sessions where id = ?').get('s1') as { project_id: string | null }).project_id;
  /**
   * checkRoots は行の変化を知らせるだけで、画面へ配るのは配る層（events/publisher.ts）である。
   * 本番と同じ組で動かし、その 1 回で配られたイベントを sent に貯める。
   */
  function delivered<T>(db: ReturnType<typeof openDb>, sent: ServerEvent[], run: (publisher: Publisher) => T): T {
    const publisher = new Publisher({ db, deviceId: 'd', live: () => [], hub: { broadcast: (ev) => { sent.push(ev); } } });
    try {
      const r = run(publisher);
      publisher.flush();
      return r;
    } finally {
      publisher.stop();
    }
  }

  it('存在を確かめるだけでは、戻ったルートの配下のセッションは未分類のまま残る', () => {
    // 繰り越しの再現。checkProjectRoots は resolved を 1 に戻すが、配下のセッションには触れない。
    const db = fixture(ws);
    try {
      expect(checkProjectRoots(db, 'd')).toEqual({ unresolved: [], recovered: ['p1'] });
      expect(projectIdOf(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('ルートが戻ったら未分類のセッションを紐づけ直して配る', () => {
    const db = fixture(ws);
    const sent: ServerEvent[] = [];
    try {
      const r = delivered(db, sent, (publisher) => checkRoots({ db, deviceId: 'd', broadcast: (ev) => publisher.broadcast(ev) }));
      expect(r.recovered).toEqual(['p1']);
      expect(projectIdOf(db)).toBe('p1');
      expect(sent.filter((e) => e.type === 'session.upsert').map((e) => (e as Extract<ServerEvent, { type: 'session.upsert' }>).session.id)).toEqual(['s1']);
      expect(sent.filter((e) => e.type === 'project.upsert').map((e) => (e as Extract<ServerEvent, { type: 'project.upsert' }>).project.id)).toEqual(['p1']);
    } finally {
      db.close();
    }
  });

  it('消えたルートの検出と project.unresolved の配信は前のまま', () => {
    const gone = path.join(ws, 'no-such-dir');
    const db = openDb(':memory:');
    const sent: ServerEvent[] = [];
    try {
      upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
      upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: gone, resolved: 1 }, 'd');
      const r = delivered(db, sent, (publisher) => checkRoots({ db, deviceId: 'd', broadcast: (ev) => publisher.broadcast(ev) }));
      expect(r.unresolved).toEqual(['p1']);
      expect(sent).toEqual([{ type: 'project.unresolved', projectId: 'p1' }]);
    } finally {
      db.close();
    }
  });

  it('戻ったルートが無ければ紐づけ直しも配信もしない', () => {
    // 起動時の 1 回目はたいていここを通る。無駄に全件を舐めない。
    const db = openDb(':memory:');
    const sent: ServerEvent[] = [];
    try {
      upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
      upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: ws, resolved: 1 }, 'd');
      upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', project_id: null, cwd: '/somewhere/else', home_device: 'd' }, 'd');
      expect(delivered(db, sent, (publisher) => checkRoots({ db, deviceId: 'd', broadcast: (ev) => publisher.broadcast(ev) }))).toEqual({ unresolved: [], recovered: [] });
      expect(sent).toEqual([]);
      expect(projectIdOf(db)).toBeNull();
    } finally {
      db.close();
    }
  });
});
