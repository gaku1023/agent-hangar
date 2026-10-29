import type { LinkConflictsDto, LinkRepairRequest } from '@agent-hangar/shared';
import { AccountError, PRIMARY_ACCOUNT_ID, type Account } from '../config/accounts.ts';
import { causeOf, msg } from '../i18n/message.ts';
import { fixableConflicts, linkConflictDetail, linkEntries, LinkRepairError, resolveLinkConflict } from '../platform/links.ts';

/**
 * 衝突したリンクの修復の口が、Claude と Codex で共有する分。
 * 触れる名前は、そのエージェントのリンクの項目（names）だけである。
 */
export type LinkRepairTarget = { agent: 'claude-code' | 'codex'; primaryDir: string; names: readonly string[] };

/** いま選んで直せる（両側がファイルで中身が違う）項目の名前。何も作らず、何も書かない。 */
export function fixableOf(t: LinkRepairTarget, a: Account): string[] {
  const { conflicts } = linkEntries(t.primaryDir, a.dir, t.names, false);
  return fixableConflicts(t.primaryDir, a.dir, conflicts);
}

/** GET の答え。最初のアカウントには衝突が無いので 400 にする。 */
export function linkConflictsOf(t: LinkRepairTarget, a: Account): LinkConflictsDto {
  if (a.id === PRIMARY_ACCOUNT_ID) throw new AccountError(400, msg('account.links.repairRejected'));
  return { accountId: a.id, agent: t.agent, entries: fixableOf(t, a).map((n) => linkConflictDetail(t.primaryDir, a.dir, n)) };
}

/** POST の本文を確かめる。形が違うか、リンクの項目にない名前があれば 400 を投げる。 */
export function parseRepair(t: LinkRepairTarget, body: Record<string, unknown>): LinkRepairRequest['entries'] {
  const bad = () => new AccountError(400, msg('common.field.send', { field: 'entries' }));
  if (!Array.isArray(body.entries)) throw bad();
  return body.entries.map((e: unknown) => {
    const o = (typeof e === 'object' && e !== null ? e : {}) as { name?: unknown; keep?: unknown };
    if (typeof o.name !== 'string' || !t.names.includes(o.name) || (o.keep !== 'mine' && o.keep !== 'shared')) throw bad();
    return { name: o.name, keep: o.keep };
  });
}

/** 選んだとおりに直す。1 件でも断られたら、そこで止めて 400 にする（それまでの分は直したまま）。 */
export function repairLinks(t: LinkRepairTarget, a: Account, entries: LinkRepairRequest['entries'], now: Date = new Date()): void {
  if (a.id === PRIMARY_ACCOUNT_ID) throw new AccountError(400, msg('account.links.repairRejected'));
  for (const e of entries) {
    try { resolveLinkConflict(t.primaryDir, a.dir, e.name, e.keep, now); } catch (err) {
      if (err instanceof LinkRepairError) throw new AccountError(400, msg('account.links.repairRejected'));
      throw new AccountError(400, causeOf(err));
    }
  }
}
