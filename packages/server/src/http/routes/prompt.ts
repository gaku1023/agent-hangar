import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { listPromptCommands } from '../../prompt/commands.ts';
import { MAX_DROP_BYTES, pruneDrops, resolveDrop, saveDrop } from '../../prompt/drops.ts';
import { listProjectFiles } from '../../prompt/files.ts';
import { translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, projectOf, readJson, tooLargeResult } from './common.ts';

/** 初期プロンプト欄の経路が使う依存。 */
export type PromptRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live' | 'settings' | 'home'> & LanguageDeps;

/** 初期プロンプト欄の経路。`/` と `@` の候補と、添付の置き場（drops）を持つ。 */
export function promptRoutes(api: Hono, deps: PromptRouteDeps): void {
  const tr = translatorOf(deps.language);
  const requireProject = projectOf(deps);

  // 初期プロンプト欄の `/` の候補。projectId が無ければ（スクラッチなど）、プロジェクトのものは読まない。
  api.get('/prompt/commands', (c) => {
    const id = c.req.query('projectId');
    const project = id ? requireProject(id) : null;
    if (id && !project) return c.json({ error: tr('project.error.notFound') }, 404);
    return c.json({ commands: listPromptCommands({ claudeDir: deps.settings().claudeDir, projectPath: project?.path ?? null }) });
  });
  // 初期プロンプト欄の `@` の候補。パスの無いプロジェクト（まだ場所が決まっていないもの）では空を返す。
  api.get('/prompt/files', async (c) => {
    const id = c.req.query('projectId');
    if (!id) return c.json({ error: tr('http.request.needed', { field: 'projectId' }) }, 400);
    const project = requireProject(id);
    if (!project) return c.json({ error: tr('project.error.notFound') }, 404);
    return c.json({ files: project.path ? await listProjectFiles(project.path, c.req.query('q') ?? '') : [] });
  });
  // 初期プロンプト欄の添付。端末へのドロップ（殻の filedrop.rs）と同じ置き場に置く。
  const dropsDir = path.join(deps.home, 'drops');
  const DROP_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  api.post('/drops/existing', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const paths = (b.value as { paths?: unknown } | null | undefined)?.paths;
    if (!Array.isArray(paths)) return c.json({ error: tr('http.request.needed', { field: 'paths' }) }, 400);
    // フォルダを落としたときは元のパスがそのまま添付になるので、ファイルに限らず「ある」かだけを見る。
    return c.json({ paths: paths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) });
  });
  api.post('/drops', async (c) => {
    // 先に長さの申告で断り、読んだ後にも実際の大きさで断る（申告は偽れる）。
    if (Number(c.req.header('content-length') ?? 0) > MAX_DROP_BYTES) return tooLargeResult(c, MAX_DROP_BYTES, tr);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_DROP_BYTES) return tooLargeResult(c, MAX_DROP_BYTES, tr);
    if (bytes.byteLength === 0) return c.json({ error: tr('prompt.attachment.empty') }, 400);
    pruneDrops(dropsDir, Date.now());
    return c.json(saveDrop(dropsDir, c.req.query('name') ?? '', bytes), 201);
  });
  api.get('/drops/:name', (c) => {
    const file = resolveDrop(dropsDir, c.req.param('name'));
    if (!file) return c.notFound();
    // 画像だけを画像として返す。ほかは開かせない。置いたものを頁として解釈させないためである。
    c.header('Content-Type', DROP_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, max-age=3600');
    return c.body(fs.readFileSync(file));
  });
}
