import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCloudConfig, saveCloudConfig, type CloudConfig } from '@agent-hangar/server';
import { deriveFileKey, encryptBuffer } from '@agent-hangar/server/src/sync/crypto.ts';
import { decodeJoinToken, encodeJoinToken, type FileEntry } from '@agent-hangar/shared';
import { cloudStatus, joinWorker, OVERWRITE_WORD, rescueTargetPath, ROTATE_WORD, runJoin, runSetupCloud, runTeardown, waitForHealth } from './cloud.ts';
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
    const e = await joinWorker('https://black-hole.invalid', 'SECRET-abcdef', device, { fetch: blackHole(), sleep: async () => {}, timeoutMs: 20 }).catch((x: unknown) => x as Error);
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
    expect(fs.statSync(path.join(home, 'cloud.json')).mode & 0o777).toBe(0o600);

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

    const down = await cloudStatus({
      home,
      fetch: (async (input: string | URL | Request) => {
        if (String(input) === 'https://h/health') return new Response('{"ok":true,"version":"x"}', { status: 200 });
        throw new TypeError('ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(down).toContain('サーバは停止中');
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
async function fileFixture(o: { secret: string; deviceId: string; uuid: string; text: string; seq: number }): Promise<{ entry: FileEntry; body: Buffer }> {
  const plain = Buffer.from(o.text, 'utf8');
  const body = await encryptBuffer(deriveFileKey(o.secret), gzipSync(plain));
  return {
    entry: {
      key: `transcripts/${o.deviceId}/${o.uuid}.jsonl.gz`,
      path: `projects/-w-p/${o.uuid}.jsonl`,
      kind: 'transcript',
      sha256: createHash('sha256').update(plain).digest('hex'),
      size: plain.length,
      mtime: MTIME,
      encrypted: true,
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
      return new Response(JSON.stringify({ files: files.map((x) => x.entry), nextSeq: last, more: false }), { status: 200 });
    }
    const key = u.pathname.replace(/^\/files\//, '');
    const hit = files.find((x) => x.entry.key === key);
    if (!hit || o.missing?.includes(key)) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(hit.body), { status: 200 });
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

  it('鍵と相対パスが食い違う本文は、手元に置く先を決めない', () => {
    const { home } = dirs();
    const base: FileEntry = { key: '', path: '', kind: 'transcript', sha256: 'x', size: 1, mtime: MTIME, encrypted: true, seq: 1, deviceId: 'dev-b', uploadedAt: 1, storedSize: 1 };
    // 正しく暗号化された別のファイルへの差し替えを、復号と SHA-256 だけでは見抜けない。
    expect(() => rescueTargetPath(home, { ...base, key: 'transcripts/dev-b/other.jsonl.gz', path: 'projects/-w-p/u.jsonl' })).toThrow(/食い違/);
    expect(() => rescueTargetPath(home, { ...base, key: 'transcripts/dev-b/u.jsonl.gz', path: '../../.claude/u.jsonl' })).toThrow(/食い違/);
    expect(() => rescueTargetPath(home, { ...base, kind: 'config', key: 'config/CLAUDE.md', path: '../CLAUDE.md' })).toThrow(/食い違/);
    // 正しい組み合わせは remote の下に収まる。
    expect(rescueTargetPath(home, { ...base, key: 'transcripts/dev-b/u.jsonl.gz', path: 'projects/-w-p/u.jsonl' })).toBe(path.join(home, 'remote', 'dev-b', 'projects', '-w-p', 'u.jsonl'));
    expect(rescueTargetPath(home, { ...base, kind: 'config', key: 'config/CLAUDE.md', path: 'CLAUDE.md' }).startsWith(path.join(home, 'remote'))).toBe(true);
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
