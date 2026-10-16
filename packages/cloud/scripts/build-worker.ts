import fs from 'node:fs';
import path from 'node:path';
import { build, type BuildOptions } from 'esbuild';

/**
 * Worker を 1 本の ESM に束ねる道具と、その束縛の定義。
 * 使うのは 2 か所である。
 * test/harness.ts は、束ねた Worker を miniflare で起こして試す。
 * 端末に求める下限を差し替えた Worker を試すときは、入口だけを差し替え、workerBuildOptions の設定はそのまま通す。
 * apps/desktop/scripts/bundle-server.ts は、同じ束を配布版の cloud/worker.mjs に、定義を cloud/metadata.json に置く。
 * 同じ関数を通すので、配布物に入る束は試験で起こした束と同じになる。
 */

/** 同梱する束の名前。metadata.json の main_module もこれを指す。 */
export const WORKER_MODULE = 'worker.mjs';

/** 同梱する束縛の定義の名前。 */
export const WORKER_METADATA = 'metadata.json';

export type WorkerBinding = { type: 'd1'; name: string } | { type: 'r2_bucket'; name: string } | { type: 'durable_object_namespace'; name: string; class_name: string };

/** Durable Object の migrations の 1 段。写すのは SQLite 型のクラスを足す段だけである。 */
export type WorkerMigration = { tag: string; new_sqlite_classes: string[] };

/**
 * 束縛の定義。
 * 形は Cloudflare の REST で Worker のスクリプトを上げるときの metadata に寄せてある（段 5 でそのまま使うため）。
 * 資源ごとの値（D1 の id、R2 の bucket_name）と Worker の名前は利用者ごとに違うので、ここには持たない。
 */
export type WorkerMetadata = {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: WorkerBinding[];
  /** wrangler.jsonc の migrations をそのまま写す。setup cloud の書く設定とそろっているかを突き合わせるのに使う。 */
  migrations: WorkerMigration[];
};

/**
 * wrangler.jsonc の鍵のうち、定義へ写すものと、写さずに捨てるもの。
 * name、main、$schema は手元の開発用の値なので捨てる。
 * assets（スマホの画面の静的ファイル）は束縛ではないので、定義へは写さず捨てる。段 5 の REST で上げるときは assets を別に運ぶ要がある。vars は空であることだけを確かめる。
 * ここに無い鍵があれば止める。束縛の種類が増えたのに定義から黙って落ちると、段 5 で上げた Worker がその束縛を持たない。
 * d1_databases と r2_buckets の各項目から写すのは binding だけで、ほかの欄（R2 の jurisdiction など）は写さず、止めもしない。
 * 段 5 で REST から上げる処理を書くときに、そうした項目ごとの欄を運ぶ要があるかを決める。
 * durable_objects（呼び鈴）は name と class_name だけを写し、ほかの欄（script_name など）があれば止める。
 * 別の Worker のクラスを指す束縛は、同梱の束だけでは動かないからである。
 * migrations は SQLite 型のクラスを足す段（tag と new_sqlite_classes）だけを写し、ほかの段（名前の変更、消す）があれば止める。
 */
