import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLE_TARGETS, buildLauncher, bundleServer, hostBundleTarget, NATIVE_MODULES, type BundleTarget } from '../scripts/bundle-server.ts';
import { chooseNode, windowsNodeCandidates } from '../scripts/launch-cli.ts';
import { bundleWorker, workerMetadata } from '../../../packages/cloud/scripts/build-worker.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * 配布物は Apple silicon の macOS と x64 の Windows 向けにだけ作る。
 * この機械が配布の対象でなければ（Linux など）、起動まで確かめる試験は走らせない。
 * 束の中身を target 別に見る試験は、どの機械でも走る（prebuild は全部 npm の包みに入っている）。
 */
const host = hostBundleTarget();
const onWindows = process.platform === 'win32';

const dirSize = (dir: string): number => {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath, e.name);
    if (e.isFile()) total += fs.lstatSync(p).size;
  }
  return total;
};

/** 誰も待ち受けていないポートを 1 つ取る。 */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

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

describe.skipIf(!host)('bundleServer', () => {
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
    // macOS の同梱物は、Windows の対応を足す前から変わらない。launch-cli.mjs は Windows だけに入る。
    expect(r.files.sort()).toEqual(
      onWindows
        ? ['.gitkeep', 'bin', 'cli.mjs', 'cloud', 'hangar-run.mjs', 'launch-cli.mjs', 'manifest.json', 'node_modules', 'server.mjs', 'ui']
        : ['.gitkeep', 'bin', 'cli.mjs', 'cloud', 'hangar-run.mjs', 'manifest.json', 'node_modules', 'server.mjs', 'ui'],
    );

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
      `node_modules/better-sqlite3/prebuilds/${host}.node`,
      'node_modules/node-pty/package.json',
      'node_modules/node-pty/lib/index.js',
      `node_modules/node-pty/prebuilds/${host}/pty.node`,
      onWindows ? `node_modules/node-pty/prebuilds/${host}/conpty.node` : `node_modules/node-pty/prebuilds/${host}/spawn-helper`,
      'cloud/worker.mjs',
      'cloud/metadata.json',
    ]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }

    // 実行に要らない重い中身は落とす。特に他のアーキの prebuild を入れると 90MB 近くなる。
    for (const f of [
      'node_modules/better-sqlite3/deps',
      'node_modules/better-sqlite3/src',
      'node_modules/better-sqlite3/prebuilds/linux-x64.node',
      `node_modules/better-sqlite3/prebuilds/${onWindows ? 'darwin-arm64' : 'win32-x64'}.node`,
      'node_modules/node-pty/deps',
      'node_modules/node-pty/third_party',
      `node_modules/node-pty/prebuilds/${onWindows ? 'darwin-arm64' : 'win32-x64'}`,
      'node_modules/node-pty/prebuilds/darwin-x64',
      // sourcemap は配布物に入れない。UI の写しの大半を占めるうえ、利用者の役には立たない。
      'ui/assets/index.js.map',
    ]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(false);
    }
    expect(dirSize(path.join(out, 'node_modules'))).toBeLessThan(15 * 1024 * 1024);

    if (!onWindows) expect(fs.statSync(path.join(out, 'bin/hangar')).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(out, 'ui/assets/index.js'))).toBe(true);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ version: '0.1.0', nodeMajor: Number(process.versions.node.split('.')[0]), arch: process.arch });
    expect(host).toBe(`${process.platform}-${process.arch}`);
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

  it.skipIf(onWindows)('bin/hangar が同梱の Node で cli.mjs を動かし、symlink 経由でも鍵つきの URL を出す', async () => {
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

  it.skipIf(onWindows)('bin/hangar start がリンク越しでも隣の server.mjs を子で起こし、同梱の UI を配り、SIGINT で子も降りる', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    const home = tmp('hangar-home-');
    const claude = tmp('hangar-claude-');
    const ws = tmp('hangar-ws-');
    const link = tmp('hangar link-');
    const tmuxDir = tmp('hangar-tmux-');
    dirs.push(out, ui, home, claude, ws, link, tmuxDir);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    fs.mkdirSync(path.join(claude, 'projects'));
    fs.mkdirSync(path.join(claude, 'sessions'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir: claude }));
    await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    // README が案内する /usr/local/bin/hangar と同じ形のリンク越しに起こす。
    fs.symlinkSync(path.join(out, 'bin/hangar'), path.join(link, 'hangar'));
    const port = await freePort();
    const { HANGAR_PARENT_PID: _pid, HANGAR_UI_DIST: _ui, HANGAR_PORT: _port, HANGAR_CLOUD_DIR: _cloud, ...base } = process.env;
    const child = spawn(path.join(link, 'hangar'), ['start', '--port', String(port), '--no-open'], {
      env: { ...base, HANGAR_HOME: home, HANGAR_NODE: process.execPath, HANGAR_CLAUDE_DIR: claude, TMUX_TMPDIR: tmuxDir },
    });
    let text = '';
    child.stdout.on('data', (b: Buffer) => { text += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { text += b.toString(); });
    const closed = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    try {
      const until = Date.now() + 30_000;
      while (!text.includes('?t=') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
      expect(text).toContain(`http://127.0.0.1:${port}/?t=${token}`);
      // bin/hangar が渡した HANGAR_UI_DIST を子のサーバが継いでいる。
      const html = await (await fetch(`http://127.0.0.1:${port}/?t=${token}`)).text();
      expect(html).toContain('bundled-ui');
    } finally {
      // bin/hangar は exec で node に替わるので、この PID は cli.mjs の node である。
      child.kill('SIGINT');
    }
    expect(await closed).toBe(0);
    expect(await waitHealth(`http://127.0.0.1:${port}/health`, 500)).toBe(false);
  });

  it('cli.mjs はサーバ本体を抱えない。外に残す import は better-sqlite3 だけで、大きさは 768KB に満たない', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    dirs.push(out, ui);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    const cli = fs.readFileSync(path.join(out, 'cli.mjs'), 'utf8');
    const bare = [...new Set([...cli.matchAll(/^import[^\n]* from "([^"]+)";$/gm)].map((m) => m[1]!))].filter((sp) => !sp.startsWith('node:'));
    // CLI が DB を開くのは本文の床（openTranscriptsFloor、readTranscriptsFrom）のためで、端末（node-pty）は使わない。
    expect(bare).toEqual(['better-sqlite3']);
    // サーバにしか無い関数。CLI がサーバの入口から import すると、esbuild がこれらを束ねてしまう。
    expect(cli).not.toContain('function startServer(');
    expect(cli).not.toContain('function createApp(');
    // 2026-10-07 の試しでは約 240KB だった。サーバを抱えると 2MB を超える。
    // 辞書（shared の i18n）を丸ごと束ねるので、段 4 で画面の文が増えるにつれて太る（2026-10-10 に約 550KB）。サーバを抱えたかを見分けるには 768KB で足りる。
    expect(fs.statSync(path.join(out, 'cli.mjs')).size).toBeLessThan(768 * 1024);
  });

  it('cloud/ には Worker を 1 本に束ねた worker.mjs と束縛の定義 metadata.json だけを置き、源の写しを置かない', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    dirs.push(out, ui);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    // 源（src、wrangler.jsonc、package.json）も、手元の秘密や記録（.dev.vars、.env、.wrangler、ログ）も置かない。
    // 束は src/index.ts から届くコードだけでできているので、手元の秘密のファイルは入りようがない。
    expect(fs.readdirSync(path.join(out, 'cloud')).sort()).toEqual(['metadata.json', 'worker.mjs']);
    const cloudSrc = path.join(repoRoot, 'packages/cloud');
    // 置いた束は、packages/cloud の試験が miniflare で起こしているのと同じ束である。
    expect(fs.readFileSync(path.join(out, 'cloud/worker.mjs'), 'utf8')).toBe(await bundleWorker(cloudSrc));
    expect(JSON.parse(fs.readFileSync(path.join(out, 'cloud/metadata.json'), 'utf8'))).toEqual(workerMetadata(cloudSrc));
  });

  it.skipIf(onWindows)('同梱の hangar の setup cloud は、wrangler を探す前に、clone した場所から実行するよう案内して止まる', async () => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    const home = tmp('hangar-home-');
    const userHome = tmp('hangar-userhome-');
    dirs.push(out, ui, home, userHome);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    await bundleServer({ repoRoot, outDir: out, uiDist: ui });
    // runHangar は PATH と LANG のほかは渡さないので、手元の HANGAR_CLOUD_DIR は届かない。
    const r = await runHangar(path.join(out, 'bin/hangar'), ['setup', 'cloud'], { HANGAR_HOME: home, HANGAR_NODE: process.execPath, HOME: userHome });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('src/index.ts');
    expect(r.stderr).toContain('clone して npm install');
    // 資源を作りに行っていない。参加の記録も書かない。
    expect(fs.existsSync(path.join(home, 'cloud.json'))).toBe(false);
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
function fakeDist(o: { nodeMajor?: number | null; arch?: string; manifest?: string } = {}): string {
  const dist = tmp('hangar dist-');
  dirs.push(dist);
  fs.mkdirSync(path.join(dist, 'bin'));
  fs.copyFileSync(path.join(repoRoot, 'apps/desktop/scripts/hangar.sh'), path.join(dist, 'bin', 'hangar'));
  fs.chmodSync(path.join(dist, 'bin', 'hangar'), 0o755);
  // cli.mjs の代わりに、受け取った環境と引数をそのまま印字する探り script を置く。
  fs.writeFileSync(
    path.join(dist, 'cli.mjs'),
    'console.log(JSON.stringify({ ui: process.env.HANGAR_UI_DIST, cloud: process.env.HANGAR_CLOUD_DIR ?? null, node: process.env.HANGAR_TEST_SHIM ?? null, args: process.argv.slice(2) }));\n',
  );
  const major = o.nodeMajor === undefined ? UNREACHABLE_MAJOR : o.nodeMajor;
  if (o.manifest !== undefined) fs.writeFileSync(path.join(dist, 'manifest.json'), o.manifest);
  else if (major !== null) fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify({ version: '0.0.0', nodeMajor: major, arch: o.arch ?? process.arch }) + '\n');
  return dist;
}

/**
 * 指定した場所に、作り物のメジャー版を名乗る node を置く。
 * 探索の probe（node -p）には作り物の版を返し、実際の起動だけ実物の node へ渡す。
 * どの候補が選ばれたかを知るために、自分の場所を HANGAR_TEST_SHIM で渡す。
 */
function fakeNode(at: string, major = UNREACHABLE_MAJOR, arch = process.arch): string {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  const real = JSON.stringify(process.execPath);
  fs.writeFileSync(at, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo "${major} ${arch}"; exit 0; fi\nHANGAR_TEST_SHIM=${JSON.stringify(at)}\nexport HANGAR_TEST_SHIM\nexec ${real} "$@"\n`);
  fs.chmodSync(at, 0o755);
  return at;
}

type Ran = { stdout: string; stderr: string; code: number };

/**
 * 素の環境で走らせる。
 * PATH と LANG 以外は渡さないので、手元の設定に結果が左右されない。
 * LANG を渡すのは、利用者の環境がそうだからである。
 * bash 3.2 は UTF-8 のロケールのときだけ、`$変数` の直後の多バイト文字を変数名の一部として食う。
 * C ロケールで走らせると、その壊れ方を見逃す。
 */
async function runHangar(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  try {
    const r = await promisify(execFile)(bin, args, { env: { PATH: process.env.PATH ?? '', LANG: 'ja_JP.UTF-8', ...env } });
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

// hangar.sh は macOS の起動スクリプト。Windows の起動は殻の区切りで作る。
describe.skipIf(process.platform === 'win32')('bin/hangar の Node 探索', () => {
  it.each([
    ['空白の無い', 'nd99'],
    ['空白を含む', 'nd 99'],
  ])('settings.json の nodePath が%sパスでも Node を見つけ、UI の置き場を渡し、Worker の置き場は渡さない', async (_label, leaf) => {
    const dist = fakeDist();
    const node = fakeNode(path.join(emptyDirFor('hangar nodes-'), leaf, 'node'));
    const home = emptyDirFor('hangar home-');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ nodePath: node }));

    const r = await runHangar(path.join(dist, 'bin/hangar'), ['status', '--port', '4231'], { HANGAR_HOME: home, HOME: emptyDirFor('hangar userhome-') });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ui: path.join(dist, 'ui'),
      cloud: null,
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
    expect(r.stderr).toContain(`Node ${UNREACHABLE_MAJOR}（${process.arch}）が見つかりません`);
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

  it('manifest.json が壊れていれば、sed の生のエラーではなく何が起きたかを述べて止まる', async () => {
    // 1 鍵 1 行で書かれる前提が崩れた写しでも、空の版で探し続けて「Node  が見つかりません」と言わない。
    const dist = fakeDist({ manifest: '{ "version": "0.0.0" }\n' });
    const node = fakeNode(path.join(emptyDirFor('hangar nodes-'), 'nd', 'node'));
    const r = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_NODE: node, HANGAR_HOME: emptyDirFor('hangar home-'), HOME: emptyDirFor('hangar userhome-') });
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain('sed:');
    expect(r.stderr).toContain('manifest.json');
    expect(r.stderr).toContain('入れ直してください');
  });

  it('アーキテクチャが合わない Node は掴まない。版だけが合う Rosetta の x64 を先に見つけても飛ばす', async () => {
    // 同梱のネイティブモジュールは ABI に縛られるので、版が合っても別のアーキでは読めない。
    // アプリ本体（node.rs）は版とアーキの両方を見る。
    // ここも揃える。
    const dist = fakeDist();
    const nodes = emptyDirFor('hangar nodes-');
    // 「別のアーキ」は走っている機械によって変わる。arm64 の Mac では x64 が、x64 の Linux では arm64 が相手になる。
    // ここを x64 に決め打ちすると、x64 の機械では「合っている Node」を作ってしまい、試験が主張を失う。
    const otherArch = process.arch === 'x64' ? 'arm64' : 'x64';
    const wrong = fakeNode(path.join(nodes, otherArch, 'node'), UNREACHABLE_MAJOR, otherArch);
    const home = emptyDirFor('hangar home-');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ nodePath: wrong }));
    const r = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_HOME: home, HOME: emptyDirFor('hangar userhome-') });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Node ${UNREACHABLE_MAJOR}（${process.arch}）が見つかりません`);

    // 同じ並びに正しいアーキの Node があれば、そちらを採る。
    const right = fakeNode(path.join(nodes, 'ok', 'node'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ nodePath: wrong }));
    const r2 = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_NODE: right, HANGAR_HOME: home, HOME: emptyDirFor('hangar userhome-') });
    expect(r2.code, r2.stderr).toBe(0);
    expect(JSON.parse(r2.stdout).node).toBe(right);
  });

  it('候補が前置きの行を出しても、健全な Node を取り逃がさない', async () => {
    const dist = fakeDist();
    const at = path.join(emptyDirFor('hangar nodes-'), 'noisy', 'node');
    fakeNode(at);
    const body = fs.readFileSync(at, 'utf8').replace('if [ "$1" = "-p" ]; then', 'if [ "$1" = "-p" ]; then echo "(node:1) Warning: x";');
    fs.writeFileSync(at, body);
    const r = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_NODE: at, HANGAR_HOME: emptyDirFor('hangar home-'), HOME: emptyDirFor('hangar userhome-') });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).node).toBe(at);
  });

  it('候補が後置きの行を出しても、健全な Node を取り逃がさない', async () => {
    // node.rs の parse_probe は行を後ろから探すので、後置きの行があっても拾う。
    // bin/hangar も同じ扱いにする。
    const dist = fakeDist();
    const at = path.join(emptyDirFor('hangar nodes-'), 'noisy', 'node');
    fakeNode(at);
    const body = fs.readFileSync(at, 'utf8').replace('exit 0; fi', 'echo "trailing junk"; exit 0; fi');
    fs.writeFileSync(at, body);
    const r = await runHangar(path.join(dist, 'bin/hangar'), [], { HANGAR_NODE: at, HANGAR_HOME: emptyDirFor('hangar home-'), HOME: emptyDirFor('hangar userhome-') });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).node).toBe(at);
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
    expect(JSON.parse(r.stdout)).toMatchObject({ ui: path.join(dist, 'ui'), cloud: null });
  });

  it('利用者が HANGAR_CLOUD_DIR を決めていれば、そのまま CLI へ届く（開発用の上書きを残す）', async () => {
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

/** 束の中の全ファイルを、束の根からの相対パス（/ 区切り）で返す。 */
const listAll = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'));

/**
 * 同梱する prebuild は target 別に決まる。
 * 他の target のものが 1 つでも入ると、配布物が太る（node-pty の win32 だけで 58MB）。
 * 束の作り方は、作る機械に依らない。macOS でも Linux でも Windows 向けの束を作れて、中身は同じになる。
 */
describe('bundleServer の target 別の同梱物', () => {
  const make = async (target: BundleTarget): Promise<string> => {
    const out = tmp('hangar-dist-');
    const ui = tmp('hangar-ui-');
    dirs.push(out, ui);
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>bundled-ui</title>');
    await bundleServer({ repoRoot, outDir: out, uiDist: ui, target });
    return out;
  };

  it('対応する target は darwin-arm64 と win32-x64 だけである', () => {
    expect([...BUNDLE_TARGETS]).toEqual(['darwin-arm64', 'win32-x64']);
    expect(hostBundleTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(hostBundleTarget('win32', 'x64')).toBe('win32-x64');
    // 作らないものは、黙って別の target の束にせず、無いと答える。
    expect(hostBundleTarget('darwin', 'x64')).toBeUndefined();
    expect(hostBundleTarget('win32', 'arm64')).toBeUndefined();
    expect(hostBundleTarget('linux', 'x64')).toBeUndefined();
  });

  it('darwin-arm64：darwin の prebuild と bin/hangar（sh）だけで、Windows 用の物を置かない', async () => {
    const out = await make('darwin-arm64');
    const files = listAll(out);
    expect(files).toContain('bin/hangar');
    expect(files).toContain('node_modules/better-sqlite3/prebuilds/darwin-arm64.node');
    expect(files).toContain('node_modules/node-pty/prebuilds/darwin-arm64/pty.node');
    expect(files).toContain('node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper');
    expect(files.filter((f) => f.includes('prebuilds/') && !f.includes('darwin-arm64'))).toEqual([]);
    expect(files).not.toContain('bin/hangar.cmd');
    expect(files).not.toContain('launch-cli.mjs');
    expect(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).arch).toBe('arm64');
  });

  it('win32-x64：win32 の prebuild と bin/hangar.cmd、launch-cli.mjs を置き、darwin 用と sh の起動を置かない', async () => {
    const out = await make('win32-x64');
    const files = listAll(out);
    expect(files).toContain('bin/hangar.cmd');
    expect(files).toContain('launch-cli.mjs');
    expect(files).toContain('hangar-run.mjs');
    expect(files).toContain('node_modules/better-sqlite3/prebuilds/win32-x64.node');
    // ConPTY（Windows 11 の疑似端末）が要るものが揃っている。
    for (const f of ['pty.node', 'conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) {
      expect(files, f).toContain(`node_modules/node-pty/prebuilds/win32-x64/${f}`);
    }
    expect(files.filter((f) => f.includes('prebuilds/') && !f.includes('win32-x64'))).toEqual([]);
    expect(files).not.toContain('bin/hangar');
    // デバッグの記号（.pdb）は実行に要らず、node-pty だけで 22MB ある。
    expect(files.filter((f) => f.endsWith('.pdb'))).toEqual([]);
    expect(dirSize(path.join(out, 'node_modules'))).toBeLessThan(15 * 1024 * 1024);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).arch).toBe('x64');
    // cmd が呼ぶ入口は、束の外の依存を持たず、そのまま動く 1 ファイルである。
    expect(fs.readFileSync(path.join(out, 'launch-cli.mjs'), 'utf8')).not.toMatch(/^import[^\n]* from "(?!node:)/m);
    // hangar.cmd は CRLF で、束の根の launch-cli.mjs を呼ぶ。
    const cmd = fs.readFileSync(path.join(out, 'bin/hangar.cmd'), 'utf8');
    expect(cmd).toContain('launch-cli.mjs');
    expect(cmd.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
  });
});

describe('launch-cli（Windows の bin/hangar.cmd が呼ぶ入口）', () => {
  const major = Number(process.versions.node.split('.')[0]);

  /** 作り物の dist。launch-cli.mjs は実物と同じ作り方で作り、cli.mjs は受け取った引数と環境を印字するだけの物に替える。 */
  async function fakeLaunchDist(manifest: object | null): Promise<string> {
    const dist = tmp('hangar dist-');
    dirs.push(dist);
    await buildLauncher(path.join(dist, 'launch-cli.mjs'));
    fs.writeFileSync(
      path.join(dist, 'cli.mjs'),
      'console.log(JSON.stringify({ ui: process.env.HANGAR_UI_DIST, args: process.argv.slice(2), node: process.execPath }));\n',
    );
    if (manifest) fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest) + '\n');
    // 入口は自分の置き場を実体のパスで知る（macOS の /var は /private/var、Windows の短い名前）。比べる側も実体にそろえるため、実在させておく。
    fs.mkdirSync(path.join(dist, 'ui'));
    return dist;
  }

  /** 印字された UI の置き場が、dist の ui と同じ実体であること。 */
  const sameUi = (printed: string | undefined, dist: string): boolean =>
    printed !== undefined && fs.realpathSync.native(printed) === fs.realpathSync.native(path.join(dist, 'ui'));

  const run = (dist: string, args: string[], env: NodeJS.ProcessEnv = {}): Ran => {
    const r = spawnSync(process.execPath, [path.join(dist, 'launch-cli.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HANGAR_NODE: '', HANGAR_LAUNCHED: '', ...env },
    });
    return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? -1 };
  };

  it('走っている Node が manifest と合えば、そのまま cli.mjs を動かし、UI の置き場を渡す', async () => {
    const dist = await fakeLaunchDist({ version: '0.0.0', nodeMajor: major, arch: process.arch });
    const r = run(dist, ['status', '--port', '4231']);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ui?: string; args: string[]; node: string };
    expect(sameUi(out.ui, dist)).toBe(true);
    expect(out.args).toEqual(['status', '--port', '4231']);
    expect(out.node).toBe(process.execPath);
  });

  it('どの候補も合わなければ、探した Node と次の一手を述べて exit 1 になる', async () => {
    const dist = await fakeLaunchDist({ version: '0.0.0', nodeMajor: 99, arch: process.arch });
    const home = emptyDirFor('hangar home-');
    const r = run(dist, [], { HANGAR_HOME: home, HANGAR_NODE: process.execPath });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Node 99（${process.arch}）が見つかりません`);
    expect(r.stderr).toContain('HANGAR_NODE');
    expect(r.stderr).toContain(path.join(home, 'settings.json'));
  });

  it('manifest.json が無ければ、何が起きたかを述べて止まる', async () => {
    const dist = await fakeLaunchDist(null);
    const r = run(dist, []);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('manifest.json');
    expect(r.stderr).toContain('入れ直してください');
  });

  it('manifest.json が壊れていれば、版を読めないと述べて止まる', async () => {
    const dist = await fakeLaunchDist({ version: '0.0.0' });
    const r = run(dist, []);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('manifest.json');
  });

  // 偽の node は sh で書くので、Windows では作らない。選び方そのものは下の chooseNode の試験が縛る。
  it.skipIf(onWindows)('走っている Node が合わないとき、settings.json の nodePath の Node へ引数ごと渡し直す', async () => {
    const otherArch = process.arch === 'x64' ? 'arm64' : 'x64';
    const dist = await fakeLaunchDist({ version: '0.0.0', nodeMajor: major, arch: otherArch });
    const nodes = emptyDirFor('hangar nodes-');
    const fake = path.join(nodes, 'n d', 'node');
    fs.mkdirSync(path.dirname(fake));
    // 探り（-p）にだけ、manifest と同じ版を名乗る。それ以外は実物の node へ渡す。
    fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "-p" ]; then echo "${major} ${otherArch}"; exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    fs.chmodSync(fake, 0o755);
    const home = emptyDirFor('hangar home-');
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ nodePath: fake }));
    const r = run(dist, ['url', '--port', '4231'], { HANGAR_HOME: home });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ui?: string; args: string[] };
    expect(sameUi(out.ui, dist)).toBe(true);
    expect(out.args).toEqual(['url', '--port', '4231']);
  });

  describe('chooseNode', () => {
    const want = { nodeMajor: 22, arch: 'x64' };
    const answers: Record<string, { major: number; arch: string } | undefined> = {
      'C:\\a\\node.exe': undefined,
      'C:\\b\\node.exe': { major: 20, arch: 'x64' },
      'C:\\c\\node.exe': { major: 22, arch: 'arm64' },
      'C:\\d\\node.exe': { major: 22, arch: 'x64' },
      'C:\\e\\node.exe': { major: 22, arch: 'x64' },
    };
    it('先頭から見て、版もアーキも合う最初の 1 つを採る。起動できない候補や版違いは飛ばす', () => {
      expect(chooseNode(Object.keys(answers), want, (p) => answers[p])).toBe('C:\\d\\node.exe');
    });
    it('1 つも合わなければ undefined', () => {
      expect(chooseNode(['C:\\a\\node.exe', 'C:\\b\\node.exe', 'C:\\c\\node.exe'], want, (p) => answers[p])).toBeUndefined();
    });
    it('同じ場所を 2 度は探らない', () => {
      const seen: string[] = [];
      chooseNode(['C:\\a\\node.exe', 'C:\\a\\node.exe', 'C:\\b\\node.exe'], want, (p) => (seen.push(p), undefined));
      expect(seen).toEqual(['C:\\a\\node.exe', 'C:\\b\\node.exe']);
    });
  });

  describe('windowsNodeCandidates', () => {
    it('HANGAR_NODE、設定の nodePath、公式の入れ先、nvm-windows の順に並べ、nvm は新しい版から', () => {
      const env = {
        HANGAR_NODE: 'D:\\mine\\node.exe',
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
        NVM_HOME: 'C:\\Users\\me\\AppData\\Roaming\\nvm',
        NVM_SYMLINK: 'C:\\Program Files\\nodejs',
      };
      const got = windowsNodeCandidates(env, 'E:\\custom\\node.exe', () => ['v20.1.0', 'v22.14.0', 'v22.9.0', 'junk', 'settings.txt']);
      expect(got).toEqual([
        'D:\\mine\\node.exe',
        'E:\\custom\\node.exe',
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Users\\me\\AppData\\Local\\Programs\\nodejs\\node.exe',
        'C:\\Users\\me\\AppData\\Roaming\\nvm\\v22.14.0\\node.exe',
        'C:\\Users\\me\\AppData\\Roaming\\nvm\\v22.9.0\\node.exe',
        'C:\\Users\\me\\AppData\\Roaming\\nvm\\v20.1.0\\node.exe',
      ]);
    });
    it('環境変数が無ければ、その分は候補に出さない', () => {
      expect(windowsNodeCandidates({}, undefined, () => [])).toEqual([]);
    });
  });
});
