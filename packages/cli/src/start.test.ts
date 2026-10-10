import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPortFree, forwardsSignal, runStart, serverArgs } from './start.ts';

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

/** ファイルができるまで待つ。子が準備を済ませた合図に使う。 */
async function waitForFile(file: string): Promise<void> {
  while (!fs.existsSync(file)) await new Promise((r) => setTimeout(r, 20));
}

/**
 * SIGTERM を受け手で拾って 0 で終わる子の終了コード。
 * Windows の child.kill は信号を送らずにその場で終わらせるので、子は受け手を通らず、runStart は 1 を返す。
 */
const STOPPED_CODE = process.platform === 'win32' ? 1 : 0;

/**
 * CLI に SIGTERM が届いたことにする。
 * vitest の worker が先に持っていた受け手は外しておき、runStart の受け手にだけ届ける。
 */
function emitSigtermToRunStart(before: NodeJS.SignalsListener[]): void {
  for (const l of before) process.off('SIGTERM', l);
  try {
    process.emit('SIGTERM', 'SIGTERM');
  } finally {
    for (const l of before) process.on('SIGTERM', l);
  }
}

describe('forwardsSignal', () => {
  it('macOS と Linux は、届いた信号をどれも子へ渡す', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) expect([platform, sig, forwardsSignal(sig, platform)]).toEqual([platform, sig, true]);
    }
  });

  it('Windows は、コンソールが子にも直に届ける Ctrl+C と窓の閉じを渡さない', () => {
    // Windows の child.kill は信号を送らずにその場で終わらせる。渡すと、子が自分で受けた Ctrl+C の後始末（DB を閉じる）を途中で断ち切る。
    expect(forwardsSignal('SIGINT', 'win32')).toBe(false);
    expect(forwardsSignal('SIGHUP', 'win32')).toBe(false);
    // SIGTERM はコンソールからは届かない。プロセスの中から送られたときだけなので、子へ渡す（止めないと待ち続ける）。
    expect(forwardsSignal('SIGTERM', 'win32')).toBe(true);
  });
});

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

  it('起動の途中で利用者が止めたら（CLI に SIGTERM）、子へ渡し、失敗の行も URL も出さずに子の終了コードを返す', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReady = vi.fn();
    const trapped = path.join(tempDir(), 'trapped');
    // 待ち受けないまま、SIGTERM で 0 で終わる子（サーバの installShutdown の代わり）。受け手を付けたら印を置く。
    const script = [
      "process.on('SIGTERM', () => process.exit(0));",
      `require('node:fs').writeFileSync(${JSON.stringify(trapped)}, '');`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const before = process.listeners('SIGTERM');
    const run = runStart({ port: await deadPort(), onReady, args: ['-e', script] });
    await waitForFile(trapped);
    emitSigtermToRunStart(before);
    expect(await run).toBe(STOPPED_CODE);
    expect(onReady).not.toHaveBeenCalled();
    expect(errors(err)).not.toContain('起動の途中で終わりました');
  });

  it('止めた後に起動が済んでも、onReady を呼ばない（URL を出さず、ブラウザも開かない）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReady = vi.fn();
    const trapped = path.join(tempDir(), 'trapped');
    // SIGTERM を受けてから待ち受け、ready を 1 度返したら 0 で終わる子。止める信号と起動の完了が行き違った場合の代わりである。
    const script = [
      "process.on('SIGTERM', () => {",
      "  const s = require('node:http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }).end('{\"ok\":true,\"ready\":true}', () => setTimeout(() => process.exit(0), 100)); });",
      "  s.listen(Number(process.env.HANGAR_PORT), '127.0.0.1');",
      '});',
      `require('node:fs').writeFileSync(${JSON.stringify(trapped)}, '');`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const before = process.listeners('SIGTERM');
    const run = runStart({ port: await deadPort(), onReady, args: ['-e', script] });
    await waitForFile(trapped);
    emitSigtermToRunStart(before);
    expect(await run).toBe(STOPPED_CODE);
    expect(onReady).not.toHaveBeenCalled();
    expect(errors(err)).not.toContain('起動の途中で終わりました');
  });

  it('子に HANGAR_PORT と HANGAR_PARENT_PID を渡し、/health が ready を返したら onReady を 1 度だけ呼び、子が終わるまで待つ', async () => {
    const port = await deadPort();
    // サーバの代わりの小さな子。親の PID を受け取れていなければ 4 で終わる。
    // 渡されたポートで ready を返し、最初の ready を返し終えてから少しして 0 で終わる。
    // 待ち受けてからの時間で終わらせると、遅い機械では CLI が ready を見る前に子が終わってしまう。
    const script = [
      "if (process.env.HANGAR_PARENT_PID !== String(process.ppid)) process.exit(4);",
      "const s = require('node:http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }).end('{\"ok\":true,\"ready\":true}', () => setTimeout(() => process.exit(0), 150)); });",
      "s.listen(Number(process.env.HANGAR_PORT), '127.0.0.1');",
    ].join('\n');
    const onReady = vi.fn();
    const code = await runStart({ port, onReady, args: ['-e', script] });
    expect(code).toBe(0);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
