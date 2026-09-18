import fs from 'node:fs';
import { newId, type ArtifactDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { ARTIFACT_URL_RE } from './extract.ts';

type Row = { id: string; project_id: string | null; url: string; title: string | null; description: string | null; favicon: string | null; first_published_at: number; last_published_at: number };
type VersionRow = { session_id: string; file_path: string | null; published_at: number };

function toDto(db: Db, r: Row): ArtifactDto {
  const versions = db.prepare('select session_id, file_path, published_at from artifact_versions where artifact_id = ? and deleted_at is null order by published_at desc').all(r.id) as VersionRow[];
  const latestWithFile = versions.find((v) => v.file_path);
  const filePath = latestWithFile?.file_path ?? null;
  const sessionIds = [...new Set(versions.map((v) => v.session_id))];
  return {
    id: r.id,
    projectId: r.project_id,
    url: r.url,
    title: r.title,
    description: r.description,
    favicon: r.favicon,
    filePath,
    fileExists: filePath !== null && fs.existsSync(filePath),
    firstPublishedAt: r.first_published_at,
    lastPublishedAt: r.last_published_at,
    versionCount: versions.length,
    sessionIds,
  };
}

/** 一覧。projectId は artifacts.project_id と、版を積んだセッションのプロジェクトの両方で当てる。 */
export function listArtifacts(db: Db, opts: { projectId?: string; sessionId?: string; ids?: string[] } = {}): ArtifactDto[] {
  const where: string[] = ['a.deleted_at is null'];
  const args: unknown[] = [];
  if (opts.projectId) {
    where.push('(a.project_id = ? or exists (select 1 from artifact_versions v join sessions s on s.id = v.session_id where v.artifact_id = a.id and v.deleted_at is null and s.project_id = ?))');
    args.push(opts.projectId, opts.projectId);
  }
  if (opts.sessionId) {
    where.push('exists (select 1 from artifact_versions v where v.artifact_id = a.id and v.deleted_at is null and v.session_id = ?)');
    args.push(opts.sessionId);
  }
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    where.push(`a.id in (${opts.ids.map(() => '?').join(',')})`);
    args.push(...opts.ids);
  }
  const rows = db.prepare(`select a.* from artifacts a where ${where.join(' and ')} order by a.last_published_at desc, a.id`).all(...args) as Row[];
  return rows.map((r) => toDto(db, r));
}

export function getArtifact(db: Db, id: string): ArtifactDto | null {
  const r = db.prepare('select * from artifacts where id = ? and deleted_at is null').get(id) as Row | undefined;
  return r ? toDto(db, r) : null;
}

type StoredRow = Row & { deleted_at: number | null };

/**
 * 利用者が手で足す URL。
 * 版は作らない。
 * 同じ URL が既にあればそれを返し、消してあったものは足し直しとみなして復活させる。
 */
export function addManualArtifact(db: Db, deviceId: string, projectId: string, url: string, now: number = Date.now()): ArtifactDto {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL の形式が正しくありません');
  }
  if (parsed.hostname !== 'claude.ai' || !ARTIFACT_URL_RE.test(url)) throw new Error('claude.ai のアーティファクトの URL を入れてください');
  const clean = ARTIFACT_URL_RE.exec(url)![0];
  const cur = db.prepare('select * from artifacts where url = ?').get(clean) as StoredRow | undefined;
  if (cur && cur.deleted_at === null) return toDto(db, cur);
  const id = cur?.id ?? newId();
  upsertShared(db, 'artifacts', {
    id,
    project_id: cur?.project_id ?? projectId,
    url: clean,
    title: cur?.title ?? null,
    description: cur?.description ?? null,
    favicon: cur?.favicon ?? null,
    first_published_at: cur?.first_published_at ?? now,
    last_published_at: cur?.last_published_at ?? now,
    deleted_at: null,
  }, deviceId);
  return getArtifact(db, id)!;
}
