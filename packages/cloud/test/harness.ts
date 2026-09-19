import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { Env } from '../src/env.ts';

/**
 * Worker をローカルの workerd（miniflare）で起こす道具である。
 * 実物の Cloudflare には触らず、D1 と R2 もローカルの実装を使う。
 *
 * 計画は @cloudflare/vitest-pool-workers の `cloudflare:test` を想定していたが、
 * その版はどれも vitest 4 までしか対応しておらず、このリポジトリの vitest 5 では起動しない。
 * 計画が用意していた miniflare への切り替えを採った（`SELF.fetch` は `dispatchFetch`、
 * `env.DB` は `getD1Database` に対応する）。
 */
export type CloudHarness = {
  /** Node 側から D1 と R2 を直に触るための束縛である。Worker の中の束縛と同じ実体を指す。 */
  env: Env;
  /** Worker への要求である。vitest-pool-workers の `SELF` と同じ使い方をする。 */
  SELF: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  /** 逃げ道である。上の 2 つで足りないときだけ使う。 */
  mf: Miniflare;
  dispose: () => Promise<void>;
};

const ENTRY = new URL('../src/index.ts', import.meta.url).pathname;
const BUNDLE_PATH = new URL('../src/index.bundle.js', import.meta.url).pathname;

let bundled: Promise<string> | null = null;

/** Worker を 1 つの ESM に束ねる。テストのファイルごとに 1 回で足りる。 */
function workerScript(): Promise<string> {
  bundled ??= build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['workerd', 'browser', 'module', 'main'],
    target: 'es2022',
    write: false,
  }).then((r) => r.outputFiles[0]!.text);
  return bundled;
}

/** Worker を 1 つ起こす。記憶は instance ごとに新しいので、テストごとに呼んでよい（おおよそ 100 ミリ秒）。 */
export async function startCloud(options: { JOIN_SECRET_HASH?: string } = {}): Promise<CloudHarness> {
  const script = await workerScript();
  const joinSecretHash = options.JOIN_SECRET_HASH ?? '';
  const mf = new Miniflare({
    modules: true,
    script,
    scriptPath: BUNDLE_PATH,
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    r2Buckets: ['BUCKET'],
    bindings: { JOIN_SECRET_HASH: joinSecretHash },
  });
  const env = {
    DB: await mf.getD1Database('DB'),
    BUCKET: await mf.getR2Bucket('BUCKET'),
    JOIN_SECRET_HASH: joinSecretHash,
  } as unknown as Env;
  return {
    env,
    SELF: { fetch: (input, init) => mf.dispatchFetch(input, init as never) as unknown as Promise<Response> },
    mf,
    dispose: () => mf.dispose(),
  };
}