const KNOWN_KEYS = ['$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'd1_databases', 'r2_buckets', 'durable_objects', 'migrations', 'vars', 'assets'];

type WranglerConfig = {
  compatibility_date?: unknown;
  compatibility_flags?: string[];
  d1_databases?: { binding: string }[];
  r2_buckets?: { binding: string }[];
  durable_objects?: { bindings?: Record<string, unknown>[] };
  migrations?: Record<string, unknown>[];
  vars?: Record<string, unknown>;
};

/** esbuild に渡す設定のうち、入口を除く部分である。外への import を残さない。 */
export function workerBuildOptions(cloudDir: string): BuildOptions {
  return {
    // 束に残る元のファイルのパスの注釈は、作業ディレクトリからの相対で書かれる。
    // 根を packages/cloud に決め、どこから束ねても（試験はリポジトリの根、配布版は apps/desktop）同じ中身にする。
    absWorkingDir: cloudDir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['workerd', 'browser', 'module', 'main'],
    target: 'es2022',
    // workerd の組み込み（Durable Object の基底のクラスがある cloudflare:workers）は束ねずに残す。
    external: ['cloudflare:*'],
    write: false,
  };
}

/** Worker を 1 本の ESM に束ねる。入口は src/index.ts である。 */
export async function bundleWorker(cloudDir: string): Promise<string> {
  const r = await build({ ...workerBuildOptions(cloudDir), entryPoints: [path.join(cloudDir, 'src', 'index.ts')] });
  return r.outputFiles![0]!.text;
}

/**
 * packages/cloud/wrangler.jsonc から束縛の定義を作る。
 * 写すのは互換の日付と旗、D1 と R2 の束縛の名前、Durable Object の束縛と migrations だけである。
 */
export function workerMetadata(cloudDir: string): WorkerMetadata {
  const file = path.join(cloudDir, 'wrangler.jsonc');
  let w: WranglerConfig;
  try {
    // 行頭が // の行だけを落として JSON として読む。行の途中に注釈を書くと、ここで読めずに止まる。
    const text = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    w = JSON.parse(text) as WranglerConfig;
  } catch (e) {
    throw new Error(`${file} を読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
  const unknown = Object.keys(w).filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new Error(`${file} に、同梱の定義への写し方を決めていない設定があります: ${unknown.join(', ')}。packages/cloud/scripts/build-worker.ts に写し方を足してください`);
  }
  if (w.vars && Object.keys(w.vars).length > 0) {
    throw new Error(`${file} の vars が空ではありません。同梱の定義への写し方を packages/cloud/scripts/build-worker.ts に足してください`);
  }
  if (typeof w.compatibility_date !== 'string') throw new Error(`${file} に compatibility_date がありません`);
  const objects = (w.durable_objects?.bindings ?? []).map((b): WorkerBinding => {
    const extra = Object.keys(b).filter((k) => k !== 'name' && k !== 'class_name');
    if (extra.length > 0) throw new Error(`${file} の durable_objects に、同梱の定義への写し方を決めていない欄があります: ${extra.join(', ')}`);
    if (typeof b.name !== 'string' || typeof b.class_name !== 'string') throw new Error(`${file} の durable_objects に name か class_name がありません`);
    return { type: 'durable_object_namespace', name: b.name, class_name: b.class_name };
  });
  const migrations = (w.migrations ?? []).map((m): WorkerMigration => {
    const extra = Object.keys(m).filter((k) => k !== 'tag' && k !== 'new_sqlite_classes');
    if (extra.length > 0) throw new Error(`${file} の migrations に、同梱の定義への写し方を決めていない欄があります: ${extra.join(', ')}`);
    const classes = m.new_sqlite_classes;
    if (typeof m.tag !== 'string' || !Array.isArray(classes) || !classes.every((x) => typeof x === 'string')) throw new Error(`${file} の migrations の形が違います`);
    return { tag: m.tag, new_sqlite_classes: classes as string[] };
  });
  return {
    main_module: WORKER_MODULE,
    compatibility_date: w.compatibility_date,
    compatibility_flags: w.compatibility_flags ?? [],
    bindings: [
      ...(w.d1_databases ?? []).map((d): WorkerBinding => ({ type: 'd1', name: d.binding })),
      ...(w.r2_buckets ?? []).map((b): WorkerBinding => ({ type: 'r2_bucket', name: b.binding })),
      ...objects,
    ],
    migrations,
  };
}

/** 定義のうち、ある種類の束縛の名前。miniflare の d1Databases と r2Buckets に渡す形である。 */
export function bindingNames(meta: WorkerMetadata, type: WorkerBinding['type']): string[] {
  return meta.bindings.filter((b) => b.type === type).map((b) => b.name);
}

/**
 * 定義のうち、Durable Object の束縛。miniflare の durableObjects に渡す形である。
 * migrations で SQLite 型として足したクラスは useSQLite にする（無料プランで使えるのは SQLite 型だけ）。
 */
export function durableObjectsOf(meta: WorkerMetadata): Record<string, { className: string; useSQLite: boolean }> {
  const sqlite = new Set(meta.migrations.flatMap((m) => m.new_sqlite_classes));
  const out: Record<string, { className: string; useSQLite: boolean }> = {};
  for (const b of meta.bindings) {
    if (b.type === 'durable_object_namespace') out[b.name] = { className: b.class_name, useSQLite: sqlite.has(b.class_name) };
  }
  return out;
}
