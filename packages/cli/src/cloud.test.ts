import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backfillTranscripts, type CloudConfig, encryptBuffer, loadCloudConfig, readTranscriptsFrom, saveCloudConfig, stampTranscriptsFrom } from '@agent-hangar/server';
import { COMPAT_HEADER, COMPAT_VERSION, decodeEpochList, deriveEpochKeys, fromBase64Url, generateKeyPair, importPrivate, openKeybox, openRoster, parseRecoveryKey, RECOVERY_RECIPIENT, recoverySecretTail } from '@agent-hangar/shared';
import { RecoveryKeyNotConfirmedError } from './recovery.ts';
import { cliErrorText, DetailedError } from './probe.ts';
import { bootstrapDevice, chooseAccountByNumber, cloudBackfill, cloudStatus, defaultCloudDir, installUsageToken, legacyConfigMessage, legacyFileKey, type LegacyFileEntry, offerUsageToken, promptWord, rescueTargetPath, RENAME_WORD, requireCloudDir, cloudDirMissingMessage, readAppVersion, buildMobileApp, runSetupCloud as runSetupCloudReal, runTeardown, setupPendingPath, USAGE_TOKEN_HELP, waitForHealth, WranglerStepError, writeWranglerConfig } from './cloud.ts';
import { joinRequest } from './membership.ts';
import { bindingNames, workerMetadata } from '../../cloud/scripts/build-worker.ts';
import type { Exec, ExecResult, Interactive } from './wrangler.ts';
import { WranglerRunner } from './wrangler.ts';
import { FakeWorker } from '../test/fakeWorker.ts';
import { loadLegacyCloudConfig, saveLegacyCloudConfig, type LegacyCloudConfig } from '../../server/src/config/cloud.ts';
import { dbVersionOf, LATEST_DB_VERSION, seedDbAt, withPendingMigration } from '../../server/test/oldDb.ts';
import { expectMode } from '../../server/test/platform.ts';
import { FakeCloudClient } from '../../server/test/fake-cloud.ts';
import { Keyring } from '../../server/src/sync/keyring.ts';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const device = { id: 'dev-a', name: 'mac', platform: 'darwin' };
const DB_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ACCOUNT_B = 'fedcba9876543210fedcba9876543210';
/** wrangler 4.135 の whoami --json の形（logger.json は 4 字下げの JSON.stringify）。 */
const whoamiJson = (accounts: { id: string; name: string }[]): string => JSON.stringify({ loggedIn: true, authType: 'OAuth Token', email: 'x@example.com', accounts, tokenPermissions: [] }, null, 4);
const WHOAMI = whoamiJson([{ id: ACCOUNT, name: 'Acc' }]);
const TWO = whoamiJson([{ id: ACCOUNT, name: 'Personal' }, { id: ACCOUNT_B, name: 'Shared team' }]);

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
  // cloudDir の隣に mobile のパッケージがある形（リポジトリの packages/ と同じ並び）。dist/app は建てた後の姿。
  fs.mkdirSync(path.join(root, 'mobile', 'dist', 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mobile', 'package.json'), '{"name":"@agent-hangar/mobile"}');
  fs.writeFileSync(path.join(root, 'mobile', 'dist', 'app', 'index.html'), '<!doctype html>');
  return { home, cloudDir };
}

/**
 * 本物の vite を走らせない。呼ばれたことだけを覚える建て役を既定にして runSetupCloud を呼ぶ。
 * リカバリーキーの確認は、表示された暗号鍵の末尾 4 文字を答える（標準入力を読まない）。
 */
const runSetupCloud: typeof runSetupCloudReal = (o) => {
  let shown = '';
  return runSetupCloudReal({
    buildMobile: async () => {},
    recoveryAsk: async () => recoverySecretTail(shown),
    ...o,
    recoveryWrite: (s) => {
      shown += s;
      o.recoveryWrite?.(s);
    },
  });
};

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

/**
 * 偽の Worker と、それを叩く fetch。
 * 最後に作った偽の Worker を lastWorker に置き、wrangler の secret put（putBootstrap）がそこへハッシュを入れる。
 */
let lastWorker: FakeWorker | null = null;
function fakeFetch(healthFails = 2): { fetch: typeof fetch; urls: string[]; worker: FakeWorker } {
  const worker = new FakeWorker();
  worker.healthFails = healthFails;
  lastWorker = worker;
  const urls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return worker.fetch(input, init);
  }) as typeof fetch;
  return { fetch: f, urls, worker };
}

