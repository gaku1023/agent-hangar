import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 既にある p12 を手元の専用のキーチェーンへ取り込む台本（import-signing-cert.sh）の試験。
 * 作り直すと別の証明書になって全員の許可が外れるので、指紋がリポジトリの値と違えば取り込まないことを確かめる。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '../scripts/import-signing-cert.sh');
const MAKE_CERT = path.resolve(here, '../scripts/make-signing-cert.sh');
const repoRoot = path.resolve(here, '../../..');
const PW = 'test-only-password';
const posix = process.platform !== 'win32';
const onMac = process.platform === 'darwin';

const dirs: string[] = [];
const tmp = (p: string, base: string = os.tmpdir()): string => {
  const d = fs.mkdtempSync(path.join(base, p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}): { status: number; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', HANGAR_SIGN_P12_PASSWORD: PW, ...env },
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function makeCert(out: string): { p12: string; fingerprintFile: string; fingerprint: string } {
  const r = spawnSync('bash', [MAKE_CERT, '--out', out], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', HANGAR_SIGN_P12_PASSWORD: PW },
  });
  if (r.status !== 0) throw new Error(`${r.stdout}${r.stderr}`);
  const fingerprintFile = path.join(out, 'certificate-sha1.txt');
  return { p12: path.join(out, 'hangar-signing.p12'), fingerprintFile, fingerprint: fs.readFileSync(fingerprintFile, 'utf8').trim() };
}

describe.skipIf(!posix)('証明書を取り込む台本（引数の検査）', () => {
  it('--p12 か --keychain が無ければ断る', () => {
    const d = tmp('hangar-import-args-');
    expect(run(['--keychain', path.join(d, 'k.keychain-db')]).status).not.toBe(0);
    expect(run(['--p12', path.join(d, 'x.p12')]).status).not.toBe(0);
  });
  it('パスワードを引数に取らない（--password は知らない引数）', () => {
    const d = tmp('hangar-import-pwarg-');
    expect(run(['--p12', path.join(d, 'x.p12'), '--keychain', path.join(d, 'k'), '--password', 'x']).status).not.toBe(0);
  });
  it('p12 がリポジトリの中にあれば断る（秘密鍵を commit しない）', () => {
    const d = tmp('hangar-import-in-repo-', repoRoot);
    const p12 = path.join(d, 'x.p12');
    fs.writeFileSync(p12, 'not a real p12');
    const r = run(['--p12', p12, '--keychain', path.join(os.tmpdir(), 'hangar-import-never.keychain-db')]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/リポジトリの中/);
  });
  it('キーチェーンが既にあれば断る（上書きしない）', () => {
    const d = tmp('hangar-import-exists-');
    const p12 = path.join(d, 'x.p12');
    const kc = path.join(d, 'k.keychain-db');
    fs.writeFileSync(p12, 'x');
    fs.writeFileSync(kc, 'x');
    const r = run(['--p12', p12, '--keychain', kc]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/既にある/);
  });
});

describe.skipIf(!onMac)('証明書を取り込む台本（実際のキーチェーン）', () => {
  it('指紋がリポジトリの値と一致する p12 だけを、新しいキーチェーンへ取り込む', () => {
    const d = tmp('hangar-import-real-');
    const { p12, fingerprintFile, fingerprint } = makeCert(path.join(d, 'out'));
    const kc = path.join(d, 'test.keychain-db');
    try {
      const r = run(['--p12', p12, '--keychain', kc], { HANGAR_SIGN_FINGERPRINT_FILE: fingerprintFile });
      expect(r.status, r.out).toBe(0);
      expect(fs.existsSync(kc)).toBe(true);
      const certs = spawnSync('security', ['find-certificate', '-a', '-Z', kc], { encoding: 'utf8' }).stdout;
      expect(certs.toLowerCase()).toContain(fingerprint);
      // 秘密鍵も入っている
      const ids = spawnSync('security', ['find-identity', kc], { encoding: 'utf8' });
      expect(`${ids.stdout}${ids.stderr}`).toMatch(/1 identities found|1 valid identities found/);
      // p12 は消さない
      expect(fs.existsSync(p12)).toBe(true);
    } finally {
      spawnSync('security', ['delete-keychain', kc]);
    }
  });
  it('指紋がリポジトリの値と違えば、キーチェーンを作らずに止まる（別の証明書で署名すると全員の許可が外れる）', () => {
    const d = tmp('hangar-import-mismatch-');
    const { p12 } = makeCert(path.join(d, 'out'));
    const other = path.join(d, 'other-sha1.txt');
    fs.writeFileSync(other, `${'0'.repeat(40)}\n`);
    const kc = path.join(d, 'test.keychain-db');
    const r = run(['--p12', p12, '--keychain', kc], { HANGAR_SIGN_FINGERPRINT_FILE: other });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/指紋がリポジトリの値と違う/);
    expect(fs.existsSync(kc)).toBe(false);
  });
  it('パスワードが違えば、キーチェーンを作らずに止まる', () => {
    const d = tmp('hangar-import-badpw-');
    const { p12, fingerprintFile } = makeCert(path.join(d, 'out'));
    const kc = path.join(d, 'test.keychain-db');
    const r = run(['--p12', p12, '--keychain', kc], { HANGAR_SIGN_FINGERPRINT_FILE: fingerprintFile, HANGAR_SIGN_P12_PASSWORD: 'wrong' });
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(kc)).toBe(false);
  });
});
