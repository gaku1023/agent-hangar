import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backfillTranscripts, type CloudConfig, deriveFileKey, encryptBuffer, loadCloudConfig, readTranscriptsFrom, saveCloudConfig, stampTranscriptsFrom } from '@agent-hangar/server';
import { COMPAT_HEADER, COMPAT_VERSION, decodeJoinToken, encodeJoinToken, type FileEntry } from '@agent-hangar/shared';
import { cloudBackfill, cloudStatus, defaultCloudDir, installUsageToken, joinWorker, offerUsageToken, OVERWRITE_WORD, promptWord, rescueTargetPath, RENAME_WORD, ROTATE_WORD, requireCloudDir, runJoin, runSetupCloud, runTeardown, USAGE_TOKEN_HELP, waitForHealth, writeWranglerConfig } from './cloud.ts';
import { bindingNames, workerMetadata } from '../../cloud/scripts/build-worker.ts';
import type { Exec, ExecResult, Interactive } from './wrangler.ts';
import { WranglerRunner } from './wrangler.ts';
import { dbVersionOf, LATEST_DB_VERSION, seedDbAt } from '../../server/test/oldDb.ts';
import { expectMode } from '../../server/test/platform.ts';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const device = { id: 'dev-a', name: 'mac', platform: 'darwin' };
const DB_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const WHOAMI = `│ Acc │ ${ACCOUNT} │`;

const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

/** 一時の home と、basename が cloud の一時の cloudDir を作る。 */
function dirs(): { home: string; cloudDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-setup-'));
  temps.push(root);
  const home = path.join(root, 'home');
  const cloudDir = path.join(root, 'cloud');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cloudDir, { recursive: true });
  return { home, cloudDir };
}

type Script = Record<string, (args: string[], input?: string) => ExecResult>;

function fakeWrangler(script: Script) {
  const calls: { args: string[]; input?: string; env: NodeJS.ProcessEnv }[] = [];
  const interactiveCalls: string[][] = [];
  const exec: Exec = async (_cmd, args, o) => {
    const w = args.findIndex((a) => a.endsWith('wrangler.js'));
    const rest = w >= 0 ? args.slice(w + 1) : args;
    calls.push({ args: rest, input: o.input, env: o.env });
    const key = Object.keys(script).find((k) => rest.join(' ').startsWith(k));
    return key ? script[key]!(rest, o.input) : { code: 1, stdout: '', stderr: `unexpected: ${rest.join(' ')}` };
  };
  const interactive: Interactive = async (args) => {
    const w = args.findIndex((a) => a.endsWith('wrangler.js'));
    interactiveCalls.push(w >= 0 ? args.slice(w + 1) : args);
    return 0;
  };
  return {
    calls,
    interactiveCalls,
    runner: (accountId: string | null, cloudDir: string): WranglerRunner => new WranglerRunner({ cloudDir, accountId, exec, interactive }),
  };
}

function fakeFetch(healthFails = 2): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let fails = healthFails;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/health')) {
      if (fails-- > 0) return new Response('error code: 1042', { status: 530 });
      return new Response(JSON.stringify({ ok: true, version: '0.4.0' }), { status: 200 });
    }
    if (url.endsWith('/join')) {
      const body = JSON.parse(init!.body as string) as { secret: string; device: typeof device };
      expect(body.device).toEqual(device);
      return new Response(JSON.stringify({ deviceToken: 'tok-' + body.secret.slice(0, 4), deviceId: body.device.id }), { status: 201 });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetch: f, urls };
}

/** 繋がりはするが何も返さない宛先。締め切りで中断されたときだけ落ちる。 */
function blackHole(): typeof fetch {
  return ((_u: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) throw new Error('締め切りの signal が渡っていない');
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason as Error));
    });
  }) as unknown as typeof fetch;
}