/** wrangler secret put BOOTSTRAP_TOKEN_HASH の代わり。標準入力のハッシュを最後に作った偽の Worker に入れる。 */
const putBootstrap = (_a: string[], input?: string): ExecResult => {
  expect(input).toMatch(/^[0-9a-f]{64}\n$/);
  lastWorker!.bootstrapHash = input!.trim();
  return ok('Success');
};

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const K = (n: number): string => Buffer.alloc(32, n).toString('base64url');

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
  it('資源を作り、設定を書き、デプロイし、health を待ち、最初の端末トークンで登録して cloud.json 版 2 を書く', async () => {
    const { home, cloudDir } = dirs();
    const ff = fakeFetch();
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ({ code: 1, stdout: '', stderr: 'not found' }),
      'd1 create hangar': () => ok(`database_id = "${DB_ID}"`),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('Deployed hangar\n  https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
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
      recoveryWrite: (s) => lines.push(s),
    });

    expect(r.url).toBe('https://hangar.example.workers.dev');
    expect(r.recoveryKey).not.toBeNull();

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
      v: 2,
      url: r.url,
      cloudId: ff.worker.cloudId,
      currentEpoch: 1,
      phoneKey: null,
      rosterVersion: 1,
      workerName: 'hangar',
      accountId: ACCOUNT,
      dbName: 'hangar',
      bucketName: 'hangar-files',
    });
    expect(Object.keys(saved.epochs)).toEqual(['1']);
    expectMode(path.join(home, 'cloud.json'), 0o600);
    // 登録した端末の ID はこの PC の ID で、端末トークンは BOOTSTRAP_TOKEN_HASH に入れたハッシュのものである。
    expect(ff.worker.devices.get(device.id)!.tokenHash).toBe(sha(saved.deviceToken));
    expect(ff.worker.bootstrapHash).toBe(sha(saved.deviceToken));

    const cmds = w.calls.map((c) => c.args.slice(0, 3).join(' '));
    expect(cmds).toEqual(['whoami --json', 'r2 bucket list', 'd1 info hangar', 'd1 create hangar', 'r2 bucket create', 'deploy --config ' + path.join(home, 'cloud', 'wrangler.jsonc'), 'secret put BOOTSTRAP_TOKEN_HASH']);
    expect(w.calls.slice(1).every((c) => c.env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT)).toBe(true);
    expect(ff.urls.filter((u) => u.endsWith('/health'))).toHaveLength(3);
    expect(slept.filter((ms) => ms === 5000).length).toBeGreaterThanOrEqual(2);
    // 端末トークンそのものは argv にも設定ファイルにも出さない。
    expect(w.calls.some((c) => c.args.join(' ').includes(saved.deviceToken))).toBe(false);
    expect(fs.readFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), 'utf8')).not.toContain(saved.deviceToken);

    // リカバリーキーを表示し、パスワードマネージャーへの保存と、スクロールバックのことを伝える。
    const out = lines.join('\n');
    expect(out).toContain(r.recoveryKey!);
    expect(out).toContain('パスワードマネージャー');
    expect(out).toContain('スクロールバック');
    expect(out).toContain(`hangar cloud join ${r.url}`);
    // リカバリーキーの暗号鍵は cloud.json に置かない。
    const recovery = parseRecoveryKey(r.recoveryKey!);
    expect(recovery.url).toBe(r.url);
    expect(fs.readFileSync(path.join(home, 'cloud.json'), 'utf8')).not.toContain(recovery.priv);
  });

  it('setup の後、名簿に自分とリカバリーの公開鍵、keybox が 2 つ', async () => {
    const { home, cloudDir } = dirs();
    const ff = fakeFetch(0);
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    const r = await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} });
    const saved = loadCloudConfig(home)!;
    const keys = await deriveEpochKeys(1, saved.epochs['1']!);

    // 名簿は世代 1 の /roster の鍵で、版 1 として封じてある。
    const roster = await openRoster(keys.roster, ff.worker.roster!.version, fromBase64Url(ff.worker.roster!.sealed)!);
    expect(ff.worker.roster!.version).toBe(1);
    expect(roster.entries).toEqual([{ id: device.id, kind: 'pc', name: device.name, os: device.platform, pub: saved.keyPair.pub, joinedAt: saved.joinedAt }]);
    expect(roster.phoneKey).toBeNull();

    // keybox は この PC 宛てと recovery 宛ての 2 つで、どちらも世代の一覧（世代 1）を開ける。
    expect([...ff.worker.keyboxes.keys()].sort()).toEqual([`${device.id}:1`, `${RECOVERY_RECIPIENT}:1`].sort());
    const mine = await openKeybox(await importPrivate(saved.keyPair.priv), saved.keyPair.pub, { epoch: 1, recipient: device.id }, fromBase64Url(ff.worker.keyboxes.get(`${device.id}:1`)!.sealed)!);
    expect(decodeEpochList(mine).epochs).toEqual(saved.epochs);
    // リカバリーキーの秘密鍵で recovery 宛ての keybox が開け、名簿の recoveryPub はその公開鍵である。
    const recovery = parseRecoveryKey(r.recoveryKey!);
    const other = await generateKeyPair();
    await expect(openKeybox(await importPrivate(other.priv), roster.recoveryPub, { epoch: 1, recipient: RECOVERY_RECIPIENT }, fromBase64Url(ff.worker.keyboxes.get(`${RECOVERY_RECIPIENT}:1`)!.sealed)!)).rejects.toThrow();
    const box = await openKeybox(await importPrivate(recovery.priv), roster.recoveryPub, { epoch: 1, recipient: RECOVERY_RECIPIENT }, fromBase64Url(ff.worker.keyboxes.get(`${RECOVERY_RECIPIENT}:1`)!.sealed)!);
    expect(decodeEpochList(box).epochs).toEqual(saved.epochs);
  });

  it('末尾 4 文字を入れないと setup が終わらず、名簿もリカバリーの keybox も置かない。もう一度実行すれば新しいリカバリーキーで続ける', async () => {
    const { home, cloudDir } = dirs();
    const ff = fakeFetch(0);
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    const base = { home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} };
    let asked = 0;
    const first: string[] = [];
    await expect(runSetupCloud({ ...base, recoveryAsk: async () => { asked++; return ''; }, recoveryWrite: (s) => first.push(s) })).rejects.toBeInstanceOf(RecoveryKeyNotConfirmedError);
    expect(asked).toBeGreaterThan(0);
    expect(ff.worker.roster).toBeNull();
    expect([...ff.worker.keyboxes.keys()].some((k) => k.startsWith(`${RECOVERY_RECIPIENT}:`))).toBe(false);
    // 名簿の無いクラウドをアプリが取り込まないよう、cloud.json の版 2 はまだ書かない。
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
    // 端末トークンは失わない（登録の直後に下書きへ書いてある）。
    const pending = JSON.parse(fs.readFileSync(setupPendingPath(home), 'utf8')) as { conf: CloudConfig };
    expectMode(setupPendingPath(home), 0o600);
    expect(ff.worker.devices.get(device.id)?.tokenHash).toBe(sha(pending.conf.deviceToken));
    const secretPuts = (): number => w.calls.filter((c) => c.args.join(' ').startsWith('secret put')).length;
    expect(secretPuts()).toBe(1);

    const r = await runSetupCloud(base);
    expect(r.recoveryKey).not.toBeNull();
    // 確認できなかった 1 回目のキーとは別のキーである。
    expect(first.join('')).not.toContain(r.recoveryKey!.split('\n')[3]);
    // 下書きの端末トークンと暗号鍵で続ける（bootstrap も secret put もやり直さない）。
    expect(secretPuts()).toBe(1);
    const saved = loadCloudConfig(home)!;
    expect(saved).toMatchObject({ v: 2, deviceToken: pending.conf.deviceToken, keyPair: pending.conf.keyPair, epochs: pending.conf.epochs, rosterVersion: 1, workerName: 'hangar' });
    expect(fs.existsSync(setupPendingPath(home))).toBe(false);
    const roster = await openRoster((await deriveEpochKeys(1, saved.epochs['1']!)).roster, 1, fromBase64Url(ff.worker.roster!.sealed)!);
    expect(roster.recoveryPub).toBeTruthy();
    expect(ff.worker.keyboxes.has(`${RECOVERY_RECIPIENT}:1`)).toBe(true);
  });

  it('確認の段で例外（Ctrl+C など）で止まっても cloud.json は版 2 にならず、同期が始まらない', async () => {
    const { home, cloudDir } = dirs();
    const ff = fakeFetch(0);
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    const base = { home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} };
    await expect(runSetupCloud({ ...base, recoveryAsk: async () => { throw new Error('interrupted'); } })).rejects.toThrow('interrupted');
    expect(loadCloudConfig(home)).toBeNull();
    expect(ff.worker.roster).toBeNull();
    expect(fs.existsSync(setupPendingPath(home))).toBe(true);

    const r = await runSetupCloud(base);
    expect(r.url).toBe('https://hangar.example.workers.dev');
    expect(loadCloudConfig(home)).toMatchObject({ v: 2, url: r.url, rosterVersion: 1 });
    expect(fs.existsSync(setupPendingPath(home))).toBe(false);
  });

  it('下書きのクラウドの ID が今の Worker と違えば、下書きを消すよう案内して止める（画面の語に「端末」を使わない）', async () => {
    const { home, cloudDir } = dirs();
    const ff = fakeFetch(0);
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    const base = { home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} };
    await expect(runSetupCloud({ ...base, recoveryAsk: async () => { throw new Error('interrupted'); } })).rejects.toThrow('interrupted');
    const draft = JSON.parse(fs.readFileSync(setupPendingPath(home), 'utf8')) as { conf: CloudConfig };
    fs.writeFileSync(setupPendingPath(home), JSON.stringify({ ...draft, conf: { ...draft.conf, cloudId: 'cloud-other' } }), { mode: 0o600 });
    const err = await runSetupCloud(base).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('この PC 用のトークン');
    expect(err!.message).not.toContain('端末');
  });

  it('名簿を置いた後、cloud.json を書く前に止まっていたら、再実行で名簿の版を写して cloud.json を書く', async () => {
    const { home, cloudDir } = dirs();
    const ff = fakeFetch(0);
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    const base = { home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} };
    await runSetupCloud(base);
    // 名簿まで置けた後に cloud.json だけが書けなかった姿を作る。
    const saved = loadCloudConfig(home)!;
    fs.rmSync(path.join(home, 'cloud.json'));
    fs.writeFileSync(setupPendingPath(home), JSON.stringify({ v: 1, deviceId: device.id, conf: { ...saved, rosterVersion: 0 }, createdAt: 1 }), { mode: 0o600 });

    const lines: string[] = [];
    const r = await runSetupCloud({ ...base, log: (l) => lines.push(l) });
    expect(r.recoveryKey).toBeNull();
    expect(loadCloudConfig(home)).toMatchObject({ v: 2, deviceToken: saved.deviceToken, rosterVersion: 1 });
    expect(fs.existsSync(setupPendingPath(home))).toBe(false);
    expect(lines.join('\n')).not.toContain('Worker を入れ替えました');
  });

  it('--save を渡すと、リカバリーキーを 0600 のファイルにも書く', async () => {
    const { home, cloudDir } = dirs();
    const ff = fakeFetch(0);
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    const file = path.join(home, 'saved', 'recovery.txt');
    fs.mkdirSync(path.dirname(file));
    const r = await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {}, saveRecoveryTo: file });
    expect(fs.readFileSync(file, 'utf8')).toBe(`${r.recoveryKey!}\n`);
    expectMode(file, 0o600);
  });

  it('確認に失敗して止まったら、--save で書いたファイルを消す', async () => {
    const { home, cloudDir } = dirs();
    const ff = fakeFetch(0);
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    const file = path.join(home, 'saved', 'recovery.txt');
    fs.mkdirSync(path.dirname(file));
    await expect(runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {}, saveRecoveryTo: file, recoveryAsk: async () => '' })).rejects.toBeInstanceOf(RecoveryKeyNotConfirmedError);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([['PUT /keyboxes'], ['PUT /roster']])('確認の後に %s が失敗して止まったら、保存したキーは使えないと伝える', async (failing) => {
    const { home, cloudDir } = dirs();
    const ff = fakeFetch(0);
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      if (`${(init?.method ?? 'GET').toUpperCase()} ${new URL(String(input)).pathname}` === failing) return new Response('{"error":"boom"}', { status: 500 });
      return ff.fetch(input, init);
    }) as typeof fetch;
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    await expect(runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: f, sleep: async () => {}, cloudDir, log: () => {} })).rejects.toThrow(/先に保存したキーは使えません。もう一度実行して、新しいキーを保存してください/);
  });

  it('同じ名前でもう一度実行すると、Worker だけを入れ替え、暗号鍵と端末トークンとリカバリーキーは変えない', async () => {
    const { home, cloudDir } = dirs();
    const prev = v2conf({ url: 'https://hangar-dev.example.workers.dev', deviceToken: 'tok-prev', workerName: 'hangar-dev', accountId: ACCOUNT, dbName: 'hangar-dev', bucketName: 'hangar-dev-files' });
    saveCloudConfig(home, prev);
    const ff = fakeFetch();
    ff.worker.devices.set(device.id, { tokenHash: sha('tok-prev'), revoked: false });
    ff.worker.roster = { version: 3, sealed: 'x' };
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar-dev --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-dev-files': () => ({ code: 1, stdout: '', stderr: 'A bucket with this name already exists' }),
      deploy: () => ok('https://hangar-dev.example.workers.dev'),
    });
    const r = await runSetupCloud({ home, name: 'hangar-dev', device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} });
    expect(r.recoveryKey).toBeNull();
    // secret put も bootstrap もしない。
    expect(w.calls.map((c) => c.args[0])).toEqual(['whoami', 'r2', 'd1', 'r2', 'deploy']);
    expect(ff.worker.calls).not.toContain('POST /bootstrap');
    expect(ff.worker.calls).not.toContain('PUT /roster');
    expect(loadCloudConfig(home)).toEqual(prev);
  });

  it('名簿を置く前に止まった setup は、もう一度実行すると名簿と keybox から続ける', async () => {
    const { home, cloudDir } = dirs();
    const pair = await generateKeyPair();
    const prev = v2conf({ url: 'https://hangar.example.workers.dev', deviceToken: 'tok-prev', keyPair: pair, rosterVersion: 0, workerName: 'hangar', accountId: ACCOUNT, dbName: 'hangar', bucketName: 'hangar-files' });
    saveCloudConfig(home, prev);
    const ff = fakeFetch(0);
    ff.worker.devices.set(device.id, { tokenHash: sha('tok-prev'), revoked: false });
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
    });
    const r = await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} });
    expect(r.recoveryKey).not.toBeNull();
    expect(ff.worker.roster!.version).toBe(1);
    expect(loadCloudConfig(home)).toEqual({ ...prev, rosterVersion: 1 });
  });

  it('古い形式（参加トークンの版 1）の cloud.json は上書きせず、teardown を案内して止める', async () => {
    const { home, cloudDir } = dirs();
    const before = JSON.stringify({ url: 'https://old.workers.dev', joinSecret: 'keep', deviceToken: 'old', workerName: 'hangar', accountId: ACCOUNT, dbName: 'hangar', bucketName: 'hangar-files', joinedAt: 1 });
    fs.writeFileSync(path.join(home, 'cloud.json'), before);
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    const ff = fakeFetch(0);
    await expect(runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} })).rejects.toThrow(/npm run hangar -- cloud teardown/);
    expect(w.calls).toHaveLength(0);
    expect(ff.urls).toEqual([]);
    expect(fs.readFileSync(path.join(home, 'cloud.json'), 'utf8')).toBe(before);
  });

  it('ログインしていなければ login を対話で実行してからもう一度読む', async () => {
    const { home, cloudDir } = dirs();
    let asked = 0;
    const w = fakeWrangler({
      // ログインしていないときの --json は {"loggedIn":false} を出して 0 以外で終わる。
      whoami: () => (asked++ === 0 ? { code: 1, stdout: '{"loggedIn":false}', stderr: '' } : ok(WHOAMI)),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
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
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch().fetch, sleep: async () => {}, cloudDir, log: () => {} });

    // 床はサーバの起動を待たずに入る。古いサーバが先に走っても、床の無い隙が生まれない。
    const joinedAt = loadCloudConfig(home)!.joinedAt;
    expect(joinedAt).toBeGreaterThan(0);
    expect(readTranscriptsFrom(home)).toBe(joinedAt);
  });

  it('別の名前で作り直すときは、前の資源が置き去りになることを見せて確認する', async () => {
    const { home, cloudDir } = dirs();
    saveCloudConfig(home, v2conf({ url: 'https://hangar-dev.example.workers.dev', deviceToken: 'old', workerName: 'hangar-dev', accountId: ACCOUNT, dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
    const before = fs.readFileSync(path.join(home, 'cloud.json'), 'utf8');
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
    ).rejects.toThrow(/キャンセル/);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.word).toBe(RENAME_WORD);
    // 置き去りになる資源を名指しで見せる。teardown は cloud.json しか見ないので、届かなくなる。
    const out = lines.join('\n');
    expect(out).toContain('hangar-dev');
    expect(out).toContain('hangar-dev-files');
    expect(out).toContain('削除できなくなります');
    // 断ったら資源にも cloud.json にも触らない。
    expect(w.calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(home, 'cloud.json'), 'utf8')).toBe(before);
  });

  it('参加だけの端末で setup cloud を走らせるときも確認する', async () => {
    const { home, cloudDir } = dirs();
    saveCloudConfig(home, v2conf({ url: 'https://other.example.workers.dev', deviceToken: 'old' }));
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    const lines: string[] = [];
    await expect(
      runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch().fetch, sleep: async () => {}, cloudDir, log: (l) => lines.push(l), confirm: async () => false }),
    ).rejects.toThrow(/キャンセル/);
    expect(lines.join('\n')).toContain('https://other.example.workers.dev');
    expect(w.calls).toHaveLength(0);
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

