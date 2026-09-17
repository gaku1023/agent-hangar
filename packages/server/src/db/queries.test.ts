import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { openDb, type Db } from './open.ts';
import { upsertShared } from './shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_BETA, SESSION_OTHER } from '../../test/fixtures.ts';
import { displayName, getProject, getSession, listProjects, listSessions } from './queries.ts';

let dir: string;
let db: Db;
const live: LiveSessionDto[] = [
  { sessionId: SESSION_ALPHA, status: 'waiting', name: 'renamed', nameSource: 'user', cwd: '/Users/me/workspace/alpha', pid: 1 },
];

beforeEach(async () => {
  dir = copyFixtureClaudeDir();
  db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('listSessions', () => {
  it('新しい順に、要約と統計と実行状態を付けて返す', () => {
    const list = listSessions(db, live);
    expect(list.map((s) => s.providerSessionId)).toEqual([SESSION_BETA, SESSION_ALPHA, SESSION_OTHER]);
    const alpha = list[1]!;
    expect(alpha).toMatchObject({ projectId: 'p1', name: 'renamed', live: 'waiting', hasTranscript: true, cwd: '/Users/me/workspace/alpha' });
    expect(alpha.summary).toMatchObject({ title: '動画チャンネルの整理', source: 'baseline' });
    expect(alpha.stats).toMatchObject({ turns: 2, model: 'claude-fable-5-1', effort: 'high', filesChanged: 1, prUrl: 'https://github.com/me/alpha/pull/12' });
    const beta = list[0]!;
    expect(beta).toMatchObject({ hasTranscript: false, live: null, name: 'beta の README を書いて', projectId: null });
  });

  it('projectId と ids で絞る', () => {
    expect(listSessions(db, live, { projectId: 'p1' })).toHaveLength(1);
    const id = listSessions(db, live)[0]!.id;
    expect(listSessions(db, live, { ids: [id] }).map((s) => s.id)).toEqual([id]);
    expect(listSessions(db, live, { ids: [] })).toEqual([]);
  });

  it('論理削除したセッションは返さない', () => {
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    db.prepare('update sessions set deleted_at = ? where id = ?').run(Date.now(), alpha.id);
    expect(listSessions(db, live).map((s) => s.providerSessionId)).toEqual([SESSION_BETA, SESSION_OTHER]);
  });
});

describe('getSession', () => {
  it('無ければ null', () => {
    expect(getSession(db, live, 'nope')).toBeNull();
  });

  it('あれば listSessions と同じ形で返す', () => {
    const alpha = listSessions(db, live).find((s) => s.providerSessionId === SESSION_ALPHA)!;
    expect(getSession(db, live, alpha.id)).toEqual(alpha);
  });
});

describe('displayName', () => {
  it('利用者が付けた名前、hangar の名前、ai-title、最初の発言の順', () => {
    const l = (nameSource: string): LiveSessionDto => ({ sessionId: 'x', status: 'idle', name: 'L', nameSource, cwd: '', pid: 1 });
    expect(displayName({ name: 'N', ai_title: 'T', first_prompt: 'P' }, l('user'))).toBe('L');
    expect(displayName({ name: 'N', ai_title: 'T', first_prompt: 'P' }, l('derived'))).toBe('N');
    expect(displayName({ name: null, ai_title: 'T', first_prompt: 'P' }, undefined)).toBe('T');
    expect(displayName({ name: null, ai_title: null, first_prompt: 'あ'.repeat(50) }, undefined)).toBe('あ'.repeat(40));
    expect(displayName({ name: null, ai_title: null, first_prompt: null }, undefined)).toBeNull();
  });
});

describe('listProjects', () => {
  it('パス、最終活動、実行中の数を付ける', () => {
    const [p] = listProjects(db, 'd', live);
    expect(p).toMatchObject({
      id: 'p1', name: 'alpha', status: 'active', isScratch: false,
      path: '/Users/me/workspace/alpha', resolved: true,
      runningCount: 1, openTodoCount: 0, memoHead: null,
      lastActivityAt: Date.parse('2026-09-01T10:04:00.000Z'),
    });
  });

  it('この端末にルートが無いプロジェクトは path が null で resolved が false', () => {
    upsertShared(db, 'projects', { id: 'p2', name: 'remote-only', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r2', project_id: 'p2', device_id: 'other-device', path: '/elsewhere', resolved: 1 }, 'other-device');
    const p2 = listProjects(db, 'd', live).find((p) => p.id === 'p2')!;
    expect(p2).toMatchObject({ path: null, resolved: false, lastActivityAt: null, runningCount: 0 });
  });

  it('ワークスペース登録と組み合わせて動く', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-test-'));
    try {
      const beta = path.join(ws, 'beta');
      fs.mkdirSync(beta, { recursive: true });
      upsertShared(db, 'sessions', { id: 'x', provider: 'claude-code', provider_session_id: 'x', cwd: beta, home_device: 'd' }, 'd');
      syncProjectsFromWorkspace(db, 'd', ws);
      expect(listProjects(db, 'd', live).map((p) => p.name).sort()).toEqual(['alpha', 'beta']);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('getProject', () => {
  it('無ければ null、あれば listProjects と同じ形で返す', () => {
    expect(getProject(db, 'd', live, 'nope')).toBeNull();
    expect(getProject(db, 'd', live, 'p1')).toEqual(listProjects(db, 'd', live)[0]);
  });
});