describe('runSetupCloud', () => {
  it('資源を作り、設定を書き、デプロイし、health を待ち、参加して cloud.json とトークンを出す', async () => {
    const { home, cloudDir } = dirs();
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ({ code: 1, stdout: '', stderr: 'not found' }),
      'd1 create hangar': () => ok(`database_id = "${DB_ID}"`),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('Deployed hangar\n  https://hangar.example.workers.dev'),
      'secret put JOIN_SECRET_HASH': (_a, input) => {
        expect(input).toMatch(/^[0-9a-f]{64}\n$/);
        return ok('Success');
      },
    });
    const ff = fakeFetch();
    const slept: number[] = [];
    const lines: string[] = [];
    const r = await runSetupCloud({
      home,
      device,
      wrangler: w.runner(null, cloudDir),
      fetch: ff.fetch,
      sleep: async (ms) => { slept.push(ms); },
      cloudDir,
      log: (l) => lines.push(l),
    });

    expect(r.url).toBe('https://hangar.example.workers.dev');
    const tok = decodeJoinToken(r.joinToken);
    expect(tok.url).toBe(r.url);
    expect(tok.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;
    expect(cfg.name).toBe('hangar');
    expect((cfg.d1_databases as unknown[])[0]).toEqual({ binding: 'DB', database_name: 'hangar', database_id: DB_ID });
    expect((cfg.r2_buckets as unknown[])[0]).toEqual({ binding: 'BUCKET', bucket_name: 'hangar-files' });
    expect(path.isAbsolute(cfg.main as string)).toBe(true);
    expect((cfg.main as string).endsWith(path.join('cloud', 'src', 'index.ts'))).toBe(true);
    // 実物のアカウント ID は設定ファイルに書かない。環境変数で渡す。
    expect(JSON.stringify(cfg)).not.toContain(ACCOUNT);

    const saved = loadCloudConfig(home)!;
    expect(saved).toMatchObject({
      url: r.url,
      joinSecret: tok.secret,
      deviceToken: 'tok-' + tok.secret.slice(0, 4),
      workerName: 'hangar',
      accountId: ACCOUNT,
      dbName: 'hangar',
      bucketName: 'hangar-files',
    });
    expectMode(path.join(home, 'cloud.json'), 0o600);

    const cmds = w.calls.map((c) => c.args.slice(0, 3).join(' '));
    expect(cmds).toEqual(['whoami', 'd1 info hangar', 'd1 create hangar', 'r2 bucket create', 'deploy --config ' + path.join(home, 'cloud', 'wrangler.jsonc'), 'secret put JOIN_SECRET_HASH']);
    expect(w.calls.slice(1).every((c) => c.env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT)).toBe(true);
    expect(ff.urls.filter((u) => u.endsWith('/health'))).toHaveLength(3);
    expect(slept.filter((ms) => ms === 5000).length).toBeGreaterThanOrEqual(2);

    const hash = createHash('sha256').update(tok.secret).digest('hex');
    expect(w.calls.at(-1)!.input).toBe(hash + '\n');
    // 秘密そのものは argv にも設定ファイルにも出さない。
    expect(w.calls.some((c) => c.args.join(' ').includes(tok.secret))).toBe(false);

    // 参加トークンの渡し方を案内し、標準出力に残ることも伝える。
    const out = lines.join('\n');
    expect(out).toContain(r.joinToken);
    expect(out).toContain('1Password');
    expect(out).toContain('hangar join');
    expect(out).toContain('スクロールバック');
  });

  it('既存の資源と秘密を再利用し、--name で名前を変える', async () => {
    const { home, cloudDir } = dirs();
    const keep = 'keep-this-secret-value-000000000000000000';
    fs.writeFileSync(
      path.join(home, 'cloud.json'),
      JSON.stringify({ url: 'https://old.workers.dev', joinSecret: keep, deviceToken: 'old', workerName: 'hangar-dev', accountId: null, dbName: null, bucketName: null, joinedAt: 1 }),
    );
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar-dev --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-dev-files': () => ({ code: 1, stdout: '', stderr: 'A bucket with this name already exists' }),
      deploy: () => ok('https://hangar-dev.example.workers.dev'),
      'secret put JOIN_SECRET_HASH': () => ok(),
    });
    const ff = fakeFetch();
    const r = await runSetupCloud({ home, name: 'hangar-dev', device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} });
    expect(decodeJoinToken(r.joinToken).secret).toBe(keep);
    expect(w.calls.map((c) => c.args[0])).toEqual(['whoami', 'd1', 'r2', 'deploy', 'secret']);
    expect(loadCloudConfig(home)).toMatchObject({ workerName: 'hangar-dev', dbName: 'hangar-dev', bucketName: 'hangar-dev-files', url: 'https://hangar-dev.example.workers.dev' });
  });

  it('ログインしていなければ login を対話で実行してからもう一度読む', async () => {
    const { home, cloudDir } = dirs();
    let asked = 0;
    const w = fakeWrangler({
      whoami: () => (asked++ === 0 ? { code: 1, stdout: '', stderr: 'You are not authenticated' } : ok(WHOAMI)),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put JOIN_SECRET_HASH': () => ok(),
    });
    const ff = fakeFetch(0);
    await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} });
    expect(w.interactiveCalls).toEqual([['login']]);
    expect(w.calls.filter((c) => c.args[0] === 'whoami')).toHaveLength(2);
    expect(loadCloudConfig(home)!.accountId).toBe(ACCOUNT);
  });

  it('cloud.json が壊れていたら、参加し直さずに止める', async () => {
    const { home, cloudDir } = dirs();
    const file = path.join(home, 'cloud.json');
    fs.writeFileSync(file, '{ こわれている');
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    await expect(
      runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch().fetch, sleep: async () => {}, cloudDir, log: () => {} }),
    ).rejects.toThrow(/cloud\.json/);
    // 壊れたファイルには触らない。wrangler も一度も呼ばない。
    expect(fs.readFileSync(file, 'utf8')).toBe('{ こわれている');
    expect(w.calls).toHaveLength(0);
  });

  it('cloud.json を書くのと同じ時点で、本文を上げ始める床を刻む', async () => {
    const { home, cloudDir } = dirs();
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('Deployed hangar\n  https://hangar.example.workers.dev'),
      'secret put JOIN_SECRET_HASH': () => ok('Success'),
    });
    await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch().fetch, sleep: async () => {}, cloudDir, log: () => {} });

    // 床はサーバの起動を待たずに入る。古いサーバが先に走っても、床の無い隙が生まれない。
    const joinedAt = loadCloudConfig(home)!.joinedAt;
    expect(joinedAt).toBeGreaterThan(0);
    expect(readTranscriptsFrom(home)).toBe(joinedAt);
  });

  it('別の名前で作り直すときは、前の資源が置き去りになることを見せて確認する', async () => {
    const { home, cloudDir } = dirs();
    const before = JSON.stringify({
      url: 'https://hangar-dev.example.workers.dev',
      joinSecret: 'keep-this-secret-value-000000000000000000',
      deviceToken: 'old',
      workerName: 'hangar-dev',
      accountId: ACCOUNT,
      dbName: 'hangar-dev',
      bucketName: 'hangar-dev-files',
      joinedAt: 1,
    });
    fs.writeFileSync(path.join(home, 'cloud.json'), before);
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    const asked: { question: string; word: string }[] = [];
    const lines: string[] = [];
    await expect(
      runSetupCloud({
        home,
        device,
        name: 'hangar',
        wrangler: w.runner(null, cloudDir),
        fetch: fakeFetch().fetch,
        sleep: async () => {},
        cloudDir,
        log: (l) => lines.push(l),
        confirm: async (question, word) => { asked.push({ question, word }); return false; },
      }),
    ).rejects.toThrow(/取りやめ/);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.word).toBe(RENAME_WORD);
    // 置き去りになる資源を名指しで見せる。teardown は cloud.json しか見ないので、届かなくなる。
    const out = lines.join('\n');
    expect(out).toContain('hangar-dev');
    expect(out).toContain('hangar-dev-files');
    expect(out).toContain('片付けられなくなります');
    // 断ったら資源にも cloud.json にも触らない。
    expect(w.calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(home, 'cloud.json'), 'utf8')).toBe(before);
  });

  it('参加だけの端末で setup cloud を走らせるときも確認する', async () => {
    const { home, cloudDir } = dirs();
    fs.writeFileSync(
      path.join(home, 'cloud.json'),
      JSON.stringify({ url: 'https://other.example.workers.dev', joinSecret: 'k', deviceToken: 'old', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 }),
    );
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    const lines: string[] = [];
    await expect(
      runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch().fetch, sleep: async () => {}, cloudDir, log: (l) => lines.push(l), confirm: async () => false }),
    ).rejects.toThrow(/取りやめ/);
    expect(lines.join('\n')).toContain('https://other.example.workers.dev');
    expect(w.calls).toHaveLength(0);
  });

  it('--rotate-secret は確認を必須にし、断られたら何もしない', async () => {
    const { home, cloudDir } = dirs();
    const keep = 'keep-this-secret-value-000000000000000000';
    const before = JSON.stringify({ url: 'https://old.workers.dev', joinSecret: keep, deviceToken: 'old', workerName: 'hangar', accountId: null, dbName: null, bucketName: null, joinedAt: 1 });
    fs.writeFileSync(path.join(home, 'cloud.json'), before);
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    const asked: { question: string; word: string }[] = [];
    const lines: string[] = [];
    await expect(
      runSetupCloud({
        home,
        device,
        rotateSecret: true,
        wrangler: w.runner(null, cloudDir),
        fetch: fakeFetch().fetch,
        sleep: async () => {},
        cloudDir,
        log: (l) => lines.push(l),
        confirm: async (question, word) => { asked.push({ question, word }); return false; },
      }),
    ).rejects.toThrow(/取りやめ/);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.word).toBe(ROTATE_WORD);
    // 何が起きるかを先に伝える。
    const out = lines.join('\n');
    expect(out).toContain('復号できなくなります');
    expect(out).toContain('R2');
    expect(w.calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(home, 'cloud.json'), 'utf8')).toBe(before);
  });

  it('--rotate-secret を承諾すると新しい秘密になる', async () => {
    const { home, cloudDir } = dirs();
    const keep = 'keep-this-secret-value-000000000000000000';
    fs.writeFileSync(
      path.join(home, 'cloud.json'),
      JSON.stringify({ url: 'https://old.workers.dev', joinSecret: keep, deviceToken: 'old', workerName: 'hangar', accountId: null, dbName: null, bucketName: null, joinedAt: 1 }),
    );
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put JOIN_SECRET_HASH': () => ok(),
    });
    const r = await runSetupCloud({
      home,
      device,
      rotateSecret: true,
      wrangler: w.runner(null, cloudDir),
      fetch: fakeFetch(0).fetch,
      sleep: async () => {},
      cloudDir,
      log: () => {},
      confirm: async () => true,
    });
    const secret = decodeJoinToken(r.joinToken).secret;
    expect(secret).not.toBe(keep);
    expect(loadCloudConfig(home)!.joinSecret).toBe(secret);
    expect(w.calls.at(-1)!.input).toBe(createHash('sha256').update(secret).digest('hex') + '\n');
  });

  it('応答を返さない宛先でも health の待ちは終わる', async () => {
    let t = 0;
    const okAfter = await waitForHealth('https://h', { fetch: blackHole(), sleep: async (ms) => { t += ms; }, timeoutMs: 60, intervalMs: 20 });
    expect(okAfter).toBe(false);
    expect(t).toBeGreaterThanOrEqual(60);
  });

  it('health が 2 分通らなければ失敗する', async () => {
    let t = 0;
    const never = (async () => new Response('error code: 1042', { status: 530 })) as typeof fetch;
    const okAfter = await waitForHealth('https://h', { fetch: never, sleep: async (ms) => { t += ms; }, timeoutMs: 120_000, intervalMs: 5000 });
    expect(okAfter).toBe(false);
    expect(t).toBeGreaterThanOrEqual(120_000);
    expect(t).toBeLessThan(130_000);
  });
});

