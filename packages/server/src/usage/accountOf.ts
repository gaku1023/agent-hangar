import { PRIMARY_ACCOUNT_ID } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { accountOfSession } from '../db/queries.ts';

/**
 * statusline の payload がどのアカウントのものかを引く。
 * payload からはアカウントが分からない（本文の置き場は共有）ので、セッションのこの PC での最後の run から引く。
 * hangar の外で起こしたセッションと、消したアカウントの run は、最初のアカウントとして数える。
 */
export function accountOfProviderSession(o: { db: Db; hasAccount: (id: string) => boolean; deviceId?: string }, providerSessionId: string | null): string {
  if (!providerSessionId) return PRIMARY_ACCOUNT_ID;
  const s = o.db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(providerSessionId) as { id: string } | undefined;
  // payload はこの PC で動く claude のものなので、この PC の run から引く（ほかの PC の run のアカウントの id はこの PC では別のものを指しうる）。
  const id = s ? accountOfSession(o.db, s.id, o.deviceId) : null;
  return id && o.hasAccount(id) ? id : PRIMARY_ACCOUNT_ID;
}
