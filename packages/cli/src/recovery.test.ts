import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CloudConfig, loadCloudConfig, saveCloudConfig } from '@agent-hangar/server';
import {
  decodeEpochList,
  deriveEpochKeys,
  encodeEpochList,
  formatRecoveryKey,
  fromBase64Url,
  generateKeyPair,
  importPrivate,
  openKeybox,
  openRoster,
  openRow,
  RECOVERY_RECIPIENT,
  recoverySecretTail,
  sealKeybox,
  sealRow,
  toBase64Url,
  type KeyPairRaw,
} from '@agent-hangar/shared';
import { HttpCloudClient } from '../../server/src/sync/client.ts';
import { Keyring } from '../../server/src/sync/keyring.ts';
import { RecoveryKeyReissuer, RecoveryDraftError } from '../../server/src/sync/recoveryReissue.ts';
import { RosterStore, type ConfigWriter } from '../../server/src/sync/roster.ts';
import { expectMode } from '../../server/test/platform.ts';
import { FakeWorker } from '../test/fakeWorker.ts';
import { recoverPendingPath, RecoveryKeyNotConfirmedError, runRecover, showAndConfirmRecoveryKey } from './recovery.ts';
import type { Exec, ExecResult } from './wrangler.ts';
import { WranglerRunner } from './wrangler.ts';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const URL_ = 'https://hangar.example.workers.dev';
const TOKEN_A = 'token-of-pc-a-0123456789abcdef0123456789';
const WHOAMI = JSON.stringify({ loggedIn: true, authType: 'OAuth Token', accounts: [{ id: ACCOUNT, name: 'Acc' }], tokenPermissions: [] }, null, 4);

const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}

const SAMPLE = formatRecoveryKey({ priv: Buffer.alloc(32, 7).toString('base64url'), url: URL_, createdAt: Date.UTC(2026, 9, 17) });

