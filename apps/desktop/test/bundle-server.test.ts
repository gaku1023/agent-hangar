import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleServer, BUNDLED_CLOUD_MARKER, NATIVE_MODULES, PREBUILD_ARCH } from '../scripts/bundle-server.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * 配布物は Apple silicon 向けにしか作らない。
 * ネイティブモジュールの prebuild が他の環境には無いので、そこでは試しても意味が無い。
 */
const onAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64';

const dirSize = (dir: string): number => {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath, e.name);
    if (e.isFile()) total += fs.lstatSync(p).size;
  }
  return total;
};

async function waitHealth(url: string, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok && ((await r.json()) as { ok?: boolean }).ok === true) return true;
    } catch {
      // まだ起きていない
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe.skipIf(!onAppleSilicon)('bundleServer', () => {
  it('server.mjs、cli.mjs、ui、ネイティブモジュール、cloud、manifest、bin/hangar を出し、tsx 無しで起動する', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    const home = tmp('hangar-home-');
    const claude = tmp('hangar-claude-');
    const ws = tmp('hangar-ws-');
    dirs.push(out, ui, home, claude, ws);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    fs.mkdirSync(path.join(ui, 'assets'));
    fs.writeFileSync(path.join(ui, 'assets', 'index.js'), 'export default 1;\n');
    fs.writeFileSync(path.join(ui, 'assets', 'index.js.map'), '{"version":3}');
    fs.mkdirSync(path.join(claude, 'projects'));
    fs.mkdirSync(path.join(claude, 'sessions'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir: claude }));

    const r = await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    expect(r.files.sort()).toEqual(['.gitkeep', 'bin', 'cli.mjs', 'cloud', 'manifest.json', 'node_modules', 'server.mjs', 'ui']);

    // バンドルが外部のまま残した import の宛先と、同梱した node_modules がぴたり一致することを見る。
    // 定数を書き写しても何も主張しないが、これは「外に出したものは必ず隣に置いてある」という起動の条件である。
    const bare = [...new Set([...fs.readFileSync(path.join(out, 'server.mjs'), 'utf8').matchAll(/^import[^\n]* from "([^"]+)";$/gm)].map((m) => m[1]!))]
      .filter((sp) => !sp.startsWith('node:'));
    expect(bare.sort()).toEqual([...NATIVE_MODULES].sort());
    expect(fs.readdirSync(path.join(out, 'node_modules')).sort()).toEqual([...NATIVE_MODULES].sort());

    for (const f of [
      'ui/index.html',
      'node_modules/better-sqlite3/package.json',
      'node_modules/better-sqlite3/lib/index.js',
      `node_modules/better-sqlite3/prebuilds/${PREBUILD_ARCH}.node`,
      'node_modules/node-pty/package.json',
      'node_modules/node-pty/lib/index.js',
      `node_modules/node-pty/prebuilds/${PREBUILD_ARCH}/pty.node`,
      `node_modules/node-pty/prebuilds/${PREBUILD_ARCH}/spawn-helper`,
      'cloud/src/index.ts',
      'cloud/wrangler.jsonc',
      'cloud/package.json',
      `cloud/${BUNDLED_CLOUD_MARKER}`,
    ]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }

    // 実行に要らない重い中身は落とす。特に他のアーキの prebuild を入れると 90MB 近くなる。
    for (const f of [
      'node_modules/better-sqlite3/deps',
      'node_modules/better-sqlite3/src',
      'node_modules/better-sqlite3/prebuilds/linux-x64.node',
      'node_modules/better-sqlite3/prebuilds/win32-x64.node',
      'node_modules/node-pty/deps',
      'node_modules/node-pty/third_party',
      'node_modules/node-pty/prebuilds/win32-x64',
      'node_modules/node-pty/prebuilds/darwin-x64',
      'cloud/test',
      'cloud/node_modules',
      // sourcemap は配布物に入れない。UI の写しの大半を占めるうえ、利用者の役には立たない。
      'ui/assets/index.js.map',
    ]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(false);
    }
    expect(dirSize(path.join(out, 'node_modules'))).toBeLessThan(15 * 1024 * 1024);

    expect(fs.statSync(path.join(out, 'bin/hangar')).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(out, 'ui/assets/index.js'))).toBe(true);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ version: '0.1.0', nodeMajor: Number(process.versions.node.split('.')[0]), arch: process.arch });
    expect(typeof m.builtAt).toBe('string');
    const js = fs.readFileSync(path.join(out, 'server.mjs'), 'utf8');
    expect(js).not.toContain('from "tsx"');
    expect(js).not.toContain('./server.ts');

    const child = spawn(process.execPath, [path.join(out, 'server.mjs')], {
      env: { ...process.env, HANGAR_HOME: home, HANGAR_CLAUDE_DIR: claude, HANGAR_PORT: '4199', HANGAR_UI_DIST: path.join(out, 'ui') },
      stdio: 'ignore',
    });
    try {
      expect(await waitHealth('http://127.0.0.1:4199/health', 30_000)).toBe(true);
      // 素の GET / は 401 の案内を返す。UI は鍵付きの URL でだけ配られる。
      const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
      const html = await (await fetch(`http://127.0.0.1:4199/?t=${token}`)).text();
      expect(html).toContain('bundled-ui');
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
  });

  it('bin/hangar が同梱の Node で cli.mjs を動かし、symlink 経由でも鍵つきの URL を出す', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    const home = tmp('hangar-home-');
    const link = tmp('hangar link-');
    dirs.push(out, ui, home, link);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    const env = { ...process.env, HANGAR_HOME: home, HANGAR_NODE: process.execPath };

    const { stdout } = await promisify(execFile)(path.join(out, 'bin/hangar'), ['--help'], { env });
    expect(stdout).toContain('hangar');
    expect(stdout).toContain('setup');

    // README が案内する /usr/local/bin/hangar への symlink と同じ形。
    // 配布版だけを持つ利用者がブラウザで入る唯一の道なので、リンク越しに鍵つきの URL まで見る。
    fs.symlinkSync(path.join(out, 'bin/hangar'), path.join(link, 'hangar'));
    const url = (await promisify(execFile)(path.join(link, 'hangar'), ['url', '--port', '4231'], { env })).stdout.trim();
    // 鍵そのものは出さない。形と、控えてあるものと同じであることだけを見る。
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    expect(url.startsWith('http://127.0.0.1:4231/?t=')).toBe(true);
    expect(url.endsWith(token)).toBe(true);
    expect(token.length).toBeGreaterThan(16);
  });

  it('UI のビルドが無ければ、何をすればよいかを述べて止まる', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    dirs.push(out, ui);
    await expect(bundleServer({ repoRoot, outDir: out, uiDist: ui })).rejects.toThrow(/npm run build/);
  });
});

