import type { Db } from '../db/open.ts';
import { countBindings } from './store.ts';

/**
 * 外のできごと（#563）を既定で切にしたときの移行。
 * 設定に eventTrigger が無く、結び付けが 1 件でもある PC は、入れていた人なので入りに書き替える。
 * 結び付けが無い PC は何もしない（切のまま、項目も足さない）。
 * 書き替えたら true を返す。呼び手が保存する。
 */
export function migrateEventTrigger(db: Db, settings: { eventTrigger?: boolean }): boolean {
  if (settings.eventTrigger !== undefined) return false;
  if (countBindings(db) === 0) return false;
  settings.eventTrigger = true;
  return true;
}
