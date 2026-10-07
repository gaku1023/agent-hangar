import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';
import { Miniflare } from 'miniflare';
import { COMPAT_HEADER, compatHeaders } from '@agent-hangar/shared';
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
  /**
   * Worker への要求である。vitest-pool-workers の `SELF` と同じ使い方をする。
   * 本物の端末と同じく、互換の版の見出し（いまの版）を足して送る。呼び手が見出しを載せていれば、そのまま送る。
   */
  SELF: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  /** 版の見出しを足さない要求である。版番号を入れる前の古い端末（版 0）の真似に使う。 */
  RAW: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  /** 逃げ道である。上の 2 つで足りないときだけ使う。 */
  mf: Miniflare;
  dispose: () => Promise<void>;
};

// URL の pathname は Windows で /D:/... になり、esbuild が解決できない。
const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const BUNDLE_PATH = fileURLToPath(new URL('../src/index.bundle.js', import.meta.url));

const COMMON: BuildOptions = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['workerd', 'browser', 'module', 'main'],
  target: 'es2022',
  write: false,
};

const bundles = new Map<string, Promise<string>>();

/**
 * Worker を 1 つの ESM に束ねる。テストのファイルごとに、下限の値ごとに 1 回で足りる。
 * minDeviceCompat を渡すと、端末に求める下限だけを差し替えた Worker を束ねる。
 * 差し替えは試験の中だけにあり、配備される入口（src/index.ts の既定の輸出）は MIN_DEVICE_COMPAT のままである。
 */
function workerScript(minDeviceCompat?: number): Promise<string> {
  const k = minDeviceCompat === undefined ? 'default' : String(minDeviceCompat);
  let p = bundles.get(k);
  if (!p) {
    const opts: BuildOptions = minDeviceCompat === undefined
      ? { ...COMMON, entryPoints: [ENTRY] }
      : {
          ...COMMON,
          stdin: {
            contents: `import { createApp } from './index.ts';\nexport default createApp({ minDeviceCompat: ${minDeviceCompat} });\n`,
            resolveDir: SRC_DIR,
            sourcefile: 'floor-entry.ts',
            loader: 'ts',
          },
        };
    p = build(opts).then((r) => {
      const out = r.outputFiles?.[0];
      if (!out) throw new Error('Worker を束ねられませんでした');
      return out.text;
    });
    bundles.set(k, p);
  }
  return p;
}

/** 本物の端末と同じく、版の見出しを足す。呼び手が載せていれば（古い版や壊れた値を試すとき）そのまま使う。 */
function withCompat(init: RequestInit = {}): RequestInit {
  const given = (init.headers ?? {}) as Record<string, string>;
  if (Object.keys(given).some((k) => k.toLowerCase() === COMPAT_HEADER)) return init;
  return { ...init, headers: { ...given, ...compatHeaders() } };
}

/** Worker を 1 つ起こす。記憶は instance ごとに新しいので、テストごとに呼んでよい（おおよそ 100 ミリ秒）。 */
export async function startCloud(options: { JOIN_SECRET_HASH?: string; bindings?: Record<string, string>; outbound?: (req: Request) => Response | Promise<Response>; minDeviceCompat?: number } = {}): Promise<CloudHarness> {
  const script = await workerScript(options.minDeviceCompat);
  const joinSecretHash = options.JOIN_SECRET_HASH ?? '';
  const mf = new Miniflare({
    modules: true,
    script,
    scriptPath: BUNDLE_PATH,
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    r2Buckets: ['BUCKET'],
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
    SELF: { fetch: (input, init) => mf.dispatchFetch(input, withCompat(init) as never) as unknown as Promise<Response> },
    RAW: { fetch: (input, init) => mf.dispatchFetch(input, init as never) as unknown as Promise<Response> },
    mf,
    dispose: () => mf.dispose(),
  };
}
