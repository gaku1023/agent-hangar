import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPortFree, runStart, serverArgs } from './start.ts';

const temps: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise((r) => s.close(r));
  }
  vi.restoreAllMocks();
});

const tempDir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-start-'));
  temps.push(d);
  return d;
};

/** 自分で待ち受けたままにするポート。閉じるのは afterEach だけである。 */
async function busyPort(): Promise<number> {
  const s = createServer();
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

/** 誰も待ち受けていないポートを 1 つ取る。 */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

const errors = (spy: { mock: { calls: unknown[][] } }): string => spy.mock.calls.flat().join('\n');

describe('serverArgs', () => {
  it('隣に server.mjs があれば（配布版）、それだけを起こす', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'server.mjs'), '');
    expect(serverArgs(dir)).toEqual([path.join(dir, 'server.mjs')]);
  });

  it('隣に無ければ（リポジトリ）、packages/server の main.ts を tsx で起こす', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const args = serverArgs(here);
    expect(args.slice(0, 2)).toEqual(['--import', 'tsx']);
    expect(args[2]).toBe(path.resolve(here, '../../server/src/main.ts'));
    expect(fs.existsSync(args[2]!)).toBe(true);
  });
});

describe('assertPortFree', () => {
  it('空いていれば通り、使われていれば EADDRINUSE で断る', async () => {
    await expect(assertPortFree(await deadPort())).resolves.toBeUndefined();
    await expect(assertPortFree(await busyPort())).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('runStart', () => {
  it('ポートが使われていれば、子を起こさずに日本語の 1 行を出して 1 を返す', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReady = vi.fn();
    const marker = path.join(tempDir(), 'spawned');
    const code = await runStart({ port: await busyPort(), onReady, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`] });
    expect(code).toBe(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
    expect(errors(err)).toContain('は既に使われています');
  });

  it('ポートが 1 から 65535 の整数でなければ、子を起こさずに断る。0 で起こすと、子の選んだポートを知る手が無く待ち続けてしまう', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReady = vi.fn();
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(await runStart({ port, onReady, args: ['-e', 'setTimeout(() => {}, 60000)'] }), String(port)).toBe(1);
    }
    expect(onReady).not.toHaveBeenCalled();
    expect(errors(err)).toContain('1 から 65535');
  });

  it('子が起動の途中で終われば、onReady を呼ばずに子の終了コードを返す', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReady = vi.fn();
    const code = await runStart({ port: await deadPort(), onReady, args: ['-e', 'process.exit(3)'] });
    expect(code).toBe(3);
    expect(onReady).not.toHaveBeenCalled();
    expect(errors(err)).toContain('起動の途中で終わりました');
  });

  it('子に HANGAR_PORT と HANGAR_PARENT_PID を渡し、/health が ready を返したら onReady を 1 度だけ呼び、子が終わるまで待つ', async () => {
    const port = await deadPort();
    // サーバの代わりの小さな子。親の PID を受け取れていなければ 4 で終わる。
    // 渡されたポートで ready を返し、少ししてから 0 で終わる。
    const script = [
      "if (process.env.HANGAR_PARENT_PID !== String(process.ppid)) process.exit(4);",
      "const s = require('node:http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }).end('{\"ok\":true,\"ready\":true}'); });",
      "s.listen(Number(process.env.HANGAR_PORT), '127.0.0.1', () => setTimeout(() => process.exit(0), 800));",
    ].join('\n');
    const onReady = vi.fn();
    const code = await runStart({ port, onReady, args: ['-e', script] });
    expect(code).toBe(0);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
