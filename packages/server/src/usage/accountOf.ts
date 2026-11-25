import { PRIMARY_ACCOUNT_ID } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { accountOfSession } from '../db/queries.ts';

/**
 * statusline の payload がどのアカウントのものかを引く。
 * payload からはアカウントが分からない（本文の置き場は共有）ので、セッションのこの PC での最後の run から引く。
 * スニペットが設定の置き場（configDir）を送ってきたら、先にそれで引く。
 * hangar の外で起こしたセッションと、消したアカウントの run は、最初のアカウントとして数える。
 */
export function accountOfProviderSession(
  o: { db: Db; hasAccount: (id: string) => boolean; deviceId?: string; accountOfDir?: (dir: string) => string | null; primaryDir?: string },
  providerSessionId: string | null,
  configDir?: string | null,
): string {
  // statusline のコマンドは claude の環境で走るので、送られた置き場がいちばん確かである。
  // run は hangar が起こした会話のアカウントで、その会話の中で別の置き場の claude を起こしたとき（子の claude）は食い違う。
  // 空は CLAUDE_CONFIG_DIR を持たない claude、つまり既定の置き場（最初のアカウント）である。
  // どのアカウントにも当たらない置き場と、送らない古いスニペットは run から引く。
  if (configDir !== undefined && o.accountOfDir) {
    const dir = configDir || o.primaryDir;
    const id = dir ? o.accountOfDir(dir) : null;
    if (id && o.hasAccount(id)) return id;
  }
  if (!providerSessionId) return PRIMARY_ACCOUNT_ID;
  const s = o.db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(providerSessionId) as { id: string } | undefined;
  // payload はこの PC で動く claude のものなので、この PC の run から引く（ほかの PC の run のアカウントの id はこの PC では別のものを指しうる）。
  const id = s ? accountOfSession(o.db, s.id, o.deviceId) : null;
  return id && o.hasAccount(id) ? id : PRIMARY_ACCOUNT_ID;
}
