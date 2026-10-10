import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDisplay, readFingerprintFile } from '../scripts/sign-macos.ts';

/**
 * release.yml の macOS のジョブが使う署名の台本（ci-sign-macos.sh）の試験。
 * secret が無いときは警告だけで未署名のまま通し、あるときは一時のキーチェーンで署名して、指紋がリポジトリの値と一致することを確かめる。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '../scripts/ci-sign-macos.sh');
const MAKE_CERT = path.resolve(here, '../scripts/make-signing-cert.sh');
const ID = 'dev.agent-hangar.hangar';
const PW = 'test-only-password';

const posix = process.platform !== 'win32';
const MACHO_SRC = '/bin/echo';
const onMac = process.platform === 'darwin' && fs.existsSync(MACHO_SRC);

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeApp(root: string): string {
  const app = path.join(root, 'T.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources/server'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.example.fixture</string>
<key>CFBundleExecutable</key><string>T</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  fs.writeFileSync(path.join(app, 'Contents/Resources/server/server.mjs'), 'console.log(1)\n');
  if (onMac) fs.copyFileSync(MACHO_SRC, path.join(app, 'Contents/MacOS/T'));
  else fs.writeFileSync(path.join(app, 'Contents/MacOS/T'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  return app;
}

/** 台本を、呼び手の環境を持ち込まずに走らせる。CI の印（GitHub Actions のもの）は試験の側で選んで渡す。 */
function run(args: string[], env: Record<string, string> = {}): { status: number; out: string } {
  const pass: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  for (const k of ['CI', 'GITHUB_ACTIONS', 'RUNNER_TEMP', 'TMPDIR']) {
    const v = process.env[k];
    if (v !== undefined) pass[k] = v;
  }
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...pass, ...env } });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function fingerprintFile(dir: string, value: string): string {
  const f = path.join(dir, 'certificate-sha1.txt');
  fs.writeFileSync(f, `# 試験の指紋\n${value}\n`);
  return f;
}

function userKeychains(): string {
  return spawnSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' }).stdout;
}

describe.skipIf(!posix)('CI の署名の台本（secret の有無）', () => {
  it('secret が 2 つとも無ければ、警告を出して未署名のまま 0 で終わる', () => {
    const d = tmp('hangar-ci-sign-none-');
    const app = makeApp(d);
    const r = run([app]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('::warning');
    expect(r.out).toMatch(/未署名/);
    if (onMac) {
      const info = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' });
      expect(parseDisplay(info.stderr).identifier).not.toBe(ID);
    }
  });
  it('secret が片方だけなら、設定の誤りとして止まる', () => {
    const d = tmp('hangar-ci-sign-half-');
    const app = makeApp(d);
    expect(run([app], { HANGAR_SIGN_P12_BASE64: 'AAAA' }).status).not.toBe(0);
    expect(run([app], { HANGAR_SIGN_P12_PASSWORD: PW }).status).not.toBe(0);
  });
  it('secret があるのに、リポジトリに指紋が無ければ止まる（確かめられないまま配らない）', () => {
    const d = tmp('hangar-ci-sign-nofp-');
    const app = makeApp(d);
    const f = path.join(d, 'empty.txt');
    fs.writeFileSync(f, '# 値は空\n');
    const r = run([app], { HANGAR_SIGN_P12_BASE64: 'AAAA', HANGAR_SIGN_P12_PASSWORD: PW, HANGAR_SIGN_FINGERPRINT_FILE: f });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/指紋/);
  });
  it('app が無ければ止まる', () => {
    expect(run([]).status).not.toBe(0);
  });
});

describe.skipIf(!onMac)('CI の署名の台本（試しの証明書で実際に署名する）', () => {
  const makeCert = (dir: string): { b64: string; fp: string } => {
    const out = path.join(dir, 'cert');
    const r = spawnSync('bash', [MAKE_CERT, '--out', out], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', HANGAR_SIGN_P12_PASSWORD: PW },
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    return { b64: fs.readFileSync(path.join(out, 'hangar-signing.p12')).toString('base64'), fp: readFingerprintFile(path.join(out, 'certificate-sha1.txt'))! };
  };

  it('p12 の指紋がリポジトリの値と違えば、署名せずに止まり、キーチェーンを残さない', () => {
    const d = tmp('hangar-ci-sign-mismatch-');
    const { b64 } = makeCert(d);
    const app = makeApp(d);
    const before = userKeychains();
    const r = run([app], { HANGAR_SIGN_P12_BASE64: b64, HANGAR_SIGN_P12_PASSWORD: PW, HANGAR_SIGN_FINGERPRINT_FILE: fingerprintFile(d, 'f'.repeat(40)) });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/指紋/);
    expect(r.out).not.toContain(PW);
    expect(userKeychains()).toBe(before);
  });

  it('指紋が一致すれば署名し、識別子と DR が固定され、キーチェーンを残さない', () => {
    const d = tmp('hangar-ci-sign-ok-');
    const { b64, fp } = makeCert(d);
    const app = makeApp(d);
    const before = userKeychains();
    const r = run([app], { HANGAR_SIGN_P12_BASE64: b64, HANGAR_SIGN_P12_PASSWORD: PW, HANGAR_SIGN_FINGERPRINT_FILE: fingerprintFile(d, fp) });
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain(PW);
    const info = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' });
    expect(parseDisplay(info.stderr).identifier).toBe(ID);
    const dr = spawnSync('codesign', ['-d', '-r-', app], { encoding: 'utf8' });
    expect(`${dr.stdout}${dr.stderr}`).toContain(`designated => certificate leaf = H"${fp}"`);
    expect(spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status).toBe(0);
    expect(userKeychains()).toBe(before);
  });
});
