import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { bindingNames, bundleWorker, WORKER_METADATA, WORKER_MODULE, workerMetadata } from '../scripts/build-worker.ts';

const cloudDir = fileURLToPath(new URL('..', import.meta.url));
const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('同梱する Worker の束と束縛の定義', () => {
  it('束縛の定義は、wrangler.jsonc の互換の日付と旗、D1 と R2 の束縛の名前を写し、手元の資源の名前は写さない', () => {
    expect(WORKER_MODULE).toBe('worker.mjs');
    expect(WORKER_METADATA).toBe('metadata.json');
    expect(workerMetadata(cloudDir)).toEqual({
      main_module: 'worker.mjs',
      compatibility_date: '2026-08-01',
      compatibility_flags: ['nodejs_compat'],
      bindings: [
        { type: 'd1', name: 'DB' },
        { type: 'r2_bucket', name: 'BUCKET' },
      ],
    });
    // 手元の開発用の名前（hangar-local）と、ゼロの database_id は運ばない。
    expect(JSON.stringify(workerMetadata(cloudDir))).not.toContain('hangar-local');
    expect(JSON.stringify(workerMetadata(cloudDir))).not.toContain('00000000-0000');
  });

  // 入口の名前付きの輸出を Workers がどう扱うかは、クラス（Durable Object と WorkerEntrypoint）以外について文書に書かれていない。
  // 入口は既定の輸出だけにして、配備で確かめなければならない問いそのものを無くす。組み立ては src/app.ts にある。
  it('入口の束は既定の輸出だけを持つ', async () => {
    const script = await bundleWorker(cloudDir);
    const exported = [...script.matchAll(/^export\s*\{([^}]*)\}/gm)]
      .flatMap((m) => m[1]!.split(','))
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((s) => s.split(/\s+as\s+/).pop()!);
    expect(exported).toEqual(['default']);
    expect(script).not.toMatch(/^export\s+(const|let|var|function|async function|class)\s/m);
  });

  it('束は外への import を持たない 1 本の ESM で、定義の束縛で起こすと /health が通る', async () => {
    const script = await bundleWorker(cloudDir);
    expect(script).not.toMatch(/^import\s/m);
    expect(script).toMatch(/as default/);
    const meta = workerMetadata(cloudDir);
    const mf = new Miniflare({
      modules: true,
      script,
      // 絶対パスで作業ディレクトリの外を指すと、workerd は .. で抜けられずに起動を断る。名前だけを渡す。
      scriptPath: meta.main_module,
      compatibilityDate: meta.compatibility_date,
      compatibilityFlags: meta.compatibility_flags,
      d1Databases: bindingNames(meta, 'd1'),
      r2Buckets: bindingNames(meta, 'r2_bucket'),
      bindings: { JOIN_SECRET_HASH: '' },
      outboundService: () => new Response('outbound fetch is not allowed in tests', { status: 599 }),
    });
    try {
      const r = await mf.dispatchFetch('http://localhost/health');
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true });
    } finally {
      await mf.dispose();
    }
  });

  it('束は、どの作業ディレクトリから束ねても同じ中身になる（配布版は apps/desktop から束ね、試験は別の場所から束ねる）', async () => {
    const digest = (s: string): string => `${s.length} ${createHash('sha256').update(s).digest('hex')}`;
    const here = digest(await bundleWorker(cloudDir));
    // esbuild は読み込まれた時点の作業ディレクトリを覚えるので、process.chdir では確かめられない。別の node を、深さの違う場所で起こす。
    const tsx = import.meta.resolve('tsx');
    const mod = pathToFileURL(path.join(cloudDir, 'scripts', 'build-worker.ts')).href;
    const code = `const m = await import(${JSON.stringify(mod)}); const s = await m.bundleWorker(${JSON.stringify(cloudDir)}); const h = (await import('node:crypto')).createHash('sha256').update(s).digest('hex'); process.stdout.write(s.length + ' ' + h);`;
    for (const cwd of [path.resolve(cloudDir, '../..'), path.resolve(cloudDir, '../../apps/desktop'), fs.realpathSync(os.tmpdir())]) {
      const out = execFileSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', code], { cwd, encoding: 'utf8' });
      expect(out, cwd).toBe(here);
    }
  });

  it('写し方を決めていない設定（KV、vars の中身）や、行の途中の注釈があれば、黙って落とさずに止める', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-wrangler-'));
    temps.push(dir);
    const file = path.join(dir, 'wrangler.jsonc');
    const base = { name: 'x', main: 'src/index.ts', compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'], d1_databases: [{ binding: 'DB' }], r2_buckets: [{ binding: 'BUCKET' }], vars: {} };
    fs.writeFileSync(file, `// 行頭の注釈は読み飛ばす。\n${JSON.stringify(base)}\n`);
    expect(bindingNames(workerMetadata(dir), 'd1')).toEqual(['DB']);
    fs.writeFileSync(file, JSON.stringify({ ...base, kv_namespaces: [{ binding: 'KV' }] }));
    expect(() => workerMetadata(dir)).toThrow(/kv_namespaces/);
    fs.writeFileSync(file, JSON.stringify({ ...base, vars: { MODE: 'x' } }));
    expect(() => workerMetadata(dir)).toThrow(/vars/);
    fs.writeFileSync(file, '{ "name": "x", // 行の途中の注釈\n "compatibility_date": "2026-08-01" }\n');
    expect(() => workerMetadata(dir)).toThrow(/wrangler\.jsonc を読めません/);
  });
});