describe('bootstrapDevice（最初の端末トークンで登録する）', () => {
  const created = (): Response => new Response(JSON.stringify({ deviceId: device.id }), { status: 201 });

  it('secret の反映待ちの 503 と 401 は待って再試行し、この PC の ID とトークンを本文で送る', async () => {
    const codes = [503, 401, 201];
    const bodies: unknown[] = [];
    let i = 0;
    const f = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      const code = codes[i++]!;
      return code === 201 ? created() : new Response(JSON.stringify({ error: 'x' }), { status: code });
    }) as typeof fetch;
    const slept: number[] = [];
    await bootstrapDevice('https://h', 'tok-0123456789abcdef', device.id, { fetch: f, sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toHaveLength(2);
    expect(bodies[0]).toEqual({ deviceId: device.id, token: 'tok-0123456789abcdef' });
  });

  it('待っても 401 のままなら、すでに登録済みの可能性を伝えて止める', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) as typeof fetch;
    const slept: number[] = [];
    await expect(bootstrapDevice('https://h', 't', device.id, { fetch: f, sleep: async (ms) => { slept.push(ms); }, retries: 2 })).rejects.toThrow(/登録できませんでした（HTTP 401）/);
    expect(slept).toHaveLength(2);
  });

  it('待っても 503 のままなら諦める', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'not initialized' }), { status: 503 })) as typeof fetch;
    const slept: number[] = [];
    await expect(bootstrapDevice('https://h', 't', device.id, { fetch: f, sleep: async (ms) => { slept.push(ms); }, retries: 2 })).rejects.toThrow(/503/);
    expect(slept).toHaveLength(2);
  });

  it('応答を返さない宛先は締め切りで打ち切り、文面は宛先と次に確認する先を示す（トークンは載せない）', async () => {
    const slept: number[] = [];
    const e: Error = await bootstrapDevice('https://black-hole.invalid', 'SECRET-abcdef', device.id, { fetch: blackHole(), sleep: async (ms) => { slept.push(ms); }, timeoutMs: 20 }).then(() => { throw new Error('打ち切られるはずが通った'); }, (x: unknown) => x as Error);
    expect(e.message).toContain('応答しませんでした');
    expect(e.message).toContain('https://black-hole.invalid');
    expect(e.message).toContain('20 ミリ秒');
    expect(e.message).toContain('/health');
    expect(e.message).not.toContain('SECRET-abcdef');
    expect(slept).toHaveLength(0);
  });

  it('宛先に接続できないときも 1 行で止める', async () => {
    const f = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as typeof fetch;
    await expect(bootstrapDevice('https://nope.invalid', 't', device.id, { fetch: f, sleep: async () => {} })).rejects.toThrow(/ENOTFOUND/);
  });

  it('締め切りは 1 回ごとで、反映待ちの再試行を削らない', async () => {
    const codes = [503, 503, 401, 401, 503, 401, 201];
    let i = 0;
    const f = (async (_u: unknown, init?: RequestInit) => {
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      const code = codes[i++]!;
      return code === 201 ? created() : new Response(JSON.stringify({ error: 'x' }), { status: code });
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    await bootstrapDevice('https://h', 't', device.id, { fetch: f, sleep: async (ms) => { slept.push(ms); }, timeoutMs: 20 });
    expect(slept).toEqual([5000, 5000, 5000, 5000, 5000, 5000]);
  });
});

/** 版 2 の cloud.json。鍵は形だけ合わせた作り物である。 */
function v2conf(over: Partial<CloudConfig> = {}): CloudConfig {
  return {
    v: 2,
    url: 'https://h',
    cloudId: 'cloud-1',
    deviceToken: 'dt',
    keyPair: { pub: K(1), priv: K(2) },
    epochs: { '1': K(3) },
    currentEpoch: 1,
    phoneKey: null,
    rosterVersion: 1,
    workerName: null,
    accountId: null,
    dbName: null,
    bucketName: null,
    joinedAt: 1,
    ...over,
  };
}

const conf = v2conf;