describe('joinWorker', () => {
  it('秘密の反映待ちの 503 と 403 は待って試し直す', async () => {
    const codes = [503, 403, 201];
    let i = 0;
    const f = (async () => {
      const code = codes[i++]!;
      return code === 201 ? new Response(JSON.stringify({ deviceToken: 't', deviceId: device.id }), { status: 201 }) : new Response(JSON.stringify({ error: 'x' }), { status: code });
    }) as typeof fetch;
    const slept: number[] = [];
    const r = await joinWorker('https://h', 's', device, { fetch: f, sleep: async (ms) => { slept.push(ms); }, retryForbidden: true });
    expect(r.deviceToken).toBe('t');
    expect(slept).toHaveLength(2);
  });

  it('参加のときの 403 は待たずに断る', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })) as typeof fetch;
    const slept: number[] = [];
    await expect(joinWorker('https://h', 's', device, { fetch: f, sleep: async (ms) => { slept.push(ms); } })).rejects.toThrow(/秘密/);
    expect(slept).toHaveLength(0);
  });

  it('待っても 503 のままなら諦める', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'not initialized' }), { status: 503 })) as typeof fetch;
    const slept: number[] = [];
    await expect(joinWorker('https://h', 's', device, { fetch: f, sleep: async (ms) => { slept.push(ms); }, retries: 2 })).rejects.toThrow(/503/);
    expect(slept).toHaveLength(2);
  });

  it('応答を返さない宛先は締め切りで打ち切る', async () => {
    const slept: number[] = [];
    await expect(
      joinWorker('https://black-hole.invalid', 's', device, { fetch: blackHole(), sleep: async (ms) => { slept.push(ms); }, timeoutMs: 20 }),
    ).rejects.toThrow(/応答しませんでした/);
    // 黙って止まらない。待ちもしない。
    expect(slept).toHaveLength(0);
  });

  it('打ち切りの文面は宛先と次に見る先を示す', async () => {
    const e: Error = await joinWorker('https://black-hole.invalid', 'SECRET-abcdef', device, { fetch: blackHole(), sleep: async () => {}, timeoutMs: 20 }).then(() => { throw new Error('打ち切られるはずが通った'); }, (x: unknown) => x as Error);
    expect(e.message).toContain('https://black-hole.invalid');
    expect(e.message).toContain('20 ミリ秒');
    expect(e.message).toContain('/health');
    // 秘密は載せない。
    expect(e.message).not.toContain('SECRET-abcdef');
  });

  it('宛先に繋がらないときも 1 行で断る', async () => {
    const f = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as typeof fetch;
    await expect(joinWorker('https://nope.invalid', 's', device, { fetch: f, sleep: async () => {} })).rejects.toThrow(/ENOTFOUND/);
  });

  it('締め切りは 1 回ごとで、反映待ちの試し直しを削らない', async () => {
    // 締め切りを 20 ミリ秒まで詰めても、応答が返る限り 503 と 403 の試し直しは 6 回ぶん残る。
    const codes = [503, 503, 403, 403, 503, 403, 201];
    let i = 0;
    const f = (async (_u: unknown, init?: RequestInit) => {
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      const code = codes[i++]!;
      return code === 201 ? new Response(JSON.stringify({ deviceToken: 't', deviceId: device.id }), { status: 201 }) : new Response(JSON.stringify({ error: 'x' }), { status: code });
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    const r = await joinWorker('https://h', 's', device, { fetch: f, sleep: async (ms) => { slept.push(ms); }, retryForbidden: true, timeoutMs: 20 });
    expect(r.deviceToken).toBe('t');
    // setup の反映待ちは 5 秒おきに 6 回のままである。
    expect(slept).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
  });
});

// ---- Task 12: hangar join、hangar cloud status、hangar cloud teardown ----

const conf = (over: Partial<CloudConfig> = {}): CloudConfig => ({
  url: 'https://h',
  joinSecret: 'join-secret-0000',
  deviceToken: 'dt',
  workerName: null,
  accountId: null,
  dbName: null,
  bucketName: null,
  joinedAt: 1,
  ...over,
});

/** 確認の記録を取る偽物。答えは呼ばれた順に返す。 */
function fakeConfirm(answers: boolean[]) {
  const asked: { question: string; word: string }[] = [];
  return {
    asked,
    fn: async (question: string, word: string): Promise<boolean> => {
      asked.push({ question, word });
      return answers.shift() ?? false;
    },
  };
}

describe('DB の控えが取れないとき', () => {
  /** 1 つ前の版の DB を置き、控えの置き場（backups/db）を通常のファイルにして作れなくする。 */
  const blockBackup = (home: string): string => {
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION - 1);
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(home, 'backups', 'db'), 'x');
    return file;
  };

  it('setup cloud は Cloudflare に何も作らず、cloud.json も書かずに止まる', async () => {
    const { home, cloudDir } = dirs();
    const file = blockBackup(home);
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    const ff = fakeFetch(0);
    const err = await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} }).then(() => null, (e: unknown) => e);
    // 元の文に、次にすることの 1 文が続く。
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('マイグレーションを当てずに止めました');
    expect((err as Error).message).toContain('Cloudflare にはまだ何も作っていません。直してから hangar setup cloud をもう一度実行してください。');
    expect((err as Error).message).not.toContain('\n');
    expect(w.calls).toEqual([]);
    expect(w.interactiveCalls).toEqual([]);
    expect(ff.urls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION - 1);
  });

  it('join は参加の要求を出さず、cloud.json も書かずに止まる', async () => {
    const { home } = dirs();
    const file = blockBackup(home);
    const urls: string[] = [];
    const f = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response('{}', { status: 500 }); }) as typeof fetch;
    const err = await runJoin({ home, token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 'sec' }), device, fetch: f, sleep: async () => {}, force: true, log: () => {} }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('マイグレーションを当てずに止めました');
    expect((err as Error).message).toContain('参加の要求はまだ出していません。直してから hangar join をもう一度実行してください。');
    expect((err as Error).message).not.toContain('\n');
    expect(urls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION - 1);
  });

  it('控えが取れれば、setup cloud は先に DB を上げて控え、最後に床を刻む', async () => {
    const { home, cloudDir } = dirs();
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION - 1);
    // 最初の wrangler 呼び（whoami）の時点の DB の版と控えの数。Cloudflare に触る前に済んでいるかを見る。
    let versionAtWhoami = -1;
    let backupsAtWhoami = -1;
    const w = fakeWrangler({
      whoami: () => {
        versionAtWhoami = dbVersionOf(file);
        const dir = path.join(home, 'backups', 'db');
        backupsAtWhoami = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
        return ok(WHOAMI);
      },
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('Deployed hangar\n  https://hangar.example.workers.dev'),
      'secret put JOIN_SECRET_HASH': () => ok('Success'),
    });
    await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch(0).fetch, sleep: async () => {}, cloudDir, log: () => {} });
    expect(versionAtWhoami).toBe(LATEST_DB_VERSION);
    expect(backupsAtWhoami).toBe(1);
    expect(fs.readdirSync(path.join(home, 'backups', 'db'))).toHaveLength(1);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION);
    expect(readTranscriptsFrom(home)).toBe(loadCloudConfig(home)!.joinedAt);
  });
});

