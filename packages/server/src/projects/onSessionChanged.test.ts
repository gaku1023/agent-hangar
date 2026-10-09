import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { softDeleteShared } from '../db/shared.ts';
import { Publisher } from '../events/publisher.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { createSessionChangeHandler } from './onSessionChanged.ts';
import { insertProject, normalizeDir } from './registry.ts';

/**
 * 索引が知らせた「セッションが変わった」を、プロジェクトへの紐づけと知らせに変える受け手。
 * 行の変化を画面へ配るのは配る層（events/publisher.ts）なので、本番と同じ組で動かし、配られたイベントを見る。
 */
describe('現れたセッションをプロジェクトに紐づける', () => {
  let ws: string;
  let outside: string;
  let db: Db;
  let sent: ServerEvent[];
  let publisher: Publisher;
  let uploads: string[];
  let started: boolean;

  beforeEach(() => {
    // 置き場の比較は正規化した道で行うので、試験の道も同じ形にしておく（macOS の一時ディレクトリはリンクである）。
    ws = normalizeDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-'))));
    outside = normalizeDir(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-outside-'))));
    db = openDb(':memory:');
    sent = [];
    uploads = [];
    started = true;
    publisher = new Publisher({ db, deviceId: 'd', live: () => [], hub: { broadcast: (ev) => { sent.push(ev); } } });
  });
  afterEach(() => {
    publisher.stop();
    db.close();
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const handler = () => createSessionChangeHandler({
    db, deviceId: 'd', hub: publisher,
    started: () => started,
    workspaceRoot: () => ws,
    onLocalTranscript: (f) => { uploads.push(f.sessionId); },
  });
  const changed = (sessionId: string, o: { appended?: number; deviceId?: string | null; uuid?: string } = {}) =>
    ({ sessionId, providerSessionId: o.uuid ?? 'u', agentId: null, appended: o.appended ?? 0, artifactIds: [], deviceId: o.deviceId ?? null, path: '/x.jsonl' });
  const projectOf = (id: string) => (db.prepare('select project_id p from sessions where id = ?').get(id) as { p: string | null }).p;
  const toasts = () => sent.filter((e): e is Extract<ServerEvent, { type: 'toast' }> => e.type === 'toast');
  const projectUpserts = () => sent.filter((e): e is Extract<ServerEvent, { type: 'project.upsert' }> => e.type === 'project.upsert');

  it('起動後に現れたセッションにもプロジェクトを紐づけて配信する', () => {
    const dir = path.join(ws, 'alpha');
    fs.mkdirSync(dir);
    const p = insertProject(db, 'd', 'alpha', dir);
    const s = ensureSession(db, '11111111-1111-4111-8111-111111111111', dir, 'd');
    publisher.flush();
    sent.length = 0;
    handler()(changed(s));
    publisher.flush();
    expect(projectOf(s)).toBe(p);
    // 紐づいたプロジェクトは、行は書いていないが中身が変わったので配り直す。
    expect(projectUpserts().map((e) => e.project.id)).toEqual([p]);
    expect(sent.some((e) => e.type === 'session.upsert' && e.session.projectId === p)).toBe(true);
    expect(toasts()).toEqual([]);
  });

  // 「どのプロジェクトにも属さないセッションが現れました」の toast は、操作の結果ではないので外した（PR 29、docs/design.md）。
  // 未分類のセッションは一覧にそのまま出る（クイックセッションと同じ扱い）ので、黙って置いても見失わない。
  it('どのルートにも属さないセッションが現れたら、未割り当てのまま置き、toast は流さない', () => {
    const s = ensureSession(db, '11111111-1111-4111-8111-111111111112', outside, 'd');
    const h = handler();
    h(changed(s));
    publisher.flush();
    // 勝手にプロジェクトを作らない。設計どおり「未分類」に残す。
    expect(projectOf(s)).toBeNull();
    expect(toasts()).toEqual([]);
    h(changed(s, { appended: 1 }));
    publisher.flush();
    expect(toasts()).toEqual([]);
    expect(sent.filter((e) => e.type === 'transcript.appended')).toEqual([{ type: 'transcript.appended', sessionId: s, count: 1 }]);
  });

  it('起動後にワークスペース直下の新しいフォルダのセッションが現れたら、その場でプロジェクトにする', () => {
    // 起動の後で作ったフォルダ。起動時の全走査には載っていない。
    const fresh = path.join(ws, 'fresh');
    fs.mkdirSync(path.join(fresh, 'src'), { recursive: true });
    const s = ensureSession(db, '11111111-1111-4111-8111-111111111113', path.join(fresh, 'src'), 'd');
    handler()(changed(s));
    publisher.flush();
    const p = projectOf(s);
    expect(p).not.toBeNull();
    const up = projectUpserts().find((e) => e.project.id === p)!;
    expect(up.project).toMatchObject({ name: 'fresh', path: fresh });
    expect(toasts()).toEqual([]);
  });

  it('起動の途中は、その場の登録をしない。起動時の全走査の後始末が受け持つ', () => {
    started = false;
    const fresh = path.join(ws, 'fresh');
    fs.mkdirSync(fresh);
    const inWs = ensureSession(db, '11111111-1111-4111-8111-111111111114', fresh, 'd');
    const out = ensureSession(db, '11111111-1111-4111-8111-111111111115', outside, 'd');
    const h = handler();
    h(changed(inWs));
    h(changed(out));
    publisher.flush();
    expect(projectOf(inWs)).toBeNull();
    expect((db.prepare('select count(*) c from projects').get() as { c: number }).c).toBe(0);
    expect(toasts()).toEqual([]);
  });

  it('その場の登録を試すのは、セッションごとに 1 度だけである', () => {
    const later = path.join(ws, 'later');
    const s = ensureSession(db, '11111111-1111-4111-8111-111111111116', later, 'd');
    const h = handler();
    // まだフォルダが無いので登録できず、未分類のまま置く。
    h(changed(s));
    publisher.flush();
    expect(projectOf(s)).toBeNull();
    fs.mkdirSync(later);
    h(changed(s));
    publisher.flush();
    expect(projectOf(s)).toBeNull();
  });

  it('手元の本文だけを上げ手へ知らせる。他端末の写しは持ち主が上げる', () => {
    const s = ensureSession(db, '11111111-1111-4111-8111-111111111117', outside, 'd');
    const h = handler();
    h(changed(s, { uuid: 'mine' }));
    h(changed(s, { uuid: 'theirs', deviceId: 'other' }));
    expect(uploads).toEqual(['mine']);
  });

  it('消されたセッションは配らない', () => {
    const s = ensureSession(db, '11111111-1111-4111-8111-111111111118', outside, 'd');
    softDeleteShared(db, 'sessions', s, 'd');
    publisher.flush();
    sent.length = 0;
    handler()(changed(s, { appended: 2 }));
    publisher.flush();
    expect(sent.filter((e) => e.type === 'toast' || e.type === 'transcript.appended')).toEqual([]);
  });
});
