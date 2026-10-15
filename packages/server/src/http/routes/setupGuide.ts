import type { Hono } from 'hono';
import { translatorOf } from '../../i18n/message.ts';
import { bundledGuideDir, readSetupGuide, setupGuideFile, syncSetupGuide } from '../../setupGuide/guide.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, editorOptsOf, externalOf, readJson, tooLargeResult } from './common.ts';

/** セットアップのすゝめの経路が使う依存。 */
export type SetupGuideRouteDeps = Pick<AppDeps, 'home' | 'version' | 'external' | 'token' | 'setupGuideDir'> & LanguageDeps;

/**
 * セットアップのすゝめ（docs/setup-guide.md）の経路。
 * GET は写しを確かめてから、場所、版、ハッシュ、Claude Code に貼る一言を返す（設定の連携の札とホームの行が読む）。
 * open は写した本編を、設定のエディタで開く（「手引きの中身を見る」）。エディタが見つからないときは、ほかの「<名前> で開く」と同じ 409 を返す。
 * 写すのは起動のときにも行う（boot/home.ts）。ここでも写すのは、起動の後で利用者が消したものを置き直すためで、中身が同じなら書かない。
 */
export function setupGuideRoutes(api: Hono, deps: SetupGuideRouteDeps): void {
  const tr = translatorOf(deps.language);
  const external = externalOf(deps);
  const sourceDir = () => (deps.setupGuideDir === undefined ? bundledGuideDir() : deps.setupGuideDir);

  api.get('/setup-guide', (c) => {
    const dir = sourceDir();
    if (!dir) return c.json({ error: tr('setupGuide.error.missing') }, 500);
    return c.json(readSetupGuide({ home: deps.home, version: deps.version, language: deps.language(), sourceDir: dir }));
  });

  api.post('/setup-guide/open', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const opts = editorOptsOf(b.value, false);
    if (opts === null) return c.json({ error: tr('session.file.badOptions') }, 400);
    const dir = sourceDir();
    if (!dir) return c.json({ error: tr('setupGuide.error.missing') }, 500);
    syncSetupGuide(deps.home, { version: deps.version, sourceDir: dir });
    return external(c, () => deps.external.openEditor({ target: setupGuideFile(deps.home), ...opts }), true);
  });
}
