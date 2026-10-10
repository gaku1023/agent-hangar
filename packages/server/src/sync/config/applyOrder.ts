import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigApplyOrderDto, ConfigApplyOrderItemDto } from '@agent-hangar/shared';
import { parseItemId } from './ids.ts';
import { applyOrderPath } from './paths.ts';

/**
 * 適用の指示書。承諾した項目を、サーバから殻の命令と hangar config apply へ渡す 1 つのファイルである。
 *
 * サーバは `~/.claude` に書かない（全体計画の D9）。書くのは、この指示書を読んでネイティブの確認を出し、
 * 控えを取ってから書く殻の命令と CLI だけである。指示書は、適用が済むか、利用者が取り消したら消す。
 * 指示書には項目の id、操作、採る側、相手の指紋、書き込み先だけを載せる。中身は inbox にあり、適用する側が指紋で突き合わせる。
 */

export type ApplyOrderFile = ConfigApplyOrderDto & { version: 1; deviceId: string };

/** 指示書を書く。置き換えるときも、半端なファイルを読ませないよう一時のファイルから rename する。 */
export function writeApplyOrder(home: string, deviceId: string, items: ConfigApplyOrderItemDto[], now: number): ConfigApplyOrderDto {
  const file = applyOrderPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body: ApplyOrderFile = { version: 1, deviceId, createdAt: now, items };
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return { createdAt: now, items };
}

const KINDS = new Set(['create', 'overwrite', 'delete', 'conflict']);
const TAKES = new Set(['remote', 'mine']);

/** 指示書を読む。無い、壊れている、形が違う、のどれかなら null。手で書き換えられても、形の外は読まない。 */
export function readApplyOrder(home: string): ConfigApplyOrderDto | null {
  let v: Partial<ApplyOrderFile> | null;
  try { v = JSON.parse(fs.readFileSync(applyOrderPath(home), 'utf8')) as Partial<ApplyOrderFile>; } catch { return null; }
  if (!v || v.version !== 1 || typeof v.createdAt !== 'number' || !Array.isArray(v.items)) return null;
  const items: ConfigApplyOrderItemDto[] = [];
  for (const raw of v.items as Partial<ConfigApplyOrderItemDto>[]) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.target !== 'string' || typeof raw.sha256 !== 'string' || typeof raw.fromDeviceId !== 'string') return null;
    const parsed = parseItemId(raw.id);
    if (!parsed || parsed.kind !== raw.kind || !KINDS.has(String(raw.op)) || !TAKES.has(String(raw.take))) return null;
    items.push(raw as ConfigApplyOrderItemDto);
  }
  return { createdAt: v.createdAt, items };
}

/** 指示書を消す。無くてもよい。消したかどうかを返す。 */
export function deleteApplyOrder(home: string): boolean {
  try { fs.unlinkSync(applyOrderPath(home)); return true; } catch { return false; }
}
