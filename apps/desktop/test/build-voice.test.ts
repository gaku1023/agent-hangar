import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 補助 hangar-voice を .app に入れる束（apps/desktop/voice-dist/）の作り方と、それを呼ぶ道の試験。
 * 補助そのものの build（xcodebuild と Metal Toolchain）はここでは回さない。手元の build-mac-local と release の macos ジョブが通す。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const root = path.resolve(app, '../..');
const script = path.join(app, 'scripts/build-voice.sh');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** ワークフローの 1 ジョブの本文（`  <名前>:` から次のジョブの頭まで）。 */
function job(yml: string, name: string): string {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `${name} のジョブが無い`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z][a-z0-9-]*:$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('build-voice.sh', () => {
  it.skipIf(process.platform === 'win32')('HANGAR_SKIP_VOICE=1 なら補助を作らず、前の中身を消して README だけの束を置く', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-voice-dist-'));
    dirs.push(out);
    fs.writeFileSync(path.join(out, 'hangar-voice'), 'old');
    fs.mkdirSync(path.join(out, 'old.bundle'));
    const r = spawnSync('bash', [script, out], { encoding: 'utf8', env: { ...process.env, HANGAR_SKIP_VOICE: '1' } });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(out)).toEqual(['README.md']);
    // チェックアウトに置く README と同じ中身にする（cargo build が resources の在りかを見るので、束は空にできない）。
    expect(fs.readFileSync(path.join(out, 'README.md'), 'utf8')).toBe(fs.readFileSync(path.join(app, 'voice-dist/README.md'), 'utf8'));
  });
});

describe('補助を作る道', () => {
  it('チェックアウトの voice-dist は README だけを持ち、作った物は git に入らない', () => {
    expect(fs.existsSync(path.join(app, 'voice-dist/README.md'))).toBe(true);
    const ignore = read('.gitignore');
    expect(ignore).toContain('apps/desktop/voice-dist/*');
    expect(ignore).toContain('!apps/desktop/voice-dist/README.md');
  });
  // CI の .app の試験は補助を使わないので、Metal Toolchain と xcodebuild の時間を払わない。
  it('ci の .app を作るジョブは補助を作らず、voice-mac ジョブが Release の build まで通す', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const name of ['desktop', 'desktop-update']) expect(job(ci, name)).toMatch(/HANGAR_SKIP_VOICE: '1'/);
    const voice = job(ci, 'voice-mac');
    expect(voice).toContain('xcodebuild -downloadComponent MetalToolchain');
    expect(voice).toContain('bash apps/voice-mac/scripts/build.sh');
  });
  // MLX をゼロから作ると試験と build で 1 回ずつ、合わせて 8〜19 分かかり、CI の律速になっていた（2026-11-17）。
  it('voice-mac ジョブは芯の試験を MLX の無いパッケージで回し、MLX の build は main が保存したキャッシュから続ける', () => {
    const ci = read('.github/workflows/ci.yml');
    const voice = job(ci, 'voice-mac');
    expect(voice).toContain('swift test --package-path apps/voice-mac/Core');
    expect(voice).not.toMatch(/swift test --package-path apps\/voice-mac(\s|$)/);
    // PR では変わったときだけ build する。ジョブごと飛ばすと必須のチェックが来なくなるので、段に if を付ける。
    expect(voice).not.toMatch(/^ {4}if:/m);
    expect(voice).toMatch(/- run: bash apps\/voice-mac\/scripts\/build\.sh\n\s+if: steps\.changed\.outputs\.build == 'true'/);
    // 保存は main の push だけ。
    expect(voice).toMatch(/actions\/cache\/save@\S+\n\s+if: github\.event_name == 'push'/);
    expect(voice).not.toMatch(/actions\/cache@/);
    const pkg = fs.readFileSync(path.join(root, 'apps/voice-mac/Package.swift'), 'utf8');
    expect(pkg).not.toContain('testTarget');
  });
  it('release の macos ジョブは、ci と同じ鍵と場所で声の補助のキャッシュを戻すだけにする', () => {
    const voice = job(read('.github/workflows/ci.yml'), 'voice-mac');
    const mac = job(read('.github/workflows/release.yml'), 'macos');
    const keyOf = (s: string) => s.match(/key=(voice-mac-cas-.+?)" >>/)?.[1];
    const pathOf = (s: string) => s.match(/actions\/cache\/restore@\S+\n(?:.*\n)*?\s+path: (\S+)/)?.[1];
    expect(keyOf(mac)).toBeDefined();
    expect(keyOf(mac)).toBe(keyOf(voice));
    expect(pathOf(mac)).toBe('~/Library/Caches/agent-hangar/voice-mac-xcode');
    expect(pathOf(mac)).toBe(pathOf(voice));
    expect(mac).not.toMatch(/actions\/cache(\/save)?@/);
    // build.sh の既定の置き場と同じ場所（env で渡さずに当たる）。
    const build = fs.readFileSync(path.join(root, 'apps/voice-mac/scripts/build.sh'), 'utf8');
    expect(build).toContain('$HOME/Library/Caches/agent-hangar/voice-mac-xcode');
    // 戻したキャッシュはファイルの inode が変わり、Xcode の build は Swift のモジュールを作り直す（CI で 431 秒）。
    // 中身の指紋で引く compilation caching なら、戻した後でも当たる（手元の実測で 120 秒 → 19 秒）。
    expect(build).toMatch(/COMPILATION_CACHE_ENABLE_CACHING=YES/);
    expect(mac.indexOf('actions/cache/restore@')).toBeLessThan(mac.indexOf('npm run tauri -- build'));
  });
  it('release の macos ジョブは Metal Toolchain を入れて、本物の補助を入れた .app を作る', () => {
    const mac = job(read('.github/workflows/release.yml'), 'macos');
    expect(mac).not.toContain('HANGAR_SKIP_VOICE');
    const toolchain = mac.indexOf('xcodebuild -downloadComponent MetalToolchain');
    expect(toolchain).toBeGreaterThan(0);
    expect(toolchain).toBeLessThan(mac.indexOf('npm run tauri -- build'));
  });
});
