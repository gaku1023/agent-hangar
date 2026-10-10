import fs from 'node:fs';
import path from 'node:path';
import { isSafeKeyId } from '@agent-hangar/shared';
import type { ManifestItem, UnpackedBundle } from './bundle.ts';
import { inboxDir } from './paths.ts';

/**
 * 他の PC の束を開いた写し（inbox）。~/.claude には触れない。
 * 1 台 1 ディレクトリで、`meta.json`、`manifest.json`（検査を通った項目の一覧）、`blobs/<指紋>`（項目の中身）を持つ。
 * 書くときは一時のディレクトリに作ってから置き換える。途中までの写しを読まれないようにするためである。
 */

export type InboxMeta = {
  /** 開いた束の指紋（束の tar の sha256）。 */
  bundleSha256: string;
  /** この束を取りに行ったときの、config_snapshots の行の指紋。行より束が新しいことがあるので、取りに行った理由として覚える。 */
  forRowSha256: string;
  /** 束を上げた時刻（config_snapshots.updated_at）。3 方向の判定で新しい方を採るのに使う。 */
  at: number;
  itemCount: number;
  skipped: number;
};

export type InboxEntry = { deviceId: string; meta: InboxMeta; items: ManifestItem[] };

const dirOf = (home: string, deviceId: string): string => path.join(inboxDir(home), deviceId);

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

const isMeta = (v: unknown): v is InboxMeta => {
  const m = v as Partial<InboxMeta> | null;
  return !!m && typeof m.bundleSha256 === 'string' && typeof m.forRowSha256 === 'string' && typeof m.at === 'number' && typeof m.itemCount === 'number' && typeof m.skipped === 'number';
};

export function writeInbox(home: string, deviceId: string, bundle: UnpackedBundle, meta: InboxMeta): void {
  if (!isSafeKeyId(deviceId)) throw new Error('端末 ID の形が不正です');
  const root = inboxDir(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(root, `.tmp-${deviceId}-`));
  try {
    fs.mkdirSync(path.join(tmp, 'blobs'), { mode: 0o700 });
    for (const it of bundle.manifest.items) {
      const dest = path.join(tmp, 'blobs', it.sha256);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, bundle.blobs.get(it.sha256)!, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(bundle.manifest.items), { mode: 0o600 });
    fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    const dest = dirOf(home, deviceId);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export function readInboxMeta(home: string, deviceId: string): InboxMeta | null {
  if (!isSafeKeyId(deviceId)) return null;
  const m = readJson<unknown>(path.join(dirOf(home, deviceId), 'meta.json'));
  return isMeta(m) ? m : null;
}

/** 写しのある端末を、端末 ID の順に全部読む。壊れたものは飛ばす。 */
export function readInbox(home: string): InboxEntry[] {
  let names: string[];
  try { names = fs.readdirSync(inboxDir(home)); } catch { return []; }
  const out: InboxEntry[] = [];
  for (const deviceId of names.filter((n) => !n.startsWith('.')).sort()) {
    const meta = readInboxMeta(home, deviceId);
    const items = readJson<ManifestItem[]>(path.join(dirOf(home, deviceId), 'manifest.json'));
    if (meta && Array.isArray(items)) out.push({ deviceId, meta, items });
  }
  return out;
}

/** 項目の中身。指紋は外から来た値なので、形を見てから開く。 */
export function readInboxBlob(home: string, deviceId: string, sha256: string): Buffer | null {
  if (!isSafeKeyId(deviceId) || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  try { return fs.readFileSync(path.join(dirOf(home, deviceId), 'blobs', sha256)); } catch { return null; }
}

/** 行の無くなった端末の写しを消す。途中で残った一時のディレクトリも消す。 */
export function pruneInbox(home: string, keep: ReadonlySet<string>): void {
  let names: string[];
  try { names = fs.readdirSync(inboxDir(home)); } catch { return; }
  for (const n of names) if (n.startsWith('.tmp-') || !keep.has(n)) fs.rmSync(path.join(inboxDir(home), n), { recursive: true, force: true });
}
