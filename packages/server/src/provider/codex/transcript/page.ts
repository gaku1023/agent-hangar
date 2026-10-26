import type { EventsPageDto } from '@agent-hangar/shared';
import type { ReadOpts } from '../../../agent/types.ts';
import type { Db } from '../../../db/open.ts';
import { readFilePage } from '../../../transcript/filePage.ts';
import { openLogicalBody } from './logical.ts';
import { normalizeCodexRecord } from './normalize.ts';

/**
 * Codex の会話の 1 ページを読む。読み方の本体はファイル型で共通（transcript/filePage.ts）で、
 * ここは Codex の正規化と、論理パスの実体（.jsonl か、圧縮された .jsonl.zst）を開く口を渡す。
 */
export function readCodexPage(db: Db, sessionId: string, opts: ReadOpts): EventsPageDto {
  return readFilePage(db, sessionId, opts, { normalize: normalizeCodexRecord, open: openLogicalBody });
}
