import fs from 'node:fs';
import os from 'node:os';
import type { Hono } from 'hono';
import type { InstructionFileKind, InstructionsDto, ProjectDto } from '@agent-hangar/shared';
import { instructionFilePath, readInstructions, type InstructionsEnv } from '../../projects/instructions.ts';
import { translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, editorOptsOf, externalOf, projectOf, readJson, tooLargeResult } from './common.ts';

/** 指示とメモリの経路が使う依存。 */
export type InstructionRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live' | 'external' | 'token' | 'accounts'> & LanguageDeps;

const KINDS = new Set<InstructionFileKind>(['project', 'projectDotClaude', 'local', 'agents', 'memory']);

/** この PC で開けるプロジェクトのフォルダ。パスが無いか、見つからなければ null。 */
function folderOf(p: ProjectDto): string | null {
  if (!p.path || p.resolved === false) return null;
  try { return fs.statSync(p.path).isDirectory() ? p.path : null; } catch { return null; }
}

/**
 * 指示とメモリの経路。Claude Code が起動時に読むファイルを並べ、エディタで開く。
 * 読むのと開くだけで、ファイルを作ったり書いたりはしない。
 * 自動メモリは、いま選んでいるアカウントの設定フォルダから引く（アカウントごとに場所が違う）。
 */
export function instructionRoutes(api: Hono, deps: InstructionRouteDeps): void {
  const tr = translatorOf(deps.language);
  const requireProject = projectOf(deps);
  const external = externalOf(deps);
  const envOf = (): InstructionsEnv => ({ configDir: deps.accounts.store.current().dir, homeDir: os.homedir() });

  api.get('/projects/:id/instructions', (c) => {
    const id = c.req.param('id');
    const p = requireProject(id);
    if (!p) return c.json({ error: tr('project.error.notFound') }, 404);
    const dir = folderOf(p);
    const body: InstructionsDto = { projectId: id, available: dir !== null, files: dir ? readInstructions(dir, envOf()) : [] };
    return c.json(body);
  });
  api.post('/projects/:id/instructions/open', async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const kind = ((b.value ?? {}) as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !KINDS.has(kind as InstructionFileKind)) return c.json({ error: tr('project.instructions.badKind') }, 400);
    const p = requireProject(id);
    if (!p) return c.json({ error: tr('project.error.notFound') }, 404);
    const dir = folderOf(p);
    const file = dir ? instructionFilePath(dir, kind as InstructionFileKind, envOf()) : null;
    if (!file) return c.json({ error: tr('project.instructions.fileMissing') }, 404);
    const opts = editorOptsOf(b.value, false);
    if (opts === null) return c.json({ error: tr('session.file.badOptions') }, 400);
    return external(c, () => deps.external.openEditor({ target: file, ...opts }), true);
  });
}
