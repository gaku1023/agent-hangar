import { isRec, versionOfRecord, type Drift } from './types.ts';

/** ~/.claude/sessions/<pid>.json の status として知っている値。shell は本体が休みで裏の Bash だけが動いていること。 */
export const KNOWN_REGISTRY_STATUSES: ReadonlySet<string> = new Set(['busy', 'idle', 'waiting', 'shell']);

/**
 * 1 件の登録が、hangar の読む形かを見る。
 * 知らない status は、読む側（readRegistry）が作業中として扱う。休んでいるセッションを止める機能があるので、誤って止めるより待たせるほうが害が小さい。
 */
export function registryDrifts(rec: unknown): Drift[] {
  if (!isRec(rec)) return [{ contract: 'registry', value: 'entry=(not-object)', version: null }];
  const version = versionOfRecord(rec);
  const out: Drift[] = [];
  const d = (value: string) => out.push({ contract: 'registry', value, version });
  if (typeof rec.sessionId !== 'string' || rec.sessionId === '') d('sessionId=(missing)');
  if (typeof rec.pid !== 'number') d('pid=(missing)');
  if (typeof rec.status !== 'string') d('status=(missing)');
  else if (!KNOWN_REGISTRY_STATUSES.has(rec.status)) d(`status=${rec.status}`);
  return out;
}
