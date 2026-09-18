import fs from 'node:fs';
import { newId } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

// Artifact ツールの呼び出しには元ファイルのパス、説明、favicon が、結果には公開先の URL が残る。
// 呼び出しと結果は別の記録なので、呼び出しを artifact_calls に控えておき、結果が来たときに突き合わせる。

export type ArtifactCall = { filePath: string | null; description: string | null; favicon: string | null };

/** 新形式 https://claude.ai/code/artifact/<uuid> と旧形式 https://claude.ai/artifact/<id>。 */
export const ARTIFACT_URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

export function parsePublishedUrl(text: string): string | null {
  const m = ARTIFACT_URL_RE.exec(text);
  return m ? m[0] : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * 公開の呼び出しかどうか。
 * action を書かなければ publish なので、無いときと 'publish' のときだけ真。
 * read と list と delete などの結果にも URL は現れるので、ここで弾かないと公開でないものを版として積んでしまう。
 */
export function isArtifactPublish(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return true;
  const action = (input as Record<string, unknown>).action;
  return action === undefined || action === null || action === 'publish';
}

export function artifactCallOf(input: unknown): ArtifactCall {
  if (typeof input !== 'object' || input === null) return { filePath: null, description: null, favicon: null };
  const i = input as Record<string, unknown>;
  return { filePath: str(i.file_path), description: str(i.description), favicon: str(i.favicon) };
}

const HEAD_BYTES = 64 * 1024;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, k: string) => ENTITIES[k] ?? _);

function readHeadDefault(p: string): string | null {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** 元ファイルがあれば HTML の title、無ければ説明の先頭 60 字。どちらも無ければ null。 */
export function resolveArtifactTitle(filePath: string | null, description: string | null, readHead: (p: string) => string | null = readHeadDefault): string | null {
  const html = filePath ? readHead(filePath) : null;
  if (html !== null) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (m) {
      const t = decode(m[1]!).replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    // ファイルは読めたが題名が無いので、説明へ落とす。
  }
  return description ? [...description].slice(0, 60).join('') : null;
}

type ArtifactRow = { id: string; project_id: string | null; url: string; title: string | null; description: string | null; favicon: string | null; first_published_at: number; last_published_at: number };

/** 同じ URL は 1 件にまとめ、artifact_versions に「いつ、どのセッションが」を積む。同じ版が既にあれば足さない。 */
export function recordArtifactPublish(db: Db, deviceId: string, o: { sessionId: string; projectId: string | null; url: string; publishedAt: number; call: ArtifactCall }): string {
  const cur = db.prepare('select * from artifacts where url = ?').get(o.url) as ArtifactRow | undefined;
  const title = resolveArtifactTitle(o.call.filePath, o.call.description) ?? cur?.title ?? null;
  const id = cur?.id ?? newId();
  const newest = !cur || o.publishedAt >= cur.last_published_at;
  upsertShared(db, 'artifacts', {
    id,
    url: o.url,
    project_id: newest ? o.projectId : cur!.project_id,
    title: newest ? title : cur!.title,
    description: newest ? o.call.description ?? cur?.description ?? null : cur!.description,
    favicon: newest ? o.call.favicon ?? cur?.favicon ?? null : cur!.favicon,
    first_published_at: Math.min(cur?.first_published_at ?? o.publishedAt, o.publishedAt),
    last_published_at: Math.max(cur?.last_published_at ?? o.publishedAt, o.publishedAt),
    deleted_at: null,
  }, deviceId);
  const dup = db.prepare('select 1 from artifact_versions where artifact_id = ? and session_id = ? and published_at = ? and deleted_at is null').get(id, o.sessionId, o.publishedAt);
  if (!dup) upsertShared(db, 'artifact_versions', { id: newId(), artifact_id: id, session_id: o.sessionId, file_path: o.call.filePath, published_at: o.publishedAt }, deviceId);
  return id;
}
