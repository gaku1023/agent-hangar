import type { Hono } from 'hono';
import { validSshHost } from '../../remote/service.ts';
import type { AppDeps } from '../deps.ts';
import { BODY_LIMITS, readJson } from './common.ts';

/**
 * ほかの PC の会話の画面から開く SSH のシェルタブ（docs/design.md「SSH のシェルタブ」）。
 * - POST   /api/sessions/:id/remote-tabs   その会話の持ち主の PC へのタブを開く。持ち主が手元か引けなければ 404。sshd の有無は見ない（つなぐときに理由を出す）。
 * - DELETE /api/remote-tabs/:id            タブを閉じる。相手の kill-session は後ろで打ち、届かなければ kill_pending を立てる。
 * - PUT    /api/devices/:deviceId/ssh-host 上書きの Host 名を置く。null で外す。ssh の引数に渡るので形を検査する。
 * サービス（remoteShell）を持たない組み立てでは、どれも出さない。
 */
export type RemoteShellRouteDeps = Pick<AppDeps, 'remoteShell'>;

export function remoteShellRoutes(api: Hono, deps: RemoteShellRouteDeps): void {
  const svc = deps.remoteShell;
  if (!svc) return;
  api.post('/sessions/:id/remote-tabs', (c) => {
    const tab = svc.open(c.req.param('id'));
    return tab ? c.json(tab, 201) : c.json({ error: 'no remote owner' }, 404);
  });
  api.delete('/remote-tabs/:id', (c) => {
    const done = svc.close(c.req.param('id'));
    return done ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
  });
  api.put('/devices/:deviceId/ssh-host', async (c) => {
    const got = await readJson(c, BODY_LIMITS.default);
    if (got.tooLarge) return c.json({ error: 'too large' }, 413);
    const v = got.value as { host?: unknown } | undefined;
    if (!v || typeof v !== 'object' || !('host' in v)) return c.json({ error: 'invalid' }, 400);
    if (v.host !== null && !validSshHost(v.host)) return c.json({ error: 'invalid host' }, 400);
    svc.setHost(c.req.param('deviceId'), v.host);
    return c.body(null, 204);
  });
}
