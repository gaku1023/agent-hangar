import type { EventsPageDto } from '@agent-hangar/shared';
import type { ReadOpts } from '../../../agent/types.ts';
import type { Db } from '../../../db/open.ts';
import { openFsBody, readFilePage } from '../../../transcript/filePage.ts';
import { normalizeRecord } from './normalize.ts';

/**
 * Claude の会話の 1 ページを読む。索引のバイト位置から本文ファイルを読み、正規化イベントを返す。
 * 読み方の本体はファイル型で共通（transcript/filePage.ts）で、ここは Claude の正規化と、論理パスをそのまま開く口を渡す。
 */
export function readClaudePage(db: Db, sessionId: string, opts: ReadOpts): EventsPageDto {
  return readFilePage(db, sessionId, opts, { normalize: normalizeRecord, open: openFsBody });
}