describe('showAndConfirmRecoveryKey（表示と末尾 4 文字の確認）', () => {
  const answers = (list: string[]) => {
    const asked: string[] = [];
    let i = 0;
    return { asked, ask: async (q: string) => { asked.push(q); return list[i++] ?? ''; } };
  };

  it('表示し、末尾 4 文字が合うまで聞き直し、合ったら端末の表示を消す', async () => {
    const out: string[] = [];
    const a = answers(['ABCD', ` ${recoverySecretTail(SAMPLE).toLowerCase()} `]);
    await showAndConfirmRecoveryKey({ text: SAMPLE, ask: a.ask, write: (s) => out.push(s), isTTY: true });
    expect(a.asked).toHaveLength(2);
    expect(out.join('')).toContain(SAMPLE.split('\n')[3]);
    expect(out.at(-1)).toContain('\x1b[2J');
  });

  it('端末でなければ表示を消す制御文字を出さない', async () => {
    const out: string[] = [];
    await showAndConfirmRecoveryKey({ text: SAMPLE, ask: answers([recoverySecretTail(SAMPLE)]).ask, write: (s) => out.push(s), isTTY: false });
    expect(out.join('')).not.toContain('\x1b[');
  });

  it('3 回外れたら表示し直す', async () => {
    const out: string[] = [];
    const a = answers(['AAAA', 'BBBB', 'CCCC', recoverySecretTail(SAMPLE)]);
    await showAndConfirmRecoveryKey({ text: SAMPLE, ask: a.ask, write: (s) => out.push(s), isTTY: false });
    const secretLine = SAMPLE.split('\n')[3]!;
    expect(out.join('').split(secretLine).length - 1).toBe(2);
  });

  it('空を返し続けると、確認できなかったとして投げる（終わったことにしない）', async () => {
    const a = answers([]);
    await expect(showAndConfirmRecoveryKey({ text: SAMPLE, ask: a.ask, write: () => {}, isTTY: false })).rejects.toBeInstanceOf(RecoveryKeyNotConfirmedError);
    expect(a.asked.length).toBe(9);
  });

  it('--save のファイルは 0600 で、4 行がそのまま入る', async () => {
    const file = path.join(tmp('hangar-rk-'), 'recovery.txt');
    await showAndConfirmRecoveryKey({ text: SAMPLE, ask: answers([recoverySecretTail(SAMPLE)]).ask, write: () => {}, saveTo: file, isTTY: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(`${SAMPLE}\n`);
    expectMode(file, 0o600);
  });

  it('既にあるファイルにも 0600 で書く', async () => {
    const file = path.join(tmp('hangar-rk-'), 'recovery.txt');
    fs.writeFileSync(file, 'old', { mode: 0o644 });
    await showAndConfirmRecoveryKey({ text: SAMPLE, ask: answers([recoverySecretTail(SAMPLE)]).ask, write: () => {}, saveTo: file, isTTY: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(`${SAMPLE}\n`);
    expectMode(file, 0o600);
  });
});

/** 世代 1 と 2 があり、pc-a が参加しているクラウド。recovery 宛ての keybox は世代ごとに置いてある。 */
type Cloud = {
  worker: FakeWorker;
  recovery: KeyPairRaw;
  text: string;
  epochs: Record<string, string>;
  confA: () => CloudConfig;
  roster: RosterStore;
  keyring: Keyring;
  wire: HttpCloudClient;
};

async function cloud(o: { rosterRecoveryPub?: string } = {}): Promise<Cloud> {
  const worker = new FakeWorker();
  worker.devices.set('pc-a', { tokenHash: sha(TOKEN_A), revoked: false });
  const pairA = await generateKeyPair();
  const recovery = await generateKeyPair();
  const epochs = { '1': Buffer.alloc(32, 1).toString('base64url'), '2': Buffer.alloc(32, 2).toString('base64url') };
  let cfg: CloudConfig = {
    v: 2, url: URL_, cloudId: worker.cloudId, deviceToken: TOKEN_A, keyPair: pairA, epochs, currentEpoch: 2, phoneKey: null, rosterVersion: 0,
    workerName: 'hangar', accountId: ACCOUNT, dbName: 'hangar', bucketName: 'hangar-files', joinedAt: 1,
  };
  const writer: ConfigWriter = { read: () => cfg, write: (p) => { cfg = { ...cfg, ...p }; } };
  const wire = new HttpCloudClient({ url: URL_, token: TOKEN_A, fetch: worker.fetch });
  const keyring = await Keyring.fromConfig(cfg);
  const roster = new RosterStore(wire, keyring, writer, 'pc-a');
  await roster.update(() => ({ v: 1, entries: [{ id: 'pc-a', kind: 'pc', name: 'pc-a', os: 'darwin', pub: pairA.pub, joinedAt: 1 }], recoveryPub: o.rosterRecoveryPub ?? recovery.pub, phoneKey: null }));
  // 世代 1 の箱は世代 1 だけ、世代 2 の箱は世代 1 と 2 を持つ（解除で世代を回したときの形）。
  for (const [epoch, list] of [[1, { '1': epochs['1'] }], [2, epochs]] as const) {
    worker.putBox({ epoch, recipient: RECOVERY_RECIPIENT, sealed: toBase64Url(await sealKeybox(recovery.pub, { epoch, recipient: RECOVERY_RECIPIENT }, encodeEpochList({ epochs: list }))) });
  }
  const text = formatRecoveryKey({ priv: recovery.priv, url: URL_, createdAt: 1 });
  return { worker, recovery, text, epochs, confA: () => cfg, roster, keyring, wire };
}

/** wrangler の偽物。secret put は標準入力のハッシュを偽の Worker に入れる。 */
function wrangler(worker: FakeWorker, cloudDir: string) {
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, args, o) => {
    const w = args.findIndex((a) => a.endsWith('wrangler.js'));
    const rest = w >= 0 ? args.slice(w + 1) : args;
    calls.push(rest);
    const line = rest.join(' ');
    if (line.startsWith('whoami')) return ok(WHOAMI);
    if (line.startsWith('secret put BOOTSTRAP_TOKEN_HASH')) {
      expect(o.input).toMatch(/^[0-9a-f]{64}\n$/);
      worker.bootstrapHash = o.input!.trim();
      return ok('Success');
    }
    return { code: 1, stdout: '', stderr: `unexpected: ${line}` };
  };
  return { calls, runner: new WranglerRunner({ cloudDir, accountId: null, exec, interactive: async () => 0 }) };
}

function newPc(id: string) {
  const root = tmp('hangar-recover-');
  const home = path.join(root, 'home');
  const cloudDir = path.join(root, 'cloud');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cloudDir, { recursive: true });
  return { home, cloudDir, device: { id, name: id, platform: 'linux' } };
}

async function recover(c: Cloud, pc: ReturnType<typeof newPc>, text: string) {
  const w = wrangler(c.worker, pc.cloudDir);
  const r = await runRecover({ home: pc.home, device: pc.device, text, wrangler: w.runner, cloudDir: pc.cloudDir, fetch: c.worker.fetch, sleep: async () => {}, log: () => {}, env: {} });
  return { r, calls: w.calls };
}

describe('hangar recover', () => {
  it('新しい PC が過去の世代の行を開け、名簿に自分を足し、自分宛ての keybox を置く', async () => {
    const c = await cloud();
    // 世代 1 で封じた行（世代を回す前に書かれたもの）。
    const k1 = await deriveEpochKeys(1, c.epochs['1']!);
    const aad = { k: 'sessions:s1', deviceId: 'pc-a', updatedAt: 5, op: 'upsert' as const, epoch: 1 };
    const row = await sealRow(k1.row, aad, { tableName: 'sessions', rowId: 's1', payload: { title: 't' } });

    const pc = newPc('pc-b');
    const { r, calls } = await recover(c, pc, c.text);
    expect(r.url).toBe(URL_);
    expect(calls).toContainEqual(['secret', 'put', 'BOOTSTRAP_TOKEN_HASH', '--name', 'hangar']);

    const conf = loadCloudConfig(pc.home)!;
    expect(conf.url).toBe(URL_);
    expect(conf.epochs).toEqual(c.epochs);
    expect(conf.currentEpoch).toBe(2);
    expect(conf.workerName).toBe('hangar');
    expect(conf.accountId).toBe(ACCOUNT);
    expect(c.worker.devices.get('pc-b')?.tokenHash).toBe(sha(conf.deviceToken));
    // 過去の世代の行が開ける。
    const mine1 = await deriveEpochKeys(1, conf.epochs['1']!);
    expect((await openRow(mine1.row, aad, row)).rowId).toBe('s1');

    // 名簿に pc-b が足され、リカバリーキーの公開鍵は変わらない。
    const k2 = await deriveEpochKeys(2, c.epochs['2']!);
    const roster = await openRoster(k2.roster, c.worker.roster!.version, fromBase64Url(c.worker.roster!.sealed)!);
    expect(roster.entries.map((e) => e.id)).toEqual(['pc-a', 'pc-b']);
    expect(roster.entries[1]!.pub).toBe(conf.keyPair.pub);
    expect(roster.recoveryPub).toBe(c.recovery.pub);
    expect(conf.rosterVersion).toBe(c.worker.roster!.version);
    // 自分宛ての keybox は世代 2 に、世代 1 と 2 の一覧で置く。
    const box = c.worker.keyboxes.get('pc-b:2')!;
    const list = decodeEpochList(await openKeybox(await importPrivate(conf.keyPair.priv), conf.keyPair.pub, { epoch: 2, recipient: 'pc-b' }, fromBase64Url(box.sealed)!));
    expect(list.epochs).toEqual(c.epochs);
    // 下書きは消え、cloud.json は 0600。
    expect(fs.existsSync(recoverPendingPath(pc.home))).toBe(false);
  });

  it('名簿の recoveryPub と違うリカバリーキーは断り、名簿も cloud.json も書かない', async () => {
    const other = await generateKeyPair();
    const c = await cloud({ rosterRecoveryPub: other.pub });
    const before = { ...c.worker.roster! };
    const pc = newPc('pc-b');
    await expect(recover(c, pc, c.text)).rejects.toThrow(/リカバリーキー/);
    expect(c.worker.roster).toEqual(before);
    expect(c.worker.keyboxes.has('pc-b:2')).toBe(false);
    expect(loadCloudConfig(pc.home)).toBeNull();
  });

  it('開けないリカバリーキーは断り、正しいキーでもう一度実行すれば同じ端末トークンで続ける', async () => {
    const c = await cloud();
    const wrong = formatRecoveryKey({ priv: (await generateKeyPair()).priv, url: URL_, createdAt: 1 });
    const pc = newPc('pc-b');
    await expect(recover(c, pc, wrong)).rejects.toThrow(/リカバリーキー/);
    expect(loadCloudConfig(pc.home)).toBeNull();
    expect(fs.existsSync(recoverPendingPath(pc.home))).toBe(true);
    expectMode(recoverPendingPath(pc.home), 0o600);
    const bootstraps = c.worker.calls.filter((x) => x === 'POST /bootstrap').length;

    const { calls } = await recover(c, pc, c.text);
    // 2 回目は secret put も bootstrap もしない（同じ端末 ID は 2 度 bootstrap できない）。
    expect(calls.some((a) => a[0] === 'secret')).toBe(false);
    expect(c.worker.calls.filter((x) => x === 'POST /bootstrap').length).toBe(bootstraps);
    expect(loadCloudConfig(pc.home)!.epochs).toEqual(c.epochs);
  });

  it('参加済みの PC では実行しない', async () => {
    const c = await cloud();
    const pc = newPc('pc-b');
    saveCloudConfig(pc.home, { ...c.confA(), deviceToken: 'x' });
    await expect(recover(c, pc, c.text)).rejects.toThrow(/参加しています/);
    expect(c.worker.calls).not.toContain('POST /bootstrap');
  });

  it('読めないリカバリーキーは Worker にも wrangler にも触らずに断る', async () => {
    const c = await cloud();
    const pc = newPc('pc-b');
    const w = wrangler(c.worker, pc.cloudDir);
    const before = c.worker.calls.length;
    await expect(runRecover({ home: pc.home, device: pc.device, text: 'hangar リカバリーキー\nURL: https://x', wrangler: w.runner, cloudDir: pc.cloudDir, fetch: c.worker.fetch, sleep: async () => {}, log: () => {}, env: {} })).rejects.toThrow();
    expect(w.calls).toEqual([]);
    expect(c.worker.calls.length).toBe(before);
  });
});

describe('リカバリーキーの再発行（サーバーの RecoveryKeyReissuer）', () => {
  it('確認の前なら古いリカバリーキーが使え、確認の後は古いものが断られ、新しいものが使える', async () => {
    const c = await cloud();
    const reissuer = new RecoveryKeyReissuer({ roster: c.roster, keyring: c.keyring, wire: c.wire, url: () => URL_ });
    const draft = await reissuer.reissue();
    expect(draft.text).not.toBe(c.text);
    expect(draft.text.split('\n')[2]).toBe(`URL: ${URL_}`);

    // 確認の前：名簿も keybox も変わっていないので、古いキーで recover できる。
    await recover(c, newPc('pc-b'), c.text);

    // 末尾 4 文字が違えば何も変えない。
    const rosterBefore = { ...c.worker.roster! };
    await expect(reissuer.confirm(draft.draftId, 'ZZZZ' === recoverySecretTail(draft.text) ? 'YYYY' : 'ZZZZ')).rejects.toMatchObject({ reason: 'tail-mismatch' });
    expect(c.worker.roster).toEqual(rosterBefore);

    await reissuer.confirm(draft.draftId, recoverySecretTail(draft.text).toLowerCase());
    const k2 = await deriveEpochKeys(2, c.epochs['2']!);
    const roster = await openRoster(k2.roster, c.worker.roster!.version, fromBase64Url(c.worker.roster!.sealed)!);
    expect(roster.recoveryPub).not.toBe(c.recovery.pub);
    // 名簿の他の項目は残る。
    expect(roster.entries.map((e) => e.id)).toEqual(['pc-a', 'pc-b']);

    // 確認の後：古いキーは断られ、新しいキーで recover できる。
    await expect(recover(c, newPc('pc-c'), c.text)).rejects.toThrow(/リカバリーキー/);
    const pd = newPc('pc-d');
    await recover(c, pd, draft.text);
    expect(loadCloudConfig(pd.home)!.epochs).toEqual(c.epochs);

    // 確認の済んだ下書きは 2 度使えない。
    await expect(reissuer.confirm(draft.draftId, recoverySecretTail(draft.text))).rejects.toBeInstanceOf(RecoveryDraftError);
  });

  it('新しく再発行すると前の下書きは使えない', async () => {
    const c = await cloud();
    const reissuer = new RecoveryKeyReissuer({ roster: c.roster, keyring: c.keyring, wire: c.wire, url: () => URL_ });
    const first = await reissuer.reissue();
    await reissuer.reissue();
    await expect(reissuer.confirm(first.draftId, recoverySecretTail(first.text))).rejects.toMatchObject({ reason: 'no-draft' });
  });

  it('下書きは期限を過ぎると使えない', async () => {
    const c = await cloud();
    let now = 1_000;
    const reissuer = new RecoveryKeyReissuer({ roster: c.roster, keyring: c.keyring, wire: c.wire, url: () => URL_, now: () => now });
    const d = await reissuer.reissue();
    now += 31 * 60_000;
    await expect(reissuer.confirm(d.draftId, recoverySecretTail(d.text))).rejects.toMatchObject({ reason: 'no-draft' });
  });
});