/**
 * この環境には存在しない Node のメジャー版。
 * 実物の Node が偶然に当たらないので、探索の道筋を作り物の node だけで決められる。
 */
const UNREACHABLE_MAJOR = 99;

/**
 * hangar.sh だけを試すための最小の dist。
 * バンドルを作らずに済むので、Apple silicon 以外でも走る。
 * 置き場の名前に空白を入れてあるのは、空白で語分割される壊れ方を常に踏むためである。
 */
function fakeDist(o: { nodeMajor?: number | null } = {}): string {
  const dist = tmp('hangar dist-');
  dirs.push(dist);
  fs.mkdirSync(path.join(dist, 'bin'));
  fs.copyFileSync(path.join(repoRoot, 'apps/desktop/scripts/hangar.sh'), path.join(dist, 'bin', 'hangar'));
  fs.chmodSync(path.join(dist, 'bin', 'hangar'), 0o755);
  // cli.mjs の代わりに、受け取った環境と引数をそのまま印字する探り script を置く。
  fs.writeFileSync(
    path.join(dist, 'cli.mjs'),
    'console.log(JSON.stringify({ ui: process.env.HANGAR_UI_DIST, cloud: process.env.HANGAR_CLOUD_DIR, node: process.env.HANGAR_TEST_SHIM ?? null, args: process.argv.slice(2) }));\n',
  );
  const major = o.nodeMajor === undefined ? UNREACHABLE_MAJOR : o.nodeMajor;
  if (major !== null) fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify({ version: '0.0.0', nodeMajor: major, arch: process.arch }) + '\n');
  return dist;
}

/**
 * 指定した場所に、作り物のメジャー版を名乗る node を置く。
 * 探索の probe（node -p）には作り物の版を返し、実際の起動だけ実物の node へ渡す。
 * どの候補が選ばれたかを知るために、自分の場所を HANGAR_TEST_SHIM で渡す。
 */
