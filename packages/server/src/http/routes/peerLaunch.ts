import type { Hono } from 'hono';
import type { PeerLaunchBody } from '@agent-hangar/shared';
import { listPeersForScreen, launchFromScreen } from '../../peer/screenLaunch.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, readJson } from './common.ts';

/**
 * 画面からの別の PC への起動（新規ダイアログの PC の選択）。
 * - GET  /api/peers        ほかの PC と、その様子（アカウント、エージェント、置き場のあるプロジェクト、頼めるか）。
 * - POST /api/peer-launch  選んだ PC に起動を頼む。人が選んだので承認は要らない（D8）。置く前に断れるものは reason で返し、
 *   置いたときは requested を返す。起きたかどうかは、後から画面の札で知らせる（peer/outbox.ts）。
 * /api の認証の下にあるので、MCP の秘密では呼べない（エージェントが承認なしで別の PC に起こす道にしない）。
 * 別の PC へ頼む口（peerCall）を持たない組み立てでは、どちらも出さない。
 */
export type PeerLaunchRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'peerCall'> & LanguageDeps;

export function peerLaunchRoutes(api: Hono, deps: PeerLaunchRouteDeps): void {
  const peer = deps.peerCall;
  if (!peer) return;
  api.get('/peers', (c) => c.json({ peers: listPeersForScreen(deps.db, deps.deviceId, peer, peer.now?.() ?? Date.now()) }));
  api.post('/peer-launch', async (c) => {
    const got = await readJson(c, BODY_LIMITS.default);
    if (got.tooLarge) return c.json({ error: 'too large' }, 413);
    try {
      return c.json(await launchFromScreen({ db: deps.db, deviceId: deps.deviceId, peer, language: deps.language }, got.value as PeerLaunchBody));
    } catch (e) {
      if (e instanceof TypeError) return c.json({ error: 'invalid' }, 400);
      throw e;
    }
  });
}
