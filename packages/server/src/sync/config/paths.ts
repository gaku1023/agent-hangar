import path from 'node:path';
import { backupsRoot } from '../../config/cloud.ts';

/**
 * 設定の同期（作り直した実装）が、hangar の置き場の中で使う場所。
 * `~/.claude` には何も置かない。サーバが書くのは、ここと DB だけである。
 *
 * - `<home>/claude-config/inbox/<端末の ID>/`：他の PC の束を開いた写し（目録と中身）。
 * - `<home>/claude-config/apply-order.json`：承諾した項目の「適用の指示書」。殻の命令と hangar config apply が読み、適用が済むか取り消されたら消す。
 * - `<home>/backups/claude-config/<時刻>/`：適用の前に取る控えの世代。書くのは適用する側で、サーバは数えるだけである。旧実装と同じ場所を使う。
 */

/** クラウドに置く束の、端末の下での相対パス。旧実装の設定ファイルの名前の外（先頭が .hangar/）で、旧実装は受け取らない。 */
export const BUNDLE_PATH = '.hangar/config-bundle.hgr';

export const configSyncDir = (home: string): string => path.join(home, 'claude-config');
export const inboxDir = (home: string): string => path.join(configSyncDir(home), 'inbox');
export const applyOrderPath = (home: string): string => path.join(configSyncDir(home), 'apply-order.json');
export const configBackupsDir = (home: string): string => path.join(backupsRoot(home), 'claude-config');
