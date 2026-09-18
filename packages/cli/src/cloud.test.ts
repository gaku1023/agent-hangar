import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCloudConfig } from '@agent-hangar/server';
import { decodeJoinToken } from '@agent-hangar/shared';
import { joinWorker, ROTATE_WORD, runSetupCloud, waitForHealth } from './cloud.ts';
import type { Exec, ExecResult, Interactive } from './wrangler.ts';
import { WranglerRunner } from './wrangler.ts';

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

describe('runSetupCloud', () => {
  it('資源を作り、設定を書き、デプロイし、health を待ち、参加して cloud.json とトークンを出す', async () => {
    const { home, cloudDir } = dirs();
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ({ code: 1, stdout: '', stderr: 'not found' }),
      'd1 create hangar': () => ok(`database_id = "${DB_ID}"`),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('Deployed hangar\n  https://hangar.gaku.workers.dev'),
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

    expect(r.url).toBe('https://hangar.gaku.workers.dev');
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
    expect(fs.statSync(path.join(home, 'cloud.json')).mode & 0o777).toBe(0o600);

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
      deploy: () => ok('https://hangar-dev.gaku.workers.dev'),
      'secret put JOIN_SECRET_HASH': () => ok(),
    });
    const ff = fakeFetch();
    const r = await runSetupCloud({ home, name: 'hangar-dev', device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} });
    expect(decodeJoinToken(r.joinToken).secret).toBe(keep);
    expect(w.calls.map((c) => c.args[0])).toEqual(['whoami', 'd1', 'r2', 'deploy', 'secret']);
    expect(loadCloudConfig(home)).toMatchObject({ workerName: 'hangar-dev', dbName: 'hangar-dev', bucketName: 'hangar-dev-files', url: 'https://hangar-dev.gaku.workers.dev' });
  });

  it('ログインしていなければ login を対話で実行してからもう一度読む', async () => {
    const { home, cloudDir } = dirs();
    let asked = 0;
    const w = fakeWrangler({
      whoami: () => (asked++ === 0 ? { code: 1, stdout: '', stderr: 'You are not authenticated' } : ok(WHOAMI)),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.gaku.workers.dev'),
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
      deploy: () => ok('https://hangar.gaku.workers.dev'),
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
});
