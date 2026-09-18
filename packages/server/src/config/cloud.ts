import fs from 'node:fs';
import path from 'node:path';
import { ensureHome } from './paths.ts';

/**
 * ~/.agent-hangar/cloud.json。
 * 参加用の秘密と端末トークンを平文で持つので、入れ物を 0700、ファイルを 0600 で置く。
 * この中身はログにも例外のメッセージにも出さない。
 */
export type CloudConfig = {
  url: string;
  joinSecret: string;
  deviceToken: string;
  workerName: string | null;
  accountId: string | null;
  dbName: string | null;
  bucketName: string | null;
  joinedAt: number;
};

export function cloudConfigPath(home: string): string { return path.join(home, 'cloud.json'); }

/** 他端末から降ろした本文の置き場。 */
export function remoteRoot(home: string): string { return path.join(home, 'remote'); }

/** ~/.claude へ書き戻す前に取る控えの置き場。 */
export function backupsRoot(home: string): string { return path.join(home, 'backups'); }

/**
 * cloud.json を読む。
 * 無いときも、壊れているときも、必須の項目が欠けているときも null を返す。
 * 読めない設定で同期を始めてしまうより、参加していない扱いにする方が安全である。
 */
export function loadCloudConfig(home: string): CloudConfig | null {
  const file = cloudConfigPath(home);
  if (!fs.existsSync(file)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CloudConfig>;
    if (typeof v.url !== 'string' || typeof v.joinSecret !== 'string' || typeof v.deviceToken !== 'string') return null;
    return {
      url: v.url,
      joinSecret: v.joinSecret,
      deviceToken: v.deviceToken,
      workerName: v.workerName ?? null,
      accountId: v.accountId ?? null,
      dbName: v.dbName ?? null,
      bucketName: v.bucketName ?? null,
      joinedAt: typeof v.joinedAt === 'number' ? v.joinedAt : 0,
    };
  } catch {
    // 例外の中身には壊れたファイルの断片が載りうるので、握って null にする。
    return null;
  }
}

/** cloud.json を書く。mode は新しく作るときにしか効かないので、既にある分は chmod で直す。 */
export function saveCloudConfig(home: string, c: CloudConfig): void {
  ensureHome(home);
  const file = cloudConfigPath(home);
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