describe('runJoin', () => {
  it('宛先を見せて確認してから参加し、cloud.json を書く', async () => {
    const { home } = dirs();
    const token = encodeJoinToken({ url: 'https://h.workers.dev/', secret: 'sec' });
    let bodySeen: unknown = null;
    let authSeen: string | null = 'なし';
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://h.workers.dev/join');
      bodySeen = JSON.parse(init!.body as string);
      authSeen = (init!.headers as Record<string, string>).authorization ?? null;
      return new Response(JSON.stringify({ deviceToken: 'dt', deviceId: device.id }), { status: 201 });
    }) as typeof fetch;
    const c = fakeConfirm([true]);
    const lines: string[] = [];
    const got = await runJoin({ home, token, device, fetch: f, sleep: async () => {}, confirm: c.fn, log: (l) => lines.push(l) });

    expect(bodySeen).toEqual({ secret: 'sec', device });
    // 参加の前は端末トークンをまだ持っていない。Authorization は付けない。
    expect(authSeen).toBeNull();
    expect(got).toMatchObject({ url: 'https://h.workers.dev', joinSecret: 'sec', deviceToken: 'dt', workerName: null, accountId: null, dbName: null, bucketName: null });
    expect(loadCloudConfig(home)).toEqual(got);
    expectMode(path.join(home, 'cloud.json'), 0o600);

    // 「どこに繋ごうとしているか」を人に見せてから聞く。
    const out = lines.join('\n');
    expect(out).toContain('h.workers.dev');
    expect(out).toContain('全セッション');
    expect(c.asked).toHaveLength(1);
    expect(c.asked[0]!.question).toContain('参加');
  });

  it('宛先の確認を断れば、参加もせず cloud.json も書かない', async () => {
    const { home } = dirs();
    let called = 0;
    const f = (async () => { called++; return new Response('', { status: 201 }); }) as typeof fetch;
    const c = fakeConfirm([false]);
    await expect(
      runJoin({ home, token: encodeJoinToken({ url: 'https://h', secret: 'sec' }), device, fetch: f, sleep: async () => {}, confirm: c.fn, log: () => {} }),
    ).rejects.toThrow(/取りやめ/);
    expect(called).toBe(0);
    expect(loadCloudConfig(home)).toBeNull();
  });

  it('秘密が違えば、待たずにわかる文言で失敗する', async () => {
    const { home } = dirs();
    const f = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
    const slept: number[] = [];
    await expect(
      runJoin({ home, token: encodeJoinToken({ url: 'https://h', secret: 'x' }), device, fetch: f, sleep: async (ms) => { slept.push(ms); }, confirm: async () => true, log: () => {} }),
    ).rejects.toThrow('参加用の秘密が違います');
    // 貼り間違えたトークンで 30 秒待たせない。
    expect(slept).toHaveLength(0);
    expect(loadCloudConfig(home)).toBeNull();
  });

  it('別のクラウドへの参加し直しは、復号できなくなることを伝えて合言葉で確認する', async () => {
    const { home } = dirs();
    const before = conf({ url: 'https://old.workers.dev', joinSecret: 'old-secret' });
    saveCloudConfig(home, before);
    let called = 0;
    const f = (async () => { called++; return new Response('', { status: 201 }); }) as typeof fetch;
    const c = fakeConfirm([true, false]);
    const lines: string[] = [];
    await expect(
      runJoin({ home, token: encodeJoinToken({ url: 'https://new.workers.dev', secret: 'sec' }), device, fetch: f, sleep: async () => {}, confirm: c.fn, log: (l) => lines.push(l) }),
    ).rejects.toThrow(/取りやめ/);
    expect(c.asked).toHaveLength(2);
    expect(c.asked[1]!.word).toBe(OVERWRITE_WORD);
    const out = lines.join('\n');
    expect(out).toContain('復号できなくなります');
    expect(out).toContain('https://old.workers.dev');
    expect(out).toContain('https://new.workers.dev');
    // 断った後は 1 バイトも変えない。
    expect(called).toBe(0);
    expect(loadCloudConfig(home)).toEqual(before);
  });

  it('宛先が同じでも参加用の秘密が違えば、合言葉で確認する', async () => {
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h.workers.dev', joinSecret: 'old-secret' }));
    const f = (async () => new Response(JSON.stringify({ deviceToken: 'dt2', deviceId: device.id }), { status: 201 })) as typeof fetch;
    const c = fakeConfirm([true, true]);
    const lines: string[] = [];
    await runJoin({ home, token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 'new-secret' }), device, fetch: f, sleep: async () => {}, confirm: c.fn, log: (l) => lines.push(l) });
    expect(c.asked.map((a) => a.word)).toEqual(['y', OVERWRITE_WORD]);
    expect(lines.join('\n')).toContain('参加用の秘密が違います');
    expect(loadCloudConfig(home)!.joinSecret).toBe('new-secret');
  });

  it('cloud.json が壊れていたら、参加し直さずに止める', async () => {
    const { home } = dirs();
    const file = path.join(home, 'cloud.json');
    fs.writeFileSync(file, '{ こわれている');
    let called = 0;
    const f = (async () => { called++; return new Response('', { status: 201 }); }) as typeof fetch;
    await expect(
      runJoin({ home, token: encodeJoinToken({ url: 'https://h', secret: 'sec' }), device, fetch: f, sleep: async () => {}, confirm: async () => true, log: () => {} }),
    ).rejects.toThrow(/cloud\.json/);
    expect(called).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ こわれている');
  });

  it('参加した時点で、本文を上げ始める床を刻む', async () => {
    const { home } = dirs();
    const f = (async () => new Response(JSON.stringify({ deviceToken: 'dt', deviceId: device.id }), { status: 201 })) as typeof fetch;
    const got = await runJoin({
      home,
      token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 'sec' }),
      device,
      fetch: f,
      sleep: async () => {},
      force: true,
      confirm: async () => true,
      log: () => {},
    });
    expect(got.joinedAt).toBeGreaterThan(0);
    expect(readTranscriptsFrom(home)).toBe(got.joinedAt);
  });

  it('--force は確認を省く', async () => {
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://old.workers.dev' }));
    const f = (async () => new Response(JSON.stringify({ deviceToken: 'dt2', deviceId: device.id }), { status: 201 })) as typeof fetch;
    const got = await runJoin({
      home,
      token: encodeJoinToken({ url: 'https://new.workers.dev', secret: 'sec' }),
      device,
      fetch: f,
      sleep: async () => {},
      force: true,
      confirm: async () => { throw new Error('確認を聞いてはいけない'); },
      log: () => {},
    });
    expect(got.url).toBe('https://new.workers.dev');
    expect(loadCloudConfig(home)!.deviceToken).toBe('dt2');
  });
});

describe('cloudStatus', () => {
  it('未設定、Worker の応答、サーバの状態を並べる', async () => {
    const { home } = dirs();
    const dead = (async () => new Response('', { status: 500 })) as typeof fetch;
    expect(await cloudStatus({ home, fetch: dead })).toContain('未設定');

    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't', workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files' }));
    fs.writeFileSync(path.join(home, 'token'), 'local-token');
    let authOk = false;
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u === 'https://h/health') return new Response(JSON.stringify({ ok: true, version: '0.4.0' }), { status: 200 });
      if (u.endsWith('/api/sync/status')) {
        authOk = (init!.headers as Record<string, string>).authorization === 'Bearer local-token';
        return new Response(
          JSON.stringify({ state: 'idle', pending: 2, lastPullAt: 1000, lastPushAt: 1000, deviceCount: 2, url: 'https://h', error: null, claudeConfig: { enabled: false, confirmed: false } }),
          { status: 200 },
        );
      }
      throw new Error('down');
    }) as typeof fetch;
    const out = await cloudStatus({ home, fetch: f, now: () => 61_000 });
    expect(authOk).toBe(true);
    expect(out).toContain('Worker: https://h（ok, 0.4.0）');
    expect(out).toContain('同期: idle');
    expect(out).toContain('未送信 2 件');
    expect(out).toContain('端末 2 台');
    expect(out).toContain('1 分前');
    // アカウント ID は画面に出さない。どこにあるかだけ伝える。
    expect(out).not.toContain('a'.repeat(32));
    expect(out).toContain('cloud.json');

    // 上限で退いている間は、戻る時刻を添える。
    const limited = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u === 'https://h/health') return new Response(JSON.stringify({ ok: true, version: '0.4.0' }), { status: 200 });
      return new Response(JSON.stringify({ state: 'paused', pending: 0, lastPullAt: 1000, lastPushAt: 1000, deviceCount: 2, url: 'https://h', error: null, limitedUntil: Date.UTC(2026, 9, 9) }), { status: 200 });
    }) as typeof fetch;
    expect(await cloudStatus({ home, fetch: limited, now: () => 61_000 })).toContain('無料枠の上限で 2026-10-09T00:00:00.000Z まで止めています');

    const down = await cloudStatus({
      home,
      fetch: (async (input: string | URL | Request) => {
        if (String(input) === 'https://h/health') return new Response('{"ok":true,"version":"x"}', { status: 200 });
        throw new TypeError('ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(down).toContain('サーバは停止中');
  });

  it('本文をいつから上げるかを 1 行で見せる', async () => {
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't' }));
    const dead = (async () => { throw new TypeError('ECONNREFUSED'); }) as typeof fetch;

    // 床があるときは、その時刻より後に動いた本文だけを上げると伝える。
    stampTranscriptsFrom(home, Date.parse('2026-09-19T12:00:00.000Z'));
    const out = await cloudStatus({ home, fetch: dead });
    expect(out).toContain('本文: 2026-09-19T12:00:00.000Z 以降に動いた分を上げます');

    // backfill で床を落とした後は、全部上げると伝える。
    backfillTranscripts(home);
    expect(await cloudStatus({ home, fetch: dead })).toContain('本文: 手元の本文を全部上げます');
  });

  it('壊れている cloud.json を「未設定」と言わない', async () => {
    const { home } = dirs();
    fs.writeFileSync(path.join(home, 'cloud.json'), '{ こわれている');
    const out = await cloudStatus({ home, fetch: (async () => { throw new Error('呼んではいけない'); }) as typeof fetch });
    expect(out).not.toContain('未設定');
    expect(out).toContain('cloud.json');
    expect(out).toContain('復号できなくなります');
  });
});

const MTIME = 1_700_000_000_000;

/** R2 に置かれている本文 1 件分（一覧の項目と、暗号化して gzip した実体）。 */
async function fileFixture(o: { secret: string; deviceId: string; uuid: string; text: string; seq: number; encrypted?: boolean }): Promise<{ entry: FileEntry; body: Buffer }> {
  const plain = Buffer.from(o.text, 'utf8');
  const encrypted = o.encrypted ?? true;
  // 秘密を持たない相手は暗号化できない。平文の gzip をそのまま置く形も作れるようにしておく。
  const body = encrypted ? await encryptBuffer(deriveFileKey(o.secret), gzipSync(plain)) : gzipSync(plain);
  return {
    entry: {
      key: `transcripts/${o.deviceId}/${o.uuid}.jsonl.gz`,
      path: `projects/-w-p/${o.uuid}.jsonl`,
      kind: 'transcript',
      sha256: createHash('sha256').update(plain).digest('hex'),
      size: plain.length,
      mtime: MTIME,
      encrypted,
      seq: o.seq,
      deviceId: o.deviceId,
      uploadedAt: 1,
      storedSize: body.length,
    },
    body,
  };
}

/** Worker の代わり。端末トークンが合っているときだけ答える。 */
function cloudFetch(files: { entry: FileEntry; body: Buffer }[], o: { token: string; missing?: string[] }) {
  const paths: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (auth !== `Bearer ${o.token}`) return new Response('unauthorized', { status: 401 });
    paths.push(u.pathname);
    if (u.pathname === '/files') {
      const last = files.length ? files[files.length - 1]!.entry.seq : 0;
      return new Response(JSON.stringify({ files: files.map((x) => x.entry), nextSeq: last, more: false }), { status: 200, headers: { [COMPAT_HEADER]: String(COMPAT_VERSION) } });
    }
    const key = u.pathname.replace(/^\/files\//, '');
    const hit = files.find((x) => x.entry.key === key);
    if (!hit || o.missing?.includes(key)) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(hit.body), { status: 200, headers: { [COMPAT_HEADER]: String(COMPAT_VERSION) } });
  }) as typeof fetch;
  return { fetch: f, paths };
}