/** 古い形式（版 1）の cloud.json。teardown だけが読む。 */
const legacyConf = (over: Partial<LegacyCloudConfig> = {}): LegacyCloudConfig => ({
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
  /**
   * いまの版の DB を置き、控えの置き場（backups/db）を通常のファイルにして作れなくする。
   * 当てるものがあるように、呼ぶ側は仮の次の版を足して走らせる（withPendingMigration）。
   */
  const blockBackup = (home: string): string => {
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION);
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(home, 'backups', 'db'), 'x');
    return file;
  };

  it('setup cloud は Cloudflare に何も作らず、cloud.json も書かずに止まる', async () => {
    const { home, cloudDir } = dirs();
    const file = blockBackup(home);
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    const ff = fakeFetch(0);
    const err = await withPendingMigration(() => runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: ff.fetch, sleep: async () => {}, cloudDir, log: () => {} }).then(() => null, (e: unknown) => e));
    // 元の文に、次にすることの 1 文が続く。
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('マイグレーションを適用せずに停止しました');
    expect((err as Error).message).toContain('Cloudflare にはまだ何も作成していません。修正してから hangar setup cloud をもう一度実行してください。');
    expect((err as Error).message).not.toContain('\n');
    expect(w.calls).toEqual([]);
    expect(w.interactiveCalls).toEqual([]);
    expect(ff.urls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION);
  });

  it('参加リクエストは送らず、下書きも cloud.json も書かずに止まる', async () => {
    const { home } = dirs();
    const file = blockBackup(home);
    const urls: string[] = [];
    const f = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response('{}', { status: 500 }); }) as typeof fetch;
    const err = await withPendingMigration(() => joinRequest({ home, url: 'https://h.workers.dev', code: 'K7QM-2XFD', device, fetch: f }).then(() => null, (e: unknown) => e));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('マイグレーションを適用せずに停止しました');
    expect((err as Error).message).toContain('参加リクエストはまだ送信していません。修正してから hangar cloud join をもう一度実行してください。');
    expect((err as Error).message).not.toContain('\n');
    expect(urls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'cloud-pending.json'))).toBe(false);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION);
  });

  it('控えが取れれば、setup cloud は先に DB を上げて控え、最後に床を刻む', async () => {
    const { home, cloudDir } = dirs();
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION);
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
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    // 当てるものがあるように、仮の次の版（いまの版の 1 つ先）を足して走らせる。
    await withPendingMigration(() => runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch(0).fetch, sleep: async () => {}, cloudDir, log: () => {} }));
    expect(versionAtWhoami).toBe(LATEST_DB_VERSION + 1);
    expect(backupsAtWhoami).toBe(1);
    expect(fs.readdirSync(path.join(home, 'backups', 'db'))).toHaveLength(1);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION + 1);
    expect(readTranscriptsFrom(home)).toBe(loadCloudConfig(home)!.joinedAt);
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
          JSON.stringify({ state: 'idle', pending: 2, lastPullAt: 1000, lastPushAt: 1000, deviceCount: 2, url: 'https://h', error: null }),
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
    expect(out).toContain('PC 2 台');
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
    expect(await cloudStatus({ home, fetch: limited, now: () => 61_000 })).toContain('無料枠の上限に達したため 2026-10-09T00:00:00.000Z まで停止しています');

    const down = await cloudStatus({
      home,
      fetch: (async (input: string | URL | Request) => {
        if (String(input) === 'https://h/health') return new Response('{"ok":true,"version":"x"}', { status: 200 });
        throw new TypeError('ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(down).toContain('サーバーは停止中');
  });

  it('本文をいつから上げるかを 1 行で見せる', async () => {
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't' }));
    const dead = (async () => { throw new TypeError('ECONNREFUSED'); }) as typeof fetch;

    // 床があるときは、その時刻より後に動いた本文だけを上げると伝える。
    stampTranscriptsFrom(home, Date.parse('2026-09-19T12:00:00.000Z'));
    const out = await cloudStatus({ home, fetch: dead });
    expect(out).toContain('トランスクリプト: 2026-09-19T12:00:00.000Z 以降に更新された分をアップロードします');

    // backfill で床を落とした後は、全部上げると伝える。
    backfillTranscripts(home);
    expect(await cloudStatus({ home, fetch: dead })).toContain('トランスクリプト: この PC のトランスクリプトをすべてアップロードします');
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
async function fileFixture(o: { secret: string; deviceId: string; uuid: string; text: string; seq: number; encrypted?: boolean }): Promise<{ entry: LegacyFileEntry; body: Buffer }> {
  const plain = Buffer.from(o.text, 'utf8');
  const encrypted = o.encrypted ?? true;
  // 秘密を持たない相手は暗号化できない。平文の gzip をそのまま置く形も作れるようにしておく。
  const body = encrypted ? await encryptBuffer(legacyFileKey(o.secret), gzipSync(plain)) : gzipSync(plain);
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
function cloudFetch(files: { entry: LegacyFileEntry; body: Buffer }[], o: { token: string; missing?: string[]; compat?: number }) {
  const paths: string[] = [];
  const compat = String(o.compat ?? COMPAT_VERSION);
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (auth !== `Bearer ${o.token}`) return new Response('unauthorized', { status: 401 });
    paths.push(u.pathname);
    if (u.pathname === '/files') {
      const last = files.length ? files[files.length - 1]!.entry.seq : 0;
      return new Response(JSON.stringify({ files: files.map((x) => x.entry), nextSeq: last, more: false }), { status: 200, headers: { [COMPAT_HEADER]: compat } });
    }
    const key = u.pathname.replace(/^\/files\//, '');
    const hit = files.find((x) => x.entry.key === key);
    if (!hit || o.missing?.includes(key)) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(hit.body), { status: 200, headers: { [COMPAT_HEADER]: compat } });
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
    saveLegacyCloudConfig(home, legacyConf({ joinSecret: secret, deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
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
    expect(out).toContain('1 件をこの PC にダウンロードしました');
    // 他の PC は手で cloud.json を消さず、0.9.0 以降に更新してから参加コードで上書きして参加する（古い設定は自動でバックアップされる）。
    expect(out).not.toContain('手動で削除');
    expect(out).toContain('0.9.0 以降に更新');
    expect(out).toContain('上書きして参加');
    expect(out).toContain('~/.agent-hangar/backups/');
    expect(out).not.toMatch(/残って/);
  });

  it('teardown は版 1 の cloud.json でも R2 の本文を remote/ に降ろしてから消す（旧い Worker の互換の版のままでも）', async () => {
    const { home, cloudDir } = dirs();
    const secret = 'join-secret-0000';
    saveLegacyCloudConfig(home, legacyConf({ joinSecret: secret, deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
    const theirs = await fileFixture({ secret, deviceId: 'dev-b', uuid: 'u-theirs', text: '{"theirs":1}\n', seq: 1 });
    // 0.8.x の Worker は互換の版 7 を返す。0.9.0 の PC はふだん断るが、片付けでは読むだけなので断らない。
    const cf = cloudFetch([theirs], { token: 'dt', compat: 7 });
    const saved = path.join(home, 'remote', 'dev-b', 'projects', '-w-p', 'u-theirs.jsonl');
    // 降ろし終えてから消し始める。
    const savedWhenDeleting: boolean[] = [];
    const w = fakeWrangler({ 'r2 object delete': () => { savedWhenDeleting.push(fs.existsSync(saved)); return ok(); }, 'r2 bucket delete': () => ok(), 'delete --name': () => ok(), 'd1 delete': () => ok() });
    const done = await runTeardown({ home, deviceId: 'dev-a', wrangler: w.runner('a'.repeat(32), cloudDir), fetch: cf.fetch, confirm: fakeConfirm([true, true]).fn, log: () => {} });
    expect(done).toBe(true);
    expect(fs.readFileSync(saved, 'utf8')).toBe('{"theirs":1}\n');
    expect(savedWhenDeleting).toEqual([true]);
    expect(w.calls.map((x) => x.args.slice(0, 3).join(' '))).toEqual(['r2 object delete', 'r2 bucket delete', 'delete --name hangar-dev', 'd1 delete hangar-dev']);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
  });

  it('確認に失敗したら何もしない', async () => {
    const { home, cloudDir } = dirs();
    const before = legacyConf({ deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' });
    saveLegacyCloudConfig(home, before);
    const w = fakeWrangler({});
    const c = fakeConfirm([false]);
    const done = await runTeardown({ home, deviceId: 'dev-a', wrangler: w.runner('a'.repeat(32), cloudDir), fetch: cloudFetch([], { token: 'dt' }).fetch, confirm: c.fn, log: () => {} });
    expect(done).toBe(false);
    expect(w.calls).toEqual([]);
    expect(loadLegacyCloudConfig(home)).toEqual(before);
  });

  it('降ろせない本文があれば、確認も聞かずに消すのをやめる', async () => {
    const { home, cloudDir } = dirs();
    const secret = 'join-secret-0000';
    saveLegacyCloudConfig(home, legacyConf({ joinSecret: secret, deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
    const theirs = await fileFixture({ secret, deviceId: 'dev-b', uuid: 'u-theirs', text: '{"theirs":1}\n', seq: 1 });
    const cf = cloudFetch([theirs], { token: 'dt', missing: [theirs.entry.key] });
    const w = fakeWrangler({});
    const c = fakeConfirm([true, true]);
    await expect(
      runTeardown({ home, deviceId: 'dev-a', wrangler: w.runner('a'.repeat(32), cloudDir), fetch: cf.fetch, confirm: c.fn, log: () => {} }),
    ).rejects.toThrow(/ダウンロードでき/);
    expect(c.asked).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(loadLegacyCloudConfig(home)).not.toBeNull();
  });

  it('暗号化されていない本文は受け取らず、消すのもやめる', async () => {
    const { home, cloudDir } = dirs();
    const secret = 'join-secret-0000';
    saveLegacyCloudConfig(home, legacyConf({ joinSecret: secret, deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
    // Worker が握っているのは秘密の SHA-256 だけなので、正しく暗号化した本文は作れない。
    // 平文を通す道が残っていると、Worker の側から remote の下に中身を仕込める。
    const planted = await fileFixture({ secret, deviceId: 'dev-b', uuid: 'u-planted', text: '{"planted":"by the worker"}\n', seq: 1, encrypted: false });
    const cf = cloudFetch([planted], { token: 'dt' });
    const w = fakeWrangler({});
    const c = fakeConfirm([true, true]);
    await expect(
      runTeardown({ home, deviceId: 'dev-a', wrangler: w.runner('a'.repeat(32), cloudDir), fetch: cf.fetch, confirm: c.fn, log: () => {} }),
    ).rejects.toThrow(/ダウンロードでき/);
    expect(fs.existsSync(path.join(home, 'remote', 'dev-b', 'projects', '-w-p', 'u-planted.jsonl'))).toBe(false);
    expect(c.asked).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it('R2 を空にできなければ Worker も D1 も消さず、手元の設定を残す', async () => {
    const { home, cloudDir } = dirs();
    fs.mkdirSync(path.join(home, 'cloud'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), '{}');
    const before = legacyConf({ deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' });
    saveLegacyCloudConfig(home, before);
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
    expect(loadLegacyCloudConfig(home)).toEqual(before);
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
    const before = legacyConf({ deviceToken: 'dt', workerName: 'hangar-dev', accountId: 'a'.repeat(32), dbName: 'hangar-dev', bucketName: 'hangar-dev-files' });
    saveLegacyCloudConfig(home, before);
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
    expect(loadLegacyCloudConfig(home)).toEqual(before);
    expect(fs.existsSync(path.join(home, 'cloud', 'wrangler.jsonc'))).toBe(true);
    const out = lines.join('\n');
    expect(out).toContain('削除したもの');
    expect(out).toContain(`R2 bucket ${before.bucketName}`);
    expect(out).toContain(`D1 ${before.dbName}`);
    expect(out).toContain('残ったもの');
    expect(out).toContain(`Worker ${before.workerName}`);
  });

  it('鍵と相対パスが食い違う本文は、手元に置く先を決めない', () => {
    const { home } = dirs();
    const base: LegacyFileEntry = { key: '', path: '', kind: 'transcript', sha256: 'x', size: 1, mtime: MTIME, encrypted: true, seq: 1, deviceId: 'dev-b', uploadedAt: 1, storedSize: 1 };
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
    saveLegacyCloudConfig(home, legacyConf({ deviceToken: 'dt' }));
    await expect(
      runTeardown({ home, fetch: (async () => new Response('{}')) as typeof fetch, confirm: async () => true, log: () => {} }),
    ).rejects.toThrow('setup cloud を実行した PC');
  });

  it('版 2 の cloud.json では、封じた索引を開いて本文を元の PC の下へ降ろしてから消す', async () => {
    const { home, cloudDir } = dirs();
    const claudeDir = path.join(home, 'claude');
    fs.mkdirSync(path.join(home, 'cloud'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), '{}');
    const cfg = v2conf({ workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files' });
    saveCloudConfig(home, cfg);
    const keyring = Keyring.fromConfig(cfg);
    const cloudB = new FakeCloudClient({ deviceId: 'dev-b', keyring });
    await cloudB.putText({ path: 'projects/-w-p/u-theirs.jsonl' }, '{"theirs":1}\n');
    // 作り直しで dev-b が上げ直した dev-c の写し。元の PC の下へ戻す。
    await cloudB.putText({ path: 'projects/-w-p/u-c.jsonl', origin: 'dev-c' }, '{"c":1}\n');
    await cloudB.putText({ path: 'CLAUDE.md', kind: 'config' }, '# b\n');
    const cloudA = cloudB.asDevice('dev-a', { keyring });
    // 自分の本文は原本が手元にあるので降ろさない。
    await cloudA.putText({ path: 'projects/-w-p/u-mine.jsonl' }, '{"mine":1}\n');
    fs.mkdirSync(path.join(claudeDir, 'projects', '-w-p'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'projects', '-w-p', 'u-mine.jsonl'), '{"mine":1}\n');
    const keys = [...cloudA.files.keys()];
    const w = fakeWrangler({ 'r2 object delete': () => ok(), 'r2 bucket delete': () => ok(), 'delete --name': () => ok(), 'd1 delete': () => ok() });
    const c = fakeConfirm([true, true]);

    const done = await runTeardown({ home, deviceId: 'dev-a', claudeDir, wire: cloudA.wire, wrangler: w.runner('a'.repeat(32), cloudDir), confirm: c.fn, log: () => {} });
    expect(done).toBe(true);
    expect(fs.readFileSync(path.join(home, 'remote', 'dev-b', 'projects', '-w-p', 'u-theirs.jsonl'), 'utf8')).toBe('{"theirs":1}\n');
    expect(fs.readFileSync(path.join(home, 'remote', 'dev-c', 'projects', '-w-p', 'u-c.jsonl'), 'utf8')).toBe('{"c":1}\n');
    expect(fs.readFileSync(path.join(home, 'remote', 'dev-b', '_config', 'CLAUDE.md'), 'utf8')).toBe('# b\n');
    expect(fs.existsSync(path.join(home, 'remote', 'dev-a'))).toBe(false);
    // 鍵名は HMAC なので、索引にある鍵名をそのまま消す。
    const wcfg = path.join(home, 'cloud', 'wrangler.jsonc');
    expect(w.calls.map((x) => x.args.join(' '))).toEqual([
      ...keys.map((k) => `r2 object delete hangar-files/${k} --remote --config ${wcfg}`),
      `r2 bucket delete hangar-files --config ${wcfg}`,
      `delete --name hangar --config ${wcfg}`,
      `d1 delete hangar -y --config ${wcfg}`,
    ]);
    expect(c.asked.map((a) => a.word)).toEqual(['hangar', 'delete']);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
  });

  it('opencode の本文の写しも降ろす。自分の会話で、書き出しが手元にあるものは降ろし直さない', async () => {
    const { home, cloudDir } = dirs();
    fs.mkdirSync(path.join(home, 'cloud'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), '{}');
    const cfg = v2conf({ workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files' });
    saveCloudConfig(home, cfg);
    const keyring = Keyring.fromConfig(cfg);
    const cloudB = new FakeCloudClient({ deviceId: 'dev-b', keyring });
    await cloudB.putText({ path: 'opencode/ses_theirs.json' }, '{"info":{"id":"ses_theirs"},"messages":[]}\n');
    const cloudA = cloudB.asDevice('dev-a', { keyring });
    await cloudA.putText({ path: 'opencode/ses_mine.json' }, '{"info":{"id":"ses_mine"},"messages":[]}\n');
    // 自分の会話の原本は opencode の記録の置き場にあり、上げた書き出しも手元にある。
    fs.mkdirSync(path.join(home, 'opencode', 'export'), { recursive: true });
    fs.writeFileSync(path.join(home, 'opencode', 'export', 'ses_mine.json'), '{"info":{"id":"ses_mine"},"messages":[]}\n');
    const w = fakeWrangler({ 'r2 object delete': () => ok(), 'r2 bucket delete': () => ok(), 'delete --name': () => ok(), 'd1 delete': () => ok() });
    const lines: string[] = [];

    const done = await runTeardown({ home, deviceId: 'dev-a', claudeDir: path.join(home, 'claude'), wire: cloudA.wire, wrangler: w.runner('a'.repeat(32), cloudDir), confirm: fakeConfirm([true, true]).fn, log: (l) => lines.push(l) });
    expect(done).toBe(true);
    expect(fs.readFileSync(path.join(home, 'remote', 'dev-b', 'opencode', 'ses_theirs.json'), 'utf8')).toBe('{"info":{"id":"ses_theirs"},"messages":[]}\n');
    expect(fs.existsSync(path.join(home, 'remote', 'dev-a'))).toBe(false);
    expect(lines.join('\n')).toContain('1 件をこの PC にダウンロードしました');
  });

  it('Codex の本文の写しも降ろす。自分の会話で、原本が $CODEX_HOME にあるものは降ろし直さない', async () => {
    const { home, cloudDir } = dirs();
    fs.mkdirSync(path.join(home, 'cloud'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), '{}');
    const cfg = v2conf({ workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files' });
    saveCloudConfig(home, cfg);
    const keyring = Keyring.fromConfig(cfg);
    const theirs = 'rollout-2026-10-26T14-00-00-0198a7c2-0000-7000-8000-00000000000b.jsonl';
    const mine = 'rollout-2026-10-26T15-00-00-0198a7c2-0000-7000-8000-00000000000a.jsonl';
    const gone = 'rollout-2026-10-26T16-00-00-0198a7c2-0000-7000-8000-00000000000c.jsonl';
    const cloudB = new FakeCloudClient({ deviceId: 'dev-b', keyring });
    await cloudB.putText({ path: `codex/archived_sessions/${theirs}` }, '{"b":1}\n');
    const cloudA = cloudB.asDevice('dev-a', { keyring });
    await cloudA.putText({ path: `codex/sessions/2026/10/26/${mine}` }, '{"a":1}\n');
    // 自分の会話でも、原本が $CODEX_HOME に無いものは降ろす（消すと失われる）。
    await cloudA.putText({ path: `codex/sessions/2026/10/26/${gone}` }, '{"c":1}\n');
    // 原本は圧縮された .jsonl.zst のこともある。
    const codexHome = path.join(home, 'codex-home');
    fs.mkdirSync(path.join(codexHome, 'sessions', '2026', '10', '26'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'sessions', '2026', '10', '26', `${mine}.zst`), 'zst');
    const w = fakeWrangler({ 'r2 object delete': () => ok(), 'r2 bucket delete': () => ok(), 'delete --name': () => ok(), 'd1 delete': () => ok() });

    const done = await runTeardown({ home, deviceId: 'dev-a', claudeDir: path.join(home, 'claude'), codexHome, wire: cloudA.wire, wrangler: w.runner('a'.repeat(32), cloudDir), confirm: fakeConfirm([true, true]).fn, log: () => {} });
    expect(done).toBe(true);
    expect(fs.readFileSync(path.join(home, 'remote', 'dev-b', 'codex', 'archived_sessions', theirs), 'utf8')).toBe('{"b":1}\n');
    expect(fs.existsSync(path.join(home, 'remote', 'dev-a', 'codex', 'sessions', '2026', '10', '26', mine))).toBe(false);
    expect(fs.readFileSync(path.join(home, 'remote', 'dev-a', 'codex', 'sessions', '2026', '10', '26', gone), 'utf8')).toBe('{"c":1}\n');
  });

  it('setup を確認の段で止めて cloud.json が無く下書きだけがあるときも、下書きの Worker、D1、R2 を消し、下書きも消す', async () => {
    const { home, cloudDir } = dirs();
    const conf = v2conf({ workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files' });
    fs.writeFileSync(setupPendingPath(home), JSON.stringify({ v: 1, deviceId: 'dev-a', conf, createdAt: 1 }), { mode: 0o600 });
    const cloudA = new FakeCloudClient({ deviceId: 'dev-a', keyring: Keyring.fromConfig(conf) });
    const w = fakeWrangler({ 'r2 bucket delete': () => ok(), 'delete --name': () => ok(), 'd1 delete': () => ok() });
    const c = fakeConfirm([true, true]);
    const lines: string[] = [];

    const done = await runTeardown({ home, deviceId: 'dev-a', wire: cloudA.wire, wrangler: w.runner('a'.repeat(32), cloudDir), confirm: c.fn, log: (l) => lines.push(l) });
    expect(done).toBe(true);
    expect(c.asked.map((a) => a.word)).toEqual(['hangar', 'delete']);
    expect(w.calls.map((x) => x.args.join(' '))).toEqual(['r2 bucket delete hangar-files', 'delete --name hangar', 'd1 delete hangar -y']);
    expect(fs.existsSync(setupPendingPath(home))).toBe(false);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
    expect(lines.join('\n')).toContain('完了していない setup');
  });

  it('下書きの片付けで残ったものがあれば、下書きを残して止める', async () => {
    const { home, cloudDir } = dirs();
    const conf = v2conf({ workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files' });
    fs.writeFileSync(setupPendingPath(home), JSON.stringify({ v: 1, deviceId: 'dev-a', conf, createdAt: 1 }), { mode: 0o600 });
    const cloudA = new FakeCloudClient({ deviceId: 'dev-a', keyring: Keyring.fromConfig(conf) });
    const w = fakeWrangler({ 'r2 bucket delete': () => ok(), 'delete --name': () => ok() });
    const lines: string[] = [];
    const done = await runTeardown({ home, deviceId: 'dev-a', wire: cloudA.wire, wrangler: w.runner('a'.repeat(32), cloudDir), confirm: fakeConfirm([true, true]).fn, log: (l) => lines.push(l) });
    expect(done).toBe(false);
    expect(fs.existsSync(setupPendingPath(home))).toBe(true);
    expect(lines.join('\n')).toContain(`${setupPendingPath(home)} は削除していません`);
  });

  it('版 2 で開けない本文（手元に鍵の無い世代）があれば、確認も聞かずに消すのをやめる', async () => {
    const { home, cloudDir } = dirs();
    const cfg = v2conf({ workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files' });
    saveCloudConfig(home, cfg);
    // 世代 2 の鍵を持つ PC が上げた本文。この PC の cloud.json には世代 1 しか無い。
    const newer = Keyring.fromConfig(v2conf({ epochs: { '1': K(3), '2': K(9) }, currentEpoch: 2 }));
    const cloudB = new FakeCloudClient({ deviceId: 'dev-b', keyring: newer });
    await cloudB.putText({ path: 'projects/-w-p/u-theirs.jsonl' }, '{"theirs":1}\n');
    const w = fakeWrangler({});
    const c = fakeConfirm([true, true]);
    await expect(
      runTeardown({ home, deviceId: 'dev-a', wire: cloudB.wire.asDevice('dev-a'), wrangler: w.runner('a'.repeat(32), cloudDir), confirm: c.fn, log: () => {} }),
    ).rejects.toThrow(/ダウンロードでき/);
    expect(c.asked).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(loadCloudConfig(home)).not.toBeNull();
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
    saveLegacyCloudConfig(home, legacyConf({ deviceToken: 'dt', workerName: 'hangar-dev', accountId: account, dbName: 'hangar-dev', bucketName: 'hangar-dev-files' }));
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
    const base: LegacyFileEntry = { key: '', path: '', kind: 'config', sha256: 'x', size: 1, mtime: MTIME, encrypted: true, seq: 1, deviceId: 'dev-b', uploadedAt: 1, storedSize: 1 };
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

  it('配布版で packages/cloud が無いときは、存在しないパスを出さずに clone の手順を案内して止まる', () => {
    delete process.env.HANGAR_CLOUD_DIR;
    const gone = path.join(os.tmpdir(), 'hangar-no-such-cloud-' + process.pid, 'cloud');
    let msg = '';
    try {
      requireCloudDir({ dir: gone, version: '0.6.1' });
    } catch (e) {
      expect(e).toBeInstanceOf(DetailedError);
      msg = (e as Error).message;
    }
    expect(msg).not.toBe('');
    // 最上位は DetailedError だけ全文を出す。そうでないと手順が 1 行目で切れる。
    expect(cliErrorText(new DetailedError(msg))).toBe(msg);
    expect(msg).not.toContain(gone);
    expect(msg).not.toContain('src/index.ts');
    expect(msg).toContain('クラウドを作成するには、このリポジトリを clone したディレクトリで実行します');
    expect(msg).toContain('git clone');
    expect(msg).toContain('git checkout v0.6.1');
    expect(msg).toContain('npm ci');
    expect(msg).toContain('npm run hangar -- setup cloud');
  });

  it('案内の手順は、アプリの版が分からないときは git checkout の行を省く', () => {
    const msg = cloudDirMissingMessage(null);
    expect(msg).toContain('git clone');
    expect(msg).not.toContain('git checkout');
    expect(msg).toContain('npm ci');
  });

  it('アプリの版は、cli.mjs の隣の manifest.json から読む。無ければ null', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-manifest-'));
    temps.push(d);
    expect(readAppVersion(d)).toBeNull();
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ version: '0.6.1-rc.2' }));
    expect(readAppVersion(d)).toBe('0.6.1-rc.2');
    fs.writeFileSync(path.join(d, 'manifest.json'), '{壊れた');
    expect(readAppVersion(d)).toBeNull();
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
    expect(out).toContain('参加より前のトランスクリプト');
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
      await expect(installUsageToken({ home, token: 'tok-secret', fetch: cfFetch({ gqlBody }).f, wrangler: w.runner(null, cloudDir), log: () => {} })).rejects.toThrow('権限が足りません: Account Analytics: Read を追加してください');
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
    await expect(offerUsageToken(async () => { throw new Error('権限が足りません: Billing: Read を追加してください'); }, (l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines).toEqual(['権限が足りません: Billing: Read を追加してください', 'あとから、リポジトリを clone して npm install したディレクトリで npm run hangar -- setup cloud --usage-token を実行すると追加し直せます']);
  });
  it('setup の続きで入れられたら、何も足さない', async () => {
    const lines: string[] = [];
    await offerUsageToken(async () => { lines.push('入れました'); }, (l) => lines.push(l));
    expect(lines).toEqual(['入れました']);
  });
  it('案内は権限を二つ挙げる', () => {
    expect(USAGE_TOKEN_HELP.join('\n')).toContain('Account Analytics: Read');
    expect(USAGE_TOKEN_HELP.join('\n')).toContain('Billing: Read');
    // 入れた版の hangar には wrangler が無いので、clone した場所で打つと添える。
    const help = USAGE_TOKEN_HELP.join('\n');
    // ダッシュボードのどこで作るか、どう渡すかを日本語で述べる。op read は使っている人向けの例として添えるだけ。
    expect(help).toContain('Create Token');
    expect(help).toContain('npm run hangar -- setup cloud --usage-token');
    expect(help).toContain('clone したディレクトリ');
    expect(help).toMatch(/1Password を使っている(人|方)/);
    expect(help.indexOf('op read')).toBeGreaterThan(help.indexOf('--usage-token'));
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
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
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
  it('Worker へ出す要求（health の待ち、登録、status）に、この PC の版を載せる', async () => {
    const sent: { url: string; compat: string | undefined }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), compat: (init?.headers as Record<string, string> | undefined)?.[COMPAT_HEADER] });
      if (String(input).endsWith('/bootstrap')) return new Response(JSON.stringify({ deviceId: device.id }), { status: 201 });
      return new Response(JSON.stringify({ ok: true, version: '0.4.0', compat: COMPAT_VERSION }), { status: 200 });
    }) as typeof fetch;
    expect(await waitForHealth('https://h', { fetch: f, sleep: async () => {} })).toBe(true);
    await bootstrapDevice('https://h', 'tok-0123456789abcdef', device.id, { fetch: f, sleep: async () => {} });
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't' }));
    await cloudStatus({ home, fetch: f });
    const toWorker = sent.filter((s) => s.url.startsWith('https://h/'));
    expect(toWorker.map((s) => s.url)).toEqual(['https://h/health', 'https://h/bootstrap', 'https://h/health']);
    for (const s of toWorker) expect(s.compat, s.url).toBe(String(COMPAT_VERSION));
  });

  it('登録を版が古いと断られたら、待たずに hangar を上げるよう伝える', async () => {
    const need = COMPAT_VERSION + 1;
    const f = (async () => new Response(JSON.stringify({ error: 'upgrade required', minCompat: need, compat: need }), { status: 426 })) as typeof fetch;
    const slept: number[] = [];
    const e: Error = await bootstrapDevice('https://h', 't', device.id, { fetch: f, sleep: async (ms) => { slept.push(ms); } }).then(
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
    const e: Error = await bootstrapDevice('https://h', 't', device.id, { fetch: f, sleep: async (ms) => { slept.push(ms); }, timeoutMs: 50 }).then(
      () => { throw new Error('断られるはずが通った'); },
      (x: unknown) => x as Error,
    );
    expect(e.message).toContain('この PC の hangar が古い');
    expect(e.message).toContain('それより新しいバージョン');
    expect(slept).toHaveLength(0);
  }, 2000);

  it('status は、この PC と Worker の互換の版を 1 行で見せる', async () => {
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't' }));
    const health = (body: unknown) => (async (input: string | URL | Request) => {
      if (String(input) === 'https://h/health') return new Response(JSON.stringify(body), { status: 200 });
      throw new TypeError('ECONNREFUSED');
    }) as typeof fetch;
    expect(await cloudStatus({ home, fetch: health({ ok: true, version: '0.5.0', compat: COMPAT_VERSION }) })).toContain(`互換バージョン: この PC ${COMPAT_VERSION}、Worker ${COMPAT_VERSION}`);
    // 版を返さないのは、版番号を入れる前の古い Worker である。
    expect(await cloudStatus({ home, fetch: health({ ok: true, version: '0.4.0' }) })).toContain(`互換バージョン: この PC ${COMPAT_VERSION}、Worker 0`);
    const dead = (async () => { throw new TypeError('ECONNREFUSED'); }) as typeof fetch;
    expect(await cloudStatus({ home, fetch: dead })).toContain(`互換バージョン: この PC ${COMPAT_VERSION}、Worker 不明`);
  });
});

describe('setup cloud の書く wrangler の設定', () => {
  it('互換の日付と旗、D1 と R2 の束縛の名前が、同梱する束縛の定義（packages/cloud/wrangler.jsonc から作る）とそろっている', () => {
    // 片方だけ変えると、wrangler で上げた Worker と、段 5 で同梱の定義から上げる Worker が食い違う。
    const { home } = dirs();
    const file = writeWranglerConfig(home, { name: 'hangar', main: '/x/src/index.ts', dbName: 'hangar', dbId: DB_ID, bucketName: 'hangar-files', assetsDir: '/x/mobile/dist' });
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

  it('呼び鈴（Durable Object）の束縛と migrations を書き、同梱の定義と同じである（既存の束縛は変えない）', () => {
    const { home } = dirs();
    const file = writeWranglerConfig(home, { name: 'hangar', main: '/x/src/index.ts', dbName: 'hangar', dbId: DB_ID, bucketName: 'hangar-files', assetsDir: '/x/mobile/dist' });
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')) as {
      d1_databases: unknown[];
      r2_buckets: unknown[];
      assets: unknown;
      durable_objects: { bindings: { name: string; class_name: string }[] };
      migrations: { tag: string; new_sqlite_classes: string[] }[];
    };
    expect(cfg.durable_objects).toEqual({ bindings: [{ name: 'BELL', class_name: 'HangarBell' }] });
    expect(cfg.migrations).toEqual([{ tag: 'bell-v1', new_sqlite_classes: ['HangarBell'] }]);
    const meta = workerMetadata(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cloud'));
    expect(cfg.durable_objects.bindings.map((b) => b.name)).toEqual(bindingNames(meta, 'durable_object_namespace'));
    expect(cfg.durable_objects.bindings).toEqual(meta.bindings.filter((b) => b.type === 'durable_object_namespace').map((b) => ({ name: b.name, class_name: (b as { class_name: string }).class_name })));
    expect(cfg.migrations).toEqual(meta.migrations);
    expect(cfg.d1_databases).toEqual([{ binding: 'DB', database_name: 'hangar', database_id: DB_ID }]);
    expect(cfg.r2_buckets).toEqual([{ binding: 'BUCKET', bucket_name: 'hangar-files' }]);
    expect(cfg.assets).toEqual({ directory: '/x/mobile/dist' });
  });
});

describe('runSetupCloud のアカウントの選び方', () => {
  /** 資源を作る手順まで通す wrangler。whoami の出力だけを差し替える。 */
  const full = (whoami: Script[string], extra: Script = {}) =>
    fakeWrangler({
      ...extra,
      whoami,
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
  const run = (home: string, cloudDir: string, w: ReturnType<typeof fakeWrangler>, extra: Partial<Parameters<typeof runSetupCloud>[0]> = {}, lines: string[] = []) =>
    runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch(0).fetch, sleep: async () => {}, cloudDir, log: (l) => lines.push(l), env: {}, interactive: false, ...extra });
  const made = (w: ReturnType<typeof fakeWrangler>): string[] => w.calls.map((c) => c.args[0]!).filter((a) => a !== 'whoami');

  it('アカウントが 1 つなら、そのまま使い、作る前に名前を出す', async () => {
    const { home, cloudDir } = dirs();
    const w = full(() => ok(WHOAMI));
    const lines: string[] = [];
    await run(home, cloudDir, w, {}, lines);
    expect(lines.join('\n')).toContain('Acc');
    expect(loadCloudConfig(home)!.accountId).toBe(ACCOUNT);
  });

  it('--json を知らない wrangler なら、表から全部読む', async () => {
    const { home, cloudDir } = dirs();
    const table = ['┌──────────┬──────────────────────────────────┐', '│ Account Name │ Account ID │', '├──────────┼──────────────────────────────────┤', `│ Personal │ ${ACCOUNT} │`, `│ Shared team │ ${ACCOUNT_B} │`, '└──────────┴──────────────────────────────────┘'].join('\n');
    const w = full(() => ok(table), { 'whoami --json': () => ({ code: 1, stdout: '', stderr: '✘ [ERROR] Unknown argument: json' }) });
    // 2 つあって選べないので止まる。表の 1 つ目で上書きしない。
    await expect(run(home, cloudDir, w)).rejects.toThrow(/--account-id/);
    expect(w.calls.map((c) => c.args.join(' '))).toEqual(['whoami --json', 'whoami']);
  });

  it('複数あって対話できないときは、一覧と --account-id を案内して何も作らない', async () => {
    const { home, cloudDir } = dirs();
    const w = full(() => ok(TWO));
    const err = await run(home, cloudDir, w).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('--account-id');
    expect(err!.message).toContain('Personal');
    expect(err!.message).toContain('Shared team');
    expect(err!.message).toContain(ACCOUNT_B);
    expect(made(w)).toEqual([]);
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
  });

  it('複数あって端末なら、一覧から選ばせ、選んだアカウントで作る', async () => {
    const { home, cloudDir } = dirs();
    const w = full(() => ok(TWO));
    let offered: { id: string; name: string }[] = [];
    const lines: string[] = [];
    await run(home, cloudDir, w, { interactive: true, chooseAccount: async (list) => { offered = list; return list[1]!; } }, lines);
    expect(offered.map((a) => a.name)).toEqual(['Personal', 'Shared team']);
    expect(w.calls.filter((c) => c.args[0] !== 'whoami').every((c) => c.env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT_B)).toBe(true);
    expect(loadCloudConfig(home)!.accountId).toBe(ACCOUNT_B);
    expect(lines.join('\n')).toContain('Shared team');
  });

  it('一覧で選ばなければ、何も作らずに止める', async () => {
    const { home, cloudDir } = dirs();
    const w = full(() => ok(TWO));
    await expect(run(home, cloudDir, w, { interactive: true, chooseAccount: async () => null })).rejects.toThrow(/キャンセル/);
    expect(made(w)).toEqual([]);
  });

  it('--account-id があれば、それを使って問わない', async () => {
    const { home, cloudDir } = dirs();
    const w = full(() => ok(TWO));
    await run(home, cloudDir, w, { accountId: ACCOUNT_B.toUpperCase(), chooseAccount: async () => { throw new Error('問うてはいけない'); } });
    expect(loadCloudConfig(home)!.accountId).toBe(ACCOUNT_B);
  });

  it('CLOUDFLARE_ACCOUNT_ID があれば、それを使う', async () => {
    const { home, cloudDir } = dirs();
    const w = full(() => ok(TWO));
    await run(home, cloudDir, w, { env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_B } });
    expect(loadCloudConfig(home)!.accountId).toBe(ACCOUNT_B);
  });

  it('指定したアカウントがログインの一覧に無ければ、何も作らずに止める', async () => {
    const { home, cloudDir } = dirs();
    const w = full(() => ok(TWO));
    const other = '00000000000000000000000000000000';
    await expect(run(home, cloudDir, w, { env: { CLOUDFLARE_ACCOUNT_ID: other } })).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    await expect(run(home, cloudDir, w, { accountId: other })).rejects.toThrow(/--account-id/);
    await expect(run(home, cloudDir, w, { accountId: 'not-an-id' })).rejects.toThrow(/--account-id/);
    expect(made(w)).toEqual([]);
  });

  it('作り直しのときは、cloud.json のアカウントを使って問わない', async () => {
    const { home, cloudDir } = dirs();
    saveCloudConfig(home, conf({ url: 'https://hangar.example.workers.dev', deviceToken: 't', workerName: 'hangar', accountId: ACCOUNT_B, dbName: 'hangar', bucketName: 'hangar-files' }));
    const w = full(() => ok(TWO));
    // Worker の入れ替えなので、登録済みのこの PC の端末トークンで名簿があることを確かめるだけである。
    const ff = fakeFetch(0);
    ff.worker.devices.set(device.id, { tokenHash: sha('t'), revoked: false });
    ff.worker.roster = { version: 1, sealed: 'x' };
    await run(home, cloudDir, w, { fetch: ff.fetch });
    expect(loadCloudConfig(home)!.accountId).toBe(ACCOUNT_B);
  });

  it('作った資源と違うアカウントを指定したら、前の資源が置き去りになることを見せて確認する', async () => {
    const { home, cloudDir } = dirs();
    saveCloudConfig(home, conf({ url: 'https://hangar.example.workers.dev', deviceToken: 't', workerName: 'hangar', accountId: ACCOUNT_B, dbName: 'hangar', bucketName: 'hangar-files' }));
    const w = full(() => ok(TWO));
    const asked: string[] = [];
    const lines: string[] = [];
    await expect(run(home, cloudDir, w, { accountId: ACCOUNT, confirm: async (_q, word) => { asked.push(word); return false; } }, lines)).rejects.toThrow(/キャンセル/);
    expect(asked).toEqual([RENAME_WORD]);
    expect(lines.join('\n')).toContain('削除できなくなります');
    expect(made(w)).toEqual([]);
  });

  it('ログインしても使えるアカウントが無ければ止める', async () => {
    const { home, cloudDir } = dirs();
    const w = full(() => ok(whoamiJson([])));
    await expect(run(home, cloudDir, w)).rejects.toThrow(/アカウント/);
    expect(made(w)).toEqual([]);
  });
});

describe('chooseAccountByNumber', () => {
  const list = [{ id: ACCOUNT, name: 'Personal' }, { id: ACCOUNT_B, name: 'Shared team' }];

  it('名前と ID を番号つきで並べ、打った番号のアカウントを返す', async () => {
    const lines: string[] = [];
    const got = await chooseAccountByNumber(list, async () => '2', (l) => lines.push(l));
    expect(got).toEqual(list[1]);
    const out = lines.join('\n');
    expect(out).toContain(`1. Personal（${ACCOUNT}）`);
    expect(out).toContain(`2. Shared team（${ACCOUNT_B}）`);
  });

  it('空（EOF も）なら選ばない。範囲の外は聞き直し、3 回で諦める', async () => {
    expect(await chooseAccountByNumber(list, async () => '', () => {})).toBeNull();
    const answers = ['9', 'x', '1'];
    expect(await chooseAccountByNumber(list, async () => answers.shift()!, () => {})).toEqual(list[0]);
    let n = 0;
    expect(await chooseAccountByNumber(list, async () => { n++; return '0'; }, () => {})).toBeNull();
    expect(n).toBe(3);
  });
});

describe('runSetupCloud の wrangler の失敗', () => {
  const base = (over: Script): ReturnType<typeof fakeWrangler> =>
    fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ({ code: 1, stdout: '', stderr: 'not found' }),
      'd1 create hangar': () => ok(`database_id = "${DB_ID}"`),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => ok('https://hangar.example.workers.dev'),
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
      ...over,
    });
  const fail = async (w: ReturnType<typeof fakeWrangler>): Promise<Error> => {
    const { home, cloudDir } = dirs();
    const e = await runSetupCloud({ home, device, wrangler: w.runner(null, cloudDir), fetch: fakeFetch(0).fetch, sleep: async () => {}, cloudDir, log: () => {}, env: {}, interactive: false }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(WranglerStepError);
    return e as Error;
  };

  it('R2 が有効でない（10042）なら、wrangler の理由を複数行で出し、有効にしてから再実行するよう添える', async () => {
    // wrangler 4.135 の APIError の形。1 行目は見出しで、理由は後ろの行にある。
    const stderr = [
      `✘ [ERROR] A request to the Cloudflare API (/accounts/${ACCOUNT}/r2/buckets) failed.`,
      '',
      '  Please enable R2 through the Cloudflare Dashboard. [code: 10042]',
      '',
      '  If you think this is a bug, please open an issue at: https://github.com/cloudflare/workers-sdk/issues/new/choose',
    ].join('\n');
    const e = await fail(base({ 'r2 bucket create hangar-files': () => ({ code: 1, stdout: '', stderr }) }));
    const lines = e.message.split('\n');
    expect(lines.length).toBeGreaterThan(2);
    expect(e.message).toContain('[code: 10042]');
    expect(e.message).toContain('R2');
    expect(e.message).toMatch(/有効/);
    expect(e.message).toMatch(/もう一度/);
    // アカウント ID は伏せる。
    expect(e.message).not.toContain(ACCOUNT);
  });

  it('R2 が有効でないアカウントは、D1 を作る前に止まる（何も作らず、有効にしてから再実行するよう案内する）', async () => {
    const stderr = `✘ [ERROR] A request to the Cloudflare API (/accounts/${ACCOUNT}/r2/buckets) failed.\n\n  Please enable R2 through the Cloudflare Dashboard. [code: 10042]\n`;
    const w = base({ 'r2 bucket list': () => ({ code: 1, stdout: '', stderr }) });
    const e = await fail(w);
    expect(e.message).toContain('R2');
    expect(e.message).toContain('[code: 10042]');
    expect(e.message).toMatch(/支払い方法/);
    expect(e.message).toContain('何も作成していません');
    expect(e.message).toMatch(/もう一度/);
    expect(e.message).not.toContain(ACCOUNT);
    const cmds = w.calls.map((c) => c.args.slice(0, 2).join(' '));
    expect(cmds).toContain('r2 bucket');
    expect(cmds).not.toContain('d1 create');
    expect(cmds).not.toContain('d1 info');
    expect(w.calls.some((c) => c.args[0] === 'deploy')).toBe(false);
  });

  it('R2 の確認が 10042 以外で失敗しても、そこでは止めない（あとの手順がそれぞれ理由を出す）', async () => {
    const w = base({ 'r2 bucket list': () => ({ code: 1, stdout: '', stderr: 'network down' }), deploy: () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    const e = await fail(w);
    expect(e.message).toContain('デプロイ');
    expect(w.calls.some((c) => c.args[0] === 'd1' && c.args[1] === 'create')).toBe(true);
  });

  it('workers.dev のサブドメインが無ければ、Workers & Pages で決めてから再実行するよう添える', async () => {
    // 対話が無いと wrangler は登録の問いを「いいえ」で抜け、WARNING と onboarding の URL を添えた UserError を出す。
    const stderr = [
      '▲ [WARNING] You need to register a workers.dev subdomain before publishing to workers.dev',
      '',
      '✘ [ERROR] You can either deploy your worker to one or more routes by specifying them in your wrangler.jsonc file, or register a workers.dev subdomain here:',
      '',
      `  https://dash.cloudflare.com/${ACCOUNT}/workers/onboarding`,
    ].join('\n');
    const e = await fail(base({ deploy: () => ({ code: 1, stdout: 'Total Upload: 120.00 KiB / gzip: 30.00 KiB\nUploaded hangar (2.00 sec)', stderr }) }));
    expect(e.message).toContain('register a workers.dev subdomain');
    expect(e.message).toContain('Workers & Pages');
    expect(e.message).toContain('サブドメイン');
    expect(e.message).toMatch(/もう一度/);
  });

  it('長い出力は 12 行までにし、D1 の作成の失敗も同じ形で出す', async () => {
    const stderr = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const e = await fail(base({ 'd1 create hangar': () => ({ code: 1, stdout: '', stderr }) }));
    expect(e.message).toContain('D1');
    expect(e.message).toContain('line 11');
    expect(e.message).not.toMatch(/line 12\b/);
    expect(e.message).toContain('残り 18 行');
  });

  it('secret put の失敗も同じ形で出す', async () => {
    const e = await fail(base({ 'secret put BOOTSTRAP_TOKEN_HASH': () => ({ code: 1, stdout: '', stderr: '✘ [ERROR] first\n\n  real reason [code: 10000]' }) }));
    expect(e.message).toContain('real reason');
  });
});

describe('cloudStatus の同期が off のとき', () => {
  it('cloud.json があってサーバが off なら、アプリを開き直すよう添える', async () => {
    const { home } = dirs();
    saveCloudConfig(home, conf({ url: 'https://h', deviceToken: 't', workerName: 'hangar', accountId: 'a'.repeat(32), dbName: 'hangar', bucketName: 'hangar-files' }));
    fs.writeFileSync(path.join(home, 'token'), 'local-token');
    const f = (state: string) =>
      (async (input: string | URL | Request) => {
        if (String(input) === 'https://h/health') return new Response(JSON.stringify({ ok: true, version: '0.4.0' }), { status: 200 });
        return new Response(JSON.stringify({ state, pending: 0, lastPullAt: null, lastPushAt: null, deviceCount: 0, url: null, error: null }), { status: 200 });
      }) as typeof fetch;
    expect(await cloudStatus({ home, fetch: f('off') })).toContain('アプリを終了して開き直すと同期が始まります');
    expect(await cloudStatus({ home, fetch: f('idle') })).not.toContain('開き直すと');
  });
});

describe('スマホの画面の配信（wrangler の assets と、配備の前の build）', () => {
  const readCfg = (home: string): { assets?: { directory?: string; run_worker_first?: unknown; not_found_handling?: unknown } } =>
    JSON.parse(fs.readFileSync(path.join(home, 'cloud', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

  it('書いた wrangler.jsonc の assets.directory が mobile の dist を指す（Worker より先に静的ファイルを当てるので run_worker_first は置かない）', () => {
    const { home } = dirs();
    const dist = path.resolve(os.tmpdir(), 'x', 'mobile', 'dist');
    writeWranglerConfig(home, { name: 'hangar', main: '/x/src/index.ts', dbName: 'hangar', dbId: DB_ID, bucketName: 'hangar-files', assetsDir: dist });
    expect(readCfg(home).assets).toEqual({ directory: dist });
  });

  it('配備の前に mobile を build し、dist を assets に渡して deploy する（dist が無くても build が作る）', async () => {
    const { home, cloudDir } = dirs();
    const mobileDir = path.join(cloudDir, '..', 'mobile');
    fs.rmSync(path.join(mobileDir, 'dist'), { recursive: true });
    const events: string[] = [];
    const w = fakeWrangler({
      whoami: () => ok(WHOAMI),
      'd1 info hangar --json': () => ok(JSON.stringify({ uuid: DB_ID })),
      'r2 bucket create hangar-files': () => ok('Created bucket'),
      deploy: () => {
        events.push('deploy');
        return ok('https://hangar.example.workers.dev');
      },
      'secret put BOOTSTRAP_TOKEN_HASH': putBootstrap,
    });
    await runSetupCloud({
      home,
      device,
      wrangler: w.runner(null, cloudDir),
      fetch: fakeFetch(0).fetch,
      sleep: async () => {},
      cloudDir,
      log: () => {},
      skipUsageToken: true,
      buildMobile: async (dir) => {
        events.push(`build ${path.basename(dir)}`);
        fs.mkdirSync(path.join(dir, 'dist', 'app'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'dist', 'app', 'index.html'), '<!doctype html>');
      },
    });
    expect(events).toEqual(['build mobile', 'deploy']);
    expect(readCfg(home).assets?.directory).toBe(path.resolve(mobileDir, 'dist'));
  });

  it('build が済んでも dist/app/index.html が無ければ、資源を作る前に止まる（空の assets を配備しない）', async () => {
    const { home, cloudDir } = dirs();
    fs.rmSync(path.join(cloudDir, '..', 'mobile', 'dist'), { recursive: true });
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    await expect(
      runSetupCloudReal({ home, device, wrangler: w.runner(null, cloudDir), cloudDir, log: () => {}, buildMobile: async () => {} }),
    ).rejects.toThrow(/index\.html/);
    expect(w.calls.some((c) => c.args[0] === 'deploy' || c.args[0] === 'd1')).toBe(false);
  });

  it('mobile の源が cloud の隣に無ければ、clone を案内して止まる', async () => {
    const { home, cloudDir } = dirs();
    fs.rmSync(path.join(cloudDir, '..', 'mobile'), { recursive: true });
    const w = fakeWrangler({ whoami: () => ok(WHOAMI) });
    await expect(runSetupCloudReal({ home, device, wrangler: w.runner(null, cloudDir), cloudDir, log: () => {} })).rejects.toThrow(/mobile/);
    expect(w.calls).toEqual([]);
  });

  it('buildMobileApp は node で vite の build を mobile の中で走らせる（シェルを通さない。Windows でも同じ）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mobile-'));
    temps.push(root);
    const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    await buildMobileApp(root, {
      resolveVite: () => vite,
      exec: async (cmd, args, o) => {
        calls.push({ cmd, args, cwd: o.cwd });
        return ok();
      },
    });
    expect(calls).toEqual([{ cmd: process.execPath, args: [vite, 'build'], cwd: root }]);
    await expect(
      buildMobileApp(root, { resolveVite: () => 'vite.js', exec: async () => ({ code: 1, stdout: '', stderr: 'boom' }) }),
    ).rejects.toThrow(/boom/);
  });
});

describe('古い形式の cloud.json の案内', () => {
  it('Worker を作成した PC には teardown してから setup を、参加しただけの PC には上書きして参加を案内する', () => {
    const { home } = dirs();
    saveLegacyCloudConfig(home, legacyConf({ workerName: 'hangar-old', accountId: 'a'.repeat(32), dbName: 'hangar-old', bucketName: 'hangar-old-files' }));
    const creator = legacyConfigMessage(home);
    expect(creator).toContain('npm run hangar -- cloud teardown');
    expect(creator).toContain('hangar-old');
    expect(creator).toContain('npm run hangar -- setup cloud');
    saveLegacyCloudConfig(home, legacyConf());
    const member = legacyConfigMessage(home);
    expect(member).not.toContain('teardown');
    expect(member).not.toContain('削除してから');
    expect(member).toContain('上書きして参加');
    expect(member).toContain('hangar cloud join');
  });
});