function fakeNode(at: string, major = UNREACHABLE_MAJOR): string {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  const real = JSON.stringify(process.execPath);
  fs.writeFileSync(at, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${major}; exit 0; fi\nHANGAR_TEST_SHIM=${JSON.stringify(at)}\nexport HANGAR_TEST_SHIM\nexec ${real} "$@"\n`);
  fs.chmodSync(at, 0o755);
  return at;
}

type Ran = { stdout: string; stderr: string; code: number };

/** 素の環境で走らせる。PATH 以外は渡さないので、手元の設定に結果が左右されない。 */
async function runHangar(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  try {
    const r = await promisify(execFile)(bin, args, { env: { PATH: process.env.PATH ?? '', ...env } });
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? -1 };
  }
}

const emptyDirFor = (name: string): string => {
  const d = tmp(name);
  dirs.push(d);
  return d;
};

describe('bin/hangar の Node 探索', () => {
  it.each([
    ['空白の無い', 'nd99'],
    ['空白を含む', 'nd 99'],
  ])('settings.json の nodePath が%sパスでも Node を見つけ、UI と Worker の置き場を渡す', async (_label, leaf) => {
    const dist = fakeDist();
    const node = fakeNode(path.join(emptyDirFor('hangar nodes-'), leaf, 'node'));
    const home = emptyDirFor('hangar home-');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ nodePath: node }));

    const r = await runHangar(path.join(dist, 'bin/hangar'), ['status', '--port', '4231'], { HANGAR_HOME: home, HOME: emptyDirFor('hangar userhome-') });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ui: path.join(dist, 'ui'),
      cloud: path.join(dist, 'cloud'),
      node,
      args: ['status', '--port', '4231'],
    });
  });

  it('HANGAR_NODE が空白を含むパスでも Node を見つける', async () => {
    const dist = fakeDist();
    const node = fakeNode(path.join(emptyDirFor('hangar nodes-'), 'n d', 'node'));
    const r = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_NODE: node, HANGAR_HOME: emptyDirFor('hangar home-'), HOME: emptyDirFor('hangar userhome-') });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).node).toBe(node);
  });

  it('HOME が空白を含むパスでも nvm の Node を見つける', async () => {
    const dist = fakeDist();
    const userHome = emptyDirFor('hangar user home-');
    const node = fakeNode(path.join(userHome, '.nvm/versions/node/v99.0.0/bin/node'));
    const r = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_HOME: emptyDirFor('hangar home-'), HOME: userHome });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).node).toBe(node);
  });

  it('nvm の候補は文字列ではなく版として新しい順に見る', async () => {
    const dist = fakeDist();
    const userHome = emptyDirFor('hangar user home-');
    fakeNode(path.join(userHome, '.nvm/versions/node/v99.9.0/bin/node'));
    const newer = fakeNode(path.join(userHome, '.nvm/versions/node/v99.10.0/bin/node'));
    const r = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_HOME: emptyDirFor('hangar home-'), HOME: userHome });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).node).toBe(newer);
  });

  it('どの候補も版が合わなければ、何をすればよいかを述べて exit 1 になる', async () => {
    const dist = fakeDist();
    const home = emptyDirFor('hangar home-');
    const r = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_HOME: home, HOME: emptyDirFor('hangar userhome-') });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Node ${UNREACHABLE_MAJOR} が見つかりません`);
    expect(r.stderr).toContain(path.join(home, 'settings.json'));
  });

  it('manifest.json が無ければ、sed の生のエラーではなく何が起きたかを述べて止まる', async () => {
    const dist = fakeDist({ nodeMajor: null });
    const r = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_HOME: emptyDirFor('hangar home-'), HOME: emptyDirFor('hangar userhome-') });
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain('sed:');
    expect(r.stderr).toContain('manifest.json');
    expect(r.stderr).toContain('入れ直してください');
  });

  it('symlink 経由でも実体の dist を使う。多段でも、相対のリンク先でも、空白を含むパスでも', async () => {
    // README が案内する /usr/local/bin/hangar はリンクである。
    // 実体まで辿らないと dist が /usr/local になり、配布版だけを持つ利用者はどこにも入れない。
    const dist = fakeDist();
    const node = fakeNode(path.join(emptyDirFor('hangar nodes-'), 'n d', 'node'));
    const a = emptyDirFor('hangar link a-');
    const b = emptyDirFor('hangar link b-');
    // 1 段目は相対のリンク先。2 段目はリンクへのリンク。
    fs.symlinkSync(path.relative(a, path.join(dist, 'bin/hangar')), path.join(a, 'hangar'));
    fs.symlinkSync(path.join(a, 'hangar'), path.join(b, 'hangar'));

    const r = await runHangar(path.join(b, 'hangar'), [], { HANGAR_NODE: node, HANGAR_HOME: emptyDirFor('hangar home-'), HOME: emptyDirFor('hangar userhome-') });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ui: path.join(dist, 'ui'), cloud: path.join(dist, 'cloud') });
  });

  it('HANGAR_CLOUD_DIR が既に指定されていれば、同梱の cloud で上書きしない', async () => {
    const dist = fakeDist();
    const node = fakeNode(path.join(emptyDirFor('hangar nodes-'), 'n d', 'node'));
    const mine = emptyDirFor('hangar cloud-');
    const r = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_NODE: node, HANGAR_CLOUD_DIR: mine, HANGAR_HOME: emptyDirFor('hangar home-'), HOME: emptyDirFor('hangar userhome-') });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).cloud).toBe(mine);
  });
});

describe('bundleServer が途中で失敗したとき', () => {
  it('git が追跡している .gitkeep を消したまま残さない', async () => {
    const out = emptyDirFor('hangar-dist-');
    const ui = emptyDirFor('hangar-ui-');
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    fs.writeFileSync(path.join(out, '.gitkeep'), '');

    // entryPoints が見つからず esbuild が投げる。emptyDir の後、最後の書き直しより前である。
    await expect(bundleServer({ repoRoot: path.join(out, 'no-such-repo'), outDir: out, uiDist: ui })).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.existsSync(path.join(out, '.gitkeep'))).toBe(true);
  });
});
