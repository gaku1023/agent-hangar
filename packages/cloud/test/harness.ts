import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { bindingNames, bundleWorker, workerMetadata } from '../scripts/build-worker.ts';
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

// URL の pathname は Windows で /D:/... になり、esbuild が解決できない。
const CLOUD_DIR = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE_PATH = fileURLToPath(new URL('../src/index.bundle.js', import.meta.url));

let bundled: Promise<string> | null = null;

/** Worker を 1 つの ESM に束ねる。配布版に同梱する cloud/worker.mjs と同じ束である。テストのファイルごとに 1 回で足りる。 */
function workerScript(): Promise<string> {
  bundled ??= bundleWorker(CLOUD_DIR);
  return bundled;
}

/** Worker を 1 つ起こす。記憶は instance ごとに新しいので、テストごとに呼んでよい（おおよそ 100 ミリ秒）。 */
export async function startCloud(options: { JOIN_SECRET_HASH?: string; bindings?: Record<string, string>; outbound?: (req: Request) => Response | Promise<Response> } = {}): Promise<CloudHarness> {
  const script = await workerScript();
  const joinSecretHash = options.JOIN_SECRET_HASH ?? '';
  const meta = workerMetadata(CLOUD_DIR);
  const mf = new Miniflare({
    modules: true,
    script,
    scriptPath: BUNDLE_PATH,
    // 互換の日付と旗と束縛の名前は、配布版に同梱する metadata.json と同じ定義から取る。
    compatibilityDate: meta.compatibility_date,
    compatibilityFlags: meta.compatibility_flags,
    d1Databases: bindingNames(meta, 'd1'),
    r2Buckets: bindingNames(meta, 'r2_bucket'),
    bindings: { JOIN_SECRET_HASH: joinSecretHash, ...options.bindings },
    // Worker から外への fetch を受ける。渡さなければ外へは出ない（試験は実物の Cloudflare に触らない）。
    outboundService: options.outbound ?? (() => new Response('outbound fetch is not allowed in tests', { status: 599 })),
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