describe('runTeardown', () => {
  it('R2 にしか無い本文を降ろし、2 段の確認の後に、ファイル、バケット、Worker、D1 を消す', async () => {
    const { home, cloudDir } = dirs();
    const secret = 'join-secret-0000';
    const claudeDir = path.join(home, 'claude');
    fs.mkdirSync(path.join(home, 'cloud'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), '{}');
    saveCloudConfig(home, conf({ joinSecret: secret, deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
    // 自分が上げた本文は、原本が手元にある。降ろし直さない。
    const mine = await fileFixture({ secret, deviceId: 'dev-a', uuid: 'u-mine', text: '{"mine":1}\n', seq: 1 });
    fs.mkdirSync(path.join(claudeDir, 'projects', '-w-p'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, mine.entry.path), '{"mine":1}\n');
    // 他端末の本文は、手元に写しが無ければ降ろす。
    const theirs = await fileFixture({ secret, deviceId: 'dev-b', uuid: 'u-theirs', text: '{"theirs":1}\n', seq: 2 });
    const cf = cloudFetch([mine, theirs], { token: 'dt' });
    const w = fakeWrangler({ 'r2 object delete': () => ok(), 'r2 bucket delete': () => ok(), 'delete --name': () => ok(), 'd1 delete': () => ok() });
    const c = fakeConfirm([true, true]);
    const lines: string[] = [];

    const done = await runTeardown({
      home,
      deviceId: 'dev-a',
      claudeDir,
      wrangler: w.runner('a'.repeat(32), cloudDir),
      fetch: cf.fetch,
      confirm: c.fn,
      log: (l) => lines.push(l),
    });
    expect(done).toBe(true);

    // 降ろしたのは他端末の 1 件だけである。
    const saved = path.join(home, 'remote', 'dev-b', 'projects', '-w-p', 'u-theirs.jsonl');
    expect(fs.readFileSync(saved, 'utf8')).toBe('{"theirs":1}\n');
    expect(fs.existsSync(path.join(home, 'remote', 'dev-a'))).toBe(false);
    expect(cf.paths).toContain('/files/transcripts/dev-b/u-theirs.jsonl.gz');
    expect(cf.paths).not.toContain('/files/transcripts/dev-a/u-mine.jsonl.gz');

    // 確認は 2 段で、1 段目は Worker の名前、2 段目は delete。
    expect(c.asked.map((a) => a.word)).toEqual(['hangar-dev', 'delete']);

    const cfg = path.join(home, 'cloud', 'wrangler.jsonc');
    expect(w.calls.map((x) => x.args.join(' '))).toEqual([
      `r2 object delete hangar-dev-files/transcripts/dev-a/u-mine.jsonl.gz --remote --config ${cfg}`,
      `r2 object delete hangar-dev-files/transcripts/dev-b/u-theirs.jsonl.gz --remote --config ${cfg}`,
      `r2 bucket delete hangar-dev-files --config ${cfg}`,
      `delete --name hangar-dev --config ${cfg}`,
      `d1 delete hangar-dev -y --config ${cfg}`,
    ]);
    expect(w.calls[3]!.input).toBe('y\n');
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
    expect(fs.existsSync(cfg)).toBe(false);
    const out = lines.join('\n');
    expect(out).toContain('1 件を手元へ降ろしました');
    expect(out).toContain('他の端末の cloud.json は手で消してください');
  });

  it('確認に失敗したら何もしない', async () => {
    const { home, cloudDir } = dirs();
    const before = conf({ deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' });
    saveCloudConfig(home, before);
    const w = fakeWrangler({});
    const c = fakeConfirm([false]);
    const done = await runTeardown({ home, deviceId: 'dev-a', wrangler: w.runner('a'.repeat(32), cloudDir), fetch: cloudFetch([], { token: 'dt' }).fetch, confirm: c.fn, log: () => {} });
    expect(done).toBe(false);
    expect(w.calls).toEqual([]);
    expect(loadCloudConfig(home)).toEqual(before);
  });

  it('降ろせない本文があれば、確認も聞かずに消すのをやめる', async () => {
    const { home, cloudDir } = dirs();
    const secret = 'join-secret-0000';
    saveCloudConfig(home, conf({ joinSecret: secret, deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
    const theirs = await fileFixture({ secret, deviceId: 'dev-b', uuid: 'u-theirs', text: '{"theirs":1}\n', seq: 1 });
    const cf = cloudFetch([theirs], { token: 'dt', missing: [theirs.entry.key] });
    const w = fakeWrangler({});
    const c = fakeConfirm([true, true]);
    await expect(
      runTeardown({ home, deviceId: 'dev-a', wrangler: w.runner('a'.repeat(32), cloudDir), fetch: cf.fetch, confirm: c.fn, log: () => {} }),
    ).rejects.toThrow(/降ろせ/);
    expect(c.asked).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(loadCloudConfig(home)).not.toBeNull();
  });

  it('暗号化されていない本文は受け取らず、消すのもやめる', async () => {
    const { home, cloudDir } = dirs();
    const secret = 'join-secret-0000';
    saveCloudConfig(home, conf({ joinSecret: secret, deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
    // Worker が握っているのは秘密の SHA-256 だけなので、正しく暗号化した本文は作れない。
    // 平文を通す道が残っていると、Worker の側から remote の下に中身を仕込める。
    const planted = await fileFixture({ secret, deviceId: 'dev-b', uuid: 'u-planted', text: '{"planted":"by the worker"}\n', seq: 1, encrypted: false });
    const cf = cloudFetch([planted], { token: 'dt' });
    const w = fakeWrangler({});
    const c = fakeConfirm([true, true]);
    await expect(
      runTeardown({ home, deviceId: 'dev-a', wrangler: w.runner('a'.repeat(32), cloudDir), fetch: cf.fetch, confirm: c.fn, log: () => {} }),
    ).rejects.toThrow(/降ろせ/);
    expect(fs.existsSync(path.join(home, 'remote', 'dev-b', 'projects', '-w-p', 'u-planted.jsonl'))).toBe(false);
    expect(c.asked).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it('R2 を空にできなければ Worker も D1 も消さず、手元の設定を残す', async () => {
    const { home, cloudDir } = dirs();
    fs.mkdirSync(path.join(home, 'cloud'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), '{}');
    const before = conf({ deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' });
    saveCloudConfig(home, before);
    // 索引に無い孤児が 1 つでもあれば、バケットは「空でない」で消せない（Task 5 の申し送り）。
    const w = fakeWrangler({ 'r2 bucket delete': () => ({ code: 1, stdout: '', stderr: 'The bucket you tried to delete is not empty' }) });
    const c = fakeConfirm([true, true]);
    const lines: string[] = [];
    const done = await runTeardown({
      home,
      deviceId: 'dev-a',
      wrangler: w.runner('a'.repeat(32), cloudDir),
      fetch: cloudFetch([], { token: 'dt' }).fetch,
      confirm: c.fn,
      log: (l) => lines.push(l),
    });
    expect(done).toBe(false);
    // Worker は R2 の中身へ手が届く唯一の入口である。オブジェクトが残っているうちは消さない。
    expect(w.calls.map((x) => x.args[0])).toEqual(['r2']);
    // 在り処（Worker 名、アカウント、参加用の秘密）を消さない。消すとやり直せなくなる。
    expect(loadCloudConfig(home)).toEqual(before);
    expect(fs.existsSync(path.join(home, 'cloud', 'wrangler.jsonc'))).toBe(true);
    const out = lines.join('\n');
    expect(out).toContain('残ったもの');
    expect(out).toContain('hangar cloud teardown');

    // 直してからもう一度走らせれば、続きから消せる。
    const w2 = fakeWrangler({ 'r2 bucket delete': () => ok(), 'delete --name': () => ok(), 'd1 delete': () => ok() });
    const again = await runTeardown({
      home,
      deviceId: 'dev-a',
      wrangler: w2.runner('a'.repeat(32), cloudDir),
      fetch: cloudFetch([], { token: 'dt' }).fetch,
      confirm: fakeConfirm([true, true]).fn,
      log: () => {},
    });
    expect(again).toBe(true);
    expect(w2.calls.map((x) => x.args.slice(0, 2).join(' '))).toEqual(['r2 bucket', 'delete --name', 'd1 delete']);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
  });

  it('Worker の削除に失敗したら、手元の設定を残して 消えたものと残ったものを並べる', async () => {
    const { home, cloudDir } = dirs();
    fs.mkdirSync(path.join(home, 'cloud'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), '{}');
    const before = conf({ deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' });
    saveCloudConfig(home, before);
    const w = fakeWrangler({
      'r2 bucket delete': () => ok(),
      'delete --name': () => ({ code: 1, stdout: '', stderr: 'Authentication error [code: 10000]' }),
      'd1 delete': () => ok(),
    });
    const lines: string[] = [];
    const done = await runTeardown({
      home,
      deviceId: 'dev-a',
      wrangler: w.runner('a'.repeat(32), cloudDir),
      fetch: cloudFetch([], { token: 'dt' }).fetch,
      confirm: fakeConfirm([true, true]).fn,
      log: (l) => lines.push(l),
    });
    expect(done).toBe(false);
    expect(loadCloudConfig(home)).toEqual(before);
    expect(fs.existsSync(path.join(home, 'cloud', 'wrangler.jsonc'))).toBe(true);
    const out = lines.join('\n');
    expect(out).toContain('消えたもの');
    expect(out).toContain(`R2 bucket ${before.bucketName}`);
    expect(out).toContain(`D1 ${before.dbName}`);
    expect(out).toContain('残ったもの');
    expect(out).toContain(`Worker ${before.workerName}`);
  });

  it('鍵と相対パスが食い違う本文は、手元に置く先を決めない', () => {
    const { home } = dirs();
    const base: FileEntry = { key: '', path: '', kind: 'transcript', sha256: 'x', size: 1, mtime: MTIME, encrypted: true, seq: 1, deviceId: 'dev-b', uploadedAt: 1, storedSize: 1 };
    // 正しく暗号化された別のファイルへの差し替えを、復号と SHA-256 だけでは見抜けない。
    expect(() => rescueTargetPath(home, { ...base, key: 'transcripts/dev-b/other.jsonl.gz', path: 'projects/-w-p/u.jsonl' })).toThrow(/食い違/);
    expect(() => rescueTargetPath(home, { ...base, key: 'transcripts/dev-b/u.jsonl.gz', path: '../../.claude/u.jsonl' })).toThrow(/食い違/);
    expect(() => rescueTargetPath(home, { ...base, kind: 'config', key: 'config/dev-b/CLAUDE.md', path: '../CLAUDE.md' })).toThrow(/食い違/);
    // 正しい組み合わせは remote の下に収まる。
    expect(rescueTargetPath(home, { ...base, key: 'transcripts/dev-b/u.jsonl.gz', path: 'projects/-w-p/u.jsonl' })).toBe(path.join(home, 'remote', 'dev-b', 'projects', '-w-p', 'u.jsonl'));
    expect(rescueTargetPath(home, { ...base, kind: 'config', key: 'config/dev-b/CLAUDE.md', path: 'CLAUDE.md' }).startsWith(path.join(home, 'remote'))).toBe(true);
  });

  it('参加だけの端末では実行できない', async () => {
    const { home } = dirs();
    saveCloudConfig(home, conf({ deviceToken: 'dt' }));
    await expect(
      runTeardown({ home, fetch: (async () => new Response('{}')) as typeof fetch, confirm: async () => true, log: () => {} }),
    ).rejects.toThrow('setup cloud を実行した端末');
  });

  it('cloud.json が壊れていたら、未設定とみなさずに止める', async () => {
    const { home, cloudDir } = dirs();
    fs.writeFileSync(path.join(home, 'cloud.json'), '{ こわれている');
    const w = fakeWrangler({});
    await expect(
      runTeardown({ home, wrangler: w.runner('a'.repeat(32), cloudDir), fetch: (async () => new Response('{}')) as typeof fetch, confirm: async () => true, log: () => {} }),
    ).rejects.toThrow(/cloud\.json/);
    expect(w.calls).toEqual([]);
  });
});

// ---- 実物の片付けで見つかった 4 件 ----

/** process.stdin を差し替えて呼ぶ。終わったら必ず戻す。 */
async function withStdin<T>(stream: Readable, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', original);
  }
}

describe('promptWord', () => {
  it('標準入力が空（EOF）なら、断った扱いで返る', async () => {
    // /dev/null を渡された場面である。
    // question の callback は EOF では呼ばれないので、close を拾わないと約束が解けないまま node が落ちる。
    // 落ちると 中止しました も出ず、終了コードが 0 になって「消えた」と取り違えられる。
    const empty = Readable.from([]);
    const answered = await withStdin(empty, () => promptWord('本当に消しますか。', 'delete'));
    expect(answered).toBe(false);
  }, 3000);

  it('聞いているあいだだけ標準入力を掴み、答えた後は手放す', async () => {
    // 掴んだままだと、最後の行まで印字してもプロセスが終わらない（実物の片付けで踏んだ）。
    // pause だけでは足りず、unref まで要ることは実測で確かめてある。
    const calls: string[] = [];
    const io = Object.assign(new PassThrough(), {
      ref: () => { calls.push('ref'); },
      unref: () => { calls.push('unref'); },
    });
    const answered = await withStdin(io, async () => {
      const p = promptWord('本当に消しますか。', 'delete');
      io.write('delete\n');
      return p;
    });
    expect(answered).toBe(true);
    expect(calls).toEqual(['ref', 'unref']);
    expect(io.isPaused()).toBe(true);
    io.destroy();
  }, 3000);

  it('合言葉が違えば false を返す', async () => {
    const io = new PassThrough();
    const answered = await withStdin(io, async () => {
      const p = promptWord('本当に消しますか。', 'delete');
      io.write('  delete-not  \n');
      return p;
    });
    expect(answered).toBe(false);
    io.destroy();
  }, 3000);
});

describe('失敗の理由の見せ方', () => {
  it('wrangler の理由の行まで出し、長い 16 進は伏せる', async () => {
    const { home, cloudDir } = dirs();
    fs.mkdirSync(path.join(home, 'cloud'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), '{}');
    const account = 'a'.repeat(32);
    saveCloudConfig(home, conf({ deviceToken: 'dt', workerName: 'hangar-dev', accountId: account, dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
    // 実物の wrangler は、見出しの行の 2 行あとに本当の理由を出す。
    const stderr = [
      `\u001b[31m✘ [ERROR]\u001b[0m A request to the Cloudflare API (/accounts/${account}/r2/buckets/hangar-dev-files) failed.`,
      '',
      `  The bucket you tried to delete (hangar-dev-files) is not empty (account ${account}). [code: 10008]`,
    ].join('\n');
    const w = fakeWrangler({ 'r2 bucket delete': () => ({ code: 1, stdout: '', stderr }) });
    const lines: string[] = [];
    const done = await runTeardown({
      home,
      deviceId: 'dev-a',
      wrangler: w.runner(account, cloudDir),
      fetch: cloudFetch([], { token: 'dt' }).fetch,
      confirm: fakeConfirm([true, true]).fn,
      log: (l) => lines.push(l),
    });
    expect(done).toBe(false);
    const out = lines.join('\n');
    expect(out).toContain('[code: 10008]');
    expect(out).toContain('is not empty');
    // アカウント ID は伏せる。色の指定も残さない。
    expect(out).not.toContain(account);
    expect(out).not.toContain('\u001b[');
  });
});

describe('設定の退避先', () => {
  it('端末ごとに分ける。2 台の同じ名前の設定が重ならない', () => {
    const { home } = dirs();
    const base: FileEntry = { key: '', path: '', kind: 'config', sha256: 'x', size: 1, mtime: MTIME, encrypted: true, seq: 1, deviceId: 'dev-b', uploadedAt: 1, storedSize: 1 };
    const b = rescueTargetPath(home, { ...base, deviceId: 'dev-b', key: 'config/dev-b/CLAUDE.md', path: 'CLAUDE.md' });
    const c2 = rescueTargetPath(home, { ...base, deviceId: 'dev-c', key: 'config/dev-c/CLAUDE.md', path: 'CLAUDE.md' });
    expect(b).not.toBe(c2);
    expect(b).toContain(path.join('remote', 'dev-b'));
    expect(c2).toContain(path.join('remote', 'dev-c'));
    expect(b.startsWith(path.join(home, 'remote') + path.sep)).toBe(true);
    // 端末 ID の入れ物は本文と同じで、その下に設定を置く。
    expect(b).toBe(path.join(home, 'remote', 'dev-b', '_config', 'CLAUDE.md'));
  });
});

describe('Worker のソースの置き場', () => {
  const saved = process.env.HANGAR_CLOUD_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.HANGAR_CLOUD_DIR;
    else process.env.HANGAR_CLOUD_DIR = saved;
  });

  it('HANGAR_CLOUD_DIR があればそこを使う。配布版は単一ファイルなので相対では探せない', () => {
    const { cloudDir } = dirs();
    process.env.HANGAR_CLOUD_DIR = cloudDir;
    expect(defaultCloudDir()).toBe(cloudDir);
  });

  it('環境変数が無ければリポジトリ内の packages/cloud を指す', () => {
    delete process.env.HANGAR_CLOUD_DIR;
    expect(defaultCloudDir().endsWith(path.join('packages', 'cloud'))).toBe(true);
    expect(fs.existsSync(path.join(defaultCloudDir(), 'src', 'index.ts'))).toBe(true);
    expect(requireCloudDir()).toBe(defaultCloudDir());
  });

  it('ソースが無ければ、どこを見たかと何をすればよいかを述べて止まる', () => {
    const { cloudDir } = dirs();
    process.env.HANGAR_CLOUD_DIR = cloudDir;
    expect(() => requireCloudDir()).toThrow(/HANGAR_CLOUD_DIR/);
    expect(() => requireCloudDir()).toThrow(/src\/index\.ts/);
    expect(() => requireCloudDir()).toThrow(/clone して npm install/);
  });

  /**
   * packages/cloud の見た目をした一式を作る。
   * 依存は親の node_modules に置くので、createRequire の解決が親をたどる様子をそのまま再現できる。
   * bundled を立てると、配布版に同梱する形（Worker の束と束縛の定義だけで、源が無い）にする。
   */
  function fakeCloudTree(o: { deps: string[]; bundled?: boolean; name?: string }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cloudtree-'));
    temps.push(root);
    for (const d of o.deps) {
      const dir = path.join(root, 'node_modules', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: d, version: '0.0.0', main: 'index.js' }));
      fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
    }
    // .app の置き場に相当する一段下に、cloud/ を作る。
    const dir = path.join(root, 'app', 'cloud');
    fs.mkdirSync(dir, { recursive: true });
    if (o.bundled) {
      fs.writeFileSync(path.join(dir, 'worker.mjs'), 'export default {};\n');
      fs.writeFileSync(path.join(dir, 'metadata.json'), '{}\n');
      return dir;
    }
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), '{}\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: o.name ?? '@agent-hangar/cloud', version: '0.0.0' }));
    return dir;
  }

  const ALL_DEPS = ['wrangler', 'hono', '@agent-hangar/shared'];

  it('wrangler が無ければ、どこから実行すればよいかを述べて止まる', () => {
    process.env.HANGAR_CLOUD_DIR = fakeCloudTree({ deps: ['hono', '@agent-hangar/shared'] });
    expect(() => requireCloudDir()).toThrow(/wrangler が/);
    expect(() => requireCloudDir()).toThrow(/clone して npm install/);
  });

  it('wrangler があっても hono が無ければ止まる。deploy の途中で分かりにくく落ちるより先に断る', () => {
    process.env.HANGAR_CLOUD_DIR = fakeCloudTree({ deps: ['wrangler', '@agent-hangar/shared'] });
    expect(() => requireCloudDir()).toThrow(/hono が/);
  });

  it('配布版に同梱した cloud/（Worker の束だけ）を指されたら、親から wrangler を拾える置き場でも、clone を案内して止まる', () => {
    // レビューでの事故の再現。
    // .app を node_modules のあるディレクトリの下に置くと、親をたどった wrangler で依存の検査が素通りし、実物のアカウントに資源を作ってしまった。
    // 同梱の cloud/ は源を持たないので、依存を見る前に源の検査で止まる。
    process.env.HANGAR_CLOUD_DIR = fakeCloudTree({ deps: ALL_DEPS, bundled: true });
    expect(() => requireCloudDir()).toThrow(/src\/index\.ts/);
    expect(() => requireCloudDir()).toThrow(/clone して npm install/);
  });

  it('packages/cloud でないディレクトリなら、name を挙げて止まる', () => {
    process.env.HANGAR_CLOUD_DIR = fakeCloudTree({ deps: ALL_DEPS, name: '@agent-hangar/server' });
    expect(() => requireCloudDir()).toThrow(/packages\/cloud ではありません/);
  });
});

describe('cloudBackfill', () => {
  it('参加していない端末では何も書かない', () => {
    const { home } = dirs();
    expect(cloudBackfill({ home })).toContain('未設定');
    // 入れ物だけ作って終わらない。参加していない端末に索引の DB は要らない。
    expect(fs.existsSync(path.join(home, 'hangar.db'))).toBe(false);
  });

  it('床を落として、次の走査から参加より前の本文も上がると伝える', () => {
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't' }));
    const out = cloudBackfill({ home });
    expect(out).toContain('参加より前の本文');
    // 床は 0（床なし）になっている。もう一度落としても 0 のままである。
    expect(backfillTranscripts(home)).toEqual({ from: 0 });
  });
});

describe('installUsageToken', () => {
  const ACC = '0123456789abcdef0123456789abcdef';
  const okJson = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  const cfFetch = (o: { verify?: number; subs?: number; gql?: number; gqlBody?: unknown } = {}) => {
    const calls: string[] = [];
    const bodies: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (typeof init?.body === 'string') bodies.push(init.body);
      expect(url).not.toContain('tok-secret');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-secret');
      if (url.endsWith('/tokens/verify')) return o.verify ? new Response('{}', { status: o.verify }) : okJson({ success: true, result: { status: 'active' } });
      if (url.endsWith('/subscriptions')) return o.subs ? new Response('{}', { status: o.subs }) : okJson({ success: true, result: [] });
      if (url.endsWith('/graphql')) return o.gql ? new Response('{}', { status: o.gql }) : okJson(o.gqlBody ?? { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } }, errors: null });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    return { f, calls, bodies };
  };
  /** cloud.json を一時の home に書く。accountId が null なら参加しただけの端末。 */
  const setupHome = (over: Partial<CloudConfig>) => {
    const d = dirs();
    saveCloudConfig(d.home, conf(over));
    return d;
  };
  const SET = { accountId: ACC, workerName: 'hangar' };

  it('確かめてから、二つの secret を標準入力で入れる。argv にトークンを出さない', async () => {
    const { home, cloudDir } = setupHome(SET);
    const w = fakeWrangler({ 'secret put': () => ok('Success') });
    const lines: string[] = [];
    await installUsageToken({ home, token: 'tok-secret\n', fetch: cfFetch().f, wrangler: w.runner(null, cloudDir), log: (l) => lines.push(l) });
    expect(w.calls.map((c) => c.args.slice(0, 3))).toEqual([['secret', 'put', 'USAGE_API_TOKEN'], ['secret', 'put', 'CF_ACCOUNT_ID']]);
    expect(w.calls.map((c) => c.input)).toEqual(['tok-secret\n', `${ACC}\n`]);
    for (const c of w.calls) expect(c.args.join(' ')).not.toContain('tok-secret');
    expect(w.calls[0]!.args).toContain('--config');
    expect(lines.join('\n')).not.toContain('tok-secret');
  });
  it('verify が通らなければ入れない', async () => {
    const { home, cloudDir } = setupHome(SET);
    const w = fakeWrangler({ 'secret put': () => ok() });
    await expect(installUsageToken({ home, token: 'tok-secret', fetch: cfFetch({ verify: 401 }).f, wrangler: w.runner(null, cloudDir), log: () => {} })).rejects.toThrow('トークンが有効ではありません');
    expect(w.calls).toHaveLength(0);
  });
  it('権限が足りなければ、足りない権限の名前を言う', async () => {
    const { home, cloudDir } = setupHome(SET);
    const w = fakeWrangler({ 'secret put': () => ok() });
    await expect(installUsageToken({ home, token: 'tok-secret', fetch: cfFetch({ subs: 403 }).f, wrangler: w.runner(null, cloudDir), log: () => {} })).rejects.toThrow('Billing: Read');
    await expect(installUsageToken({ home, token: 'tok-secret', fetch: cfFetch({ gql: 403 }).f, wrangler: w.runner(null, cloudDir), log: () => {} })).rejects.toThrow('Account Analytics: Read');
    expect(w.calls).toHaveLength(0);
  });
  // GraphQL は権限の誤りを 200 と errors で返すことが多い。状態の番号だけでは通ってしまう。
  it('GraphQL が 200 でも errors か欠けた data なら、Account Analytics: Read が足りないと言う', async () => {
    const { home, cloudDir } = setupHome(SET);
    const w = fakeWrangler({ 'secret put': () => ok() });
    for (const gqlBody of [
      { data: null, errors: [{ message: 'not authorized' }] },
      { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: null }] } }, errors: [{ message: 'not authorized' }] },
      { data: { viewer: { accounts: [] } }, errors: null },
    ]) {
      await expect(installUsageToken({ home, token: 'tok-secret', fetch: cfFetch({ gqlBody }).f, wrangler: w.runner(null, cloudDir), log: () => {} })).rejects.toThrow('権限が足りません: Account Analytics: Read を付けてください');
    }
    expect(w.calls).toHaveLength(0);
  });
  it('GraphQL の確かめは、今日の D1 の書き込みをこのアカウントで引く', async () => {
    const { home, cloudDir } = setupHome(SET);
    const w = fakeWrangler({ 'secret put': () => ok() });
    const cf = cfFetch();
    await installUsageToken({ home, token: 'tok-secret', fetch: cf.f, wrangler: w.runner(null, cloudDir), log: () => {} });
    const gql = JSON.parse(cf.bodies.find((b) => b.includes('query'))!) as { query: string; variables: { a: string; d: string } };
    expect(gql.query).toContain('d1AnalyticsAdaptiveGroups(limit:1');
    expect(gql.query).toContain('rowsWritten');
    expect(gql.variables.a).toBe(ACC);
    expect(gql.variables.d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('参加しただけの端末では、setup した端末で入れるよう案内する', async () => {
    const { home, cloudDir } = setupHome({ accountId: null, workerName: null });
    const w = fakeWrangler({});
    await expect(installUsageToken({ home, token: 'tok-secret', fetch: cfFetch().f, wrangler: w.runner(null, cloudDir), log: () => {} })).rejects.toThrow('setup cloud を実行した PC');
    expect(w.calls).toHaveLength(0);
  });
  it('空のトークンは断る', async () => {
    const { home, cloudDir } = setupHome(SET);
    const w = fakeWrangler({});
    await expect(installUsageToken({ home, token: '  \n', fetch: cfFetch().f, wrangler: w.runner(null, cloudDir), log: () => {} })).rejects.toThrow('トークンが空です');
  });
  it('secret の登録に失敗したら、トークンを含まない理由で落ちる', async () => {
    const { home, cloudDir } = setupHome(SET);
    const w = fakeWrangler({ 'secret put': () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    const err = await installUsageToken({ home, token: 'tok-secret', fetch: cfFetch().f, wrangler: w.runner(null, cloudDir), log: () => {} }).catch((e: Error) => e);
    expect((err as Error).message).toContain('USAGE_API_TOKEN');
    expect((err as Error).message).not.toContain('tok-secret');
  });
  it('setup の続きで入れるのに失敗しても、setup は落とさず、入れ直し方を言う', async () => {
    const lines: string[] = [];
    await expect(offerUsageToken(async () => { throw new Error('権限が足りません: Billing: Read を付けてください'); }, (l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines).toEqual(['権限が足りません: Billing: Read を付けてください', 'あとから npm run hangar -- setup cloud --usage-token で入れ直せます']);
  });
  it('setup の続きで入れられたら、何も足さない', async () => {
    const lines: string[] = [];
    await offerUsageToken(async () => { lines.push('入れました'); }, (l) => lines.push(l));
    expect(lines).toEqual(['入れました']);
  });
  it('案内は権限を二つ挙げる', () => {
    expect(USAGE_TOKEN_HELP.join('\n')).toContain('Account Analytics: Read');
    expect(USAGE_TOKEN_HELP.join('\n')).toContain('Billing: Read');
  });
});

describe('runSetupCloud の使用量のトークンの問い', () => {
  const setIsTTY = (v: boolean | undefined) => Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
  const run = async (extra: { skipUsageToken?: boolean }) => {
    const { home, cloudDir } = dirs();
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put JOIN_SECRET_HASH': () => ok(),
    });
    const lines: string[] = [];
    await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch(0).fetch, sleep: async () => {}, cloudDir, log: (l) => lines.push(l), ...extra });
    return lines.join('\n');
  };
  afterEach(() => { Reflect.deleteProperty(process.stdin, 'isTTY'); vi.restoreAllMocks(); });

  it('端末でないときは尋ねない', async () => {
    setIsTTY(false);
    expect(await run({})).not.toContain('API トークン');
  });
  it('端末でも skipUsageToken なら尋ねない', async () => {
    setIsTTY(true);
    expect(await run({ skipUsageToken: true })).not.toContain('API トークン');
  });
});

describe('互換の版', () => {
  it('Worker へ出す要求（health の待ち、参加、status）に、この PC の版を載せる', async () => {
    const sent: { url: string; compat: string | undefined }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), compat: (init?.headers as Record<string, string> | undefined)?.[COMPAT_HEADER] });
      if (String(input).endsWith('/join')) return new Response(JSON.stringify({ deviceToken: 't', deviceId: device.id }), { status: 201 });
      return new Response(JSON.stringify({ ok: true, version: '0.4.0', compat: COMPAT_VERSION }), { status: 200 });
    }) as typeof fetch;
    expect(await waitForHealth('https://h', { fetch: f, sleep: async () => {} })).toBe(true);
    await joinWorker('https://h', 's', device, { fetch: f, sleep: async () => {} });
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't' }));
    await cloudStatus({ home, fetch: f });
    const toWorker = sent.filter((s) => s.url.startsWith('https://h/'));
    expect(toWorker.map((s) => s.url)).toEqual(['https://h/health', 'https://h/join', 'https://h/health']);
    for (const s of toWorker) expect(s.compat, s.url).toBe(String(COMPAT_VERSION));
  });

  it('参加を版が古いと断られたら、待たずに hangar を上げるよう伝える', async () => {
    const need = COMPAT_VERSION + 1;
    const f = (async () => new Response(JSON.stringify({ error: 'upgrade required', minCompat: need, compat: need }), { status: 426 })) as typeof fetch;
    const slept: number[] = [];
    const e: Error = await joinWorker('https://h', 's', device, { fetch: f, sleep: async (ms) => { slept.push(ms); }, retryForbidden: true }).then(
      () => { throw new Error('断られるはずが通った'); },
      (x: unknown) => x as Error,
    );
    expect(e.message).toContain('この PC の hangar が古い');
    expect(e.message).toContain(`${need} 以上`);
    expect(slept).toHaveLength(0);
  });

  it('426 の見出しだけ返して本文が閉じない相手でも、締め切りで打ち切って止まる', async () => {
    const f = (async () => new Response(new ReadableStream({ start() {} }), { status: 426 })) as typeof fetch;
    const slept: number[] = [];
    const e: Error = await joinWorker('https://h', 's', device, { fetch: f, sleep: async (ms) => { slept.push(ms); }, timeoutMs: 50, retryForbidden: true }).then(
      () => { throw new Error('断られるはずが通った'); },
      (x: unknown) => x as Error,
    );
    expect(e.message).toContain('この PC の hangar が古い');
    expect(e.message).toContain('それより新しい版');
    expect(slept).toHaveLength(0);
  }, 2000);

  it('status は、この PC と Worker の互換の版を 1 行で見せる', async () => {
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't' }));
    const health = (body: unknown) => (async (input: string | URL | Request) => {
      if (String(input) === 'https://h/health') return new Response(JSON.stringify(body), { status: 200 });
      throw new TypeError('ECONNREFUSED');
    }) as typeof fetch;
    expect(await cloudStatus({ home, fetch: health({ ok: true, version: '0.5.0', compat: COMPAT_VERSION }) })).toContain(`互換の版: この PC ${COMPAT_VERSION}、Worker ${COMPAT_VERSION}`);
    // 版を返さないのは、版番号を入れる前の古い Worker である。
    expect(await cloudStatus({ home, fetch: health({ ok: true, version: '0.4.0' }) })).toContain(`互換の版: この PC ${COMPAT_VERSION}、Worker 0`);
    const dead = (async () => { throw new TypeError('ECONNREFUSED'); }) as typeof fetch;
    expect(await cloudStatus({ home, fetch: dead })).toContain(`互換の版: この PC ${COMPAT_VERSION}、Worker 不明`);
  });
});

describe('setup cloud の書く wrangler の設定', () => {
  it('互換の日付と旗、D1 と R2 の束縛の名前が、同梱する束縛の定義（packages/cloud/wrangler.jsonc から作る）とそろっている', () => {
    // 片方だけ変えると、wrangler で上げた Worker と、段 5 で同梱の定義から上げる Worker が食い違う。
    const { home } = dirs();
    const file = writeWranglerConfig(home, { name: 'hangar', main: '/x/src/index.ts', dbName: 'hangar', dbId: DB_ID, bucketName: 'hangar-files' });
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')) as {
      compatibility_date: string;
      compatibility_flags: string[];
      d1_databases: { binding: string }[];
      r2_buckets: { binding: string }[];
    };
    const meta = workerMetadata(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cloud'));
    expect(cfg.compatibility_date).toBe(meta.compatibility_date);
    expect(cfg.compatibility_flags).toEqual(meta.compatibility_flags);
    expect(cfg.d1_databases.map((d) => d.binding)).toEqual(bindingNames(meta, 'd1'));
    expect(cfg.r2_buckets.map((b) => b.binding)).toEqual(bindingNames(meta, 'r2_bucket'));
  });
});
