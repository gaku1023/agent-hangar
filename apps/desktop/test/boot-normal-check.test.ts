import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envMismatches, expectedServerPath, extraPathDirs, firstAsset, judgeHealth, judgeReady, readDesktopLog, webkitClients } from '../scripts/boot-normal-check.ts';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '../..');

// CI の「Node のある Mac で、殻が同梱のサーバを起こし、本当の画面へ移る」段の判定。
// 殻の server_command の経路（nodePath の Node、HANGAR_UI_DIST、HANGAR_PARENT_PID、PATH の足し方）を、build した .app で通す。
describe('殻の記録（desktop.log）を読む', () => {
  const log = [
    '1700000000000 [desktop] setup',
    '1700000000040 [desktop] node /opt/hostedtoolcache/node/22.20.0/arm64/bin/node server /tmp/w/Hangar.app/Contents/Resources/server',
    '1700000000050 [desktop] server pid 4321',
    'hangar server listening on 127.0.0.1:4177',
    '1700000002000 [desktop] navigating to the server',
  ].join('\n');

  it('殻が使った Node、サーバの置き場、サーバの pid、画面を移したことを拾う', () => {
    expect(readDesktopLog(log)).toEqual({
      node: '/opt/hostedtoolcache/node/22.20.0/arm64/bin/node',
      serverDir: '/tmp/w/Hangar.app/Contents/Resources/server',
      serverPid: 4321,
      navigated: true,
      failure: null,
    });
  });
  it('まだ何も書いていなければ、どれも無い', () => {
    expect(readDesktopLog('')).toEqual({ node: null, serverDir: null, serverPid: null, navigated: false, failure: null });
  });
  it('起動の失敗の行を拾う', () => {
    const r = readDesktopLog(`${log}\n1700000003000 [desktop] boot failed (server-exited): first line`);
    expect(r.failure).toBe('boot failed (server-exited): first line');
  });
  it('サーバが書いた行の [desktop] に似た文字は拾わない', () => {
    expect(readDesktopLog('x navigating to the server\nnode a server b').navigated).toBe(false);
    expect(readDesktopLog('node a server b').node).toBeNull();
  });
});

describe('/health の答え', () => {
  it('ok と ready がどちらも真なら通す', () => {
    expect(judgeHealth('{"ok":true,"version":"0.2.0","compat":4,"ready":true}')).toEqual({ ok: true, ready: true });
  });
  it('索引づけの途中なら ready は偽', () => {
    expect(judgeHealth('{"ok":true,"ready":false}')).toEqual({ ok: true, ready: false });
  });
  it('読めない答えや真偽値でない値は偽と読む', () => {
    expect(judgeHealth(null)).toEqual({ ok: false, ready: false });
    expect(judgeHealth('<html>')).toEqual({ ok: false, ready: false });
    expect(judgeHealth('{"ok":"yes","ready":1}')).toEqual({ ok: false, ready: false });
  });
});

// 起動画面は、読み込みが終わった合図（finish）を描くと、印を ready にして殻へ渡す（loading/boot.js の report）。
describe('起動画面が描いた様子（合図）', () => {
  const drawn = (o: object) => JSON.stringify({ level: null, card: false, kind: null, lang: 'en', title: '', detail: '', ...o });
  it('合図を描いたら通す', () => {
    expect(judgeReady(drawn({ level: 'ready' }))).toMatchObject({ done: true, ok: true });
  });
  it('まだ待っている間の画面なら、待ち続ける', () => {
    expect(judgeReady(null)).toMatchObject({ done: false });
    expect(judgeReady(drawn({}))).toMatchObject({ done: false });
    expect(judgeReady('{"level":')).toMatchObject({ done: false });
  });
  it('失敗の札が出たら、見出しと詳細を添えて落とす', () => {
    const r = judgeReady(drawn({ level: 'error', card: true, kind: 'node-missing', title: 'Could not start', detail: 'Node 22 was not found' }));
    expect(r).toMatchObject({ done: true, ok: false });
    expect(r.message).toContain('node-missing');
    expect(r.message).toContain('Node 22 was not found');
  });
});

describe('サーバの環境', () => {
  const ps = '/opt/node/bin/node /w/Hangar.app/Contents/Resources/server/server.mjs HOME=/w/home PATH=/usr/bin:/bin:/w/home/.local/bin HANGAR_PARENT_PID=77 HANGAR_PORT=4177 HANGAR_UI_DIST=/w/Hangar.app/Contents/Resources/server/ui HANGAR_HOME=/w/hangar-home';
  it('期待どおりなら食い違いは無い', () => {
    expect(envMismatches(ps, { HANGAR_PARENT_PID: '77', HANGAR_UI_DIST: '/w/Hangar.app/Contents/Resources/server/ui', HANGAR_HOME: '/w/hangar-home', PATH: '/usr/bin:/bin:/w/home/.local/bin' })).toEqual([]);
  });
  it('値の違い、欠け、前方一致だけの一致を食い違いとして挙げる', () => {
    const got = envMismatches(ps, { HANGAR_PARENT_PID: '7', HANGAR_UI_DIST: '/elsewhere/ui', HANGAR_LAUNCHER: '/x' });
    expect(got).toHaveLength(3);
    expect(got.join('\n')).toContain('HANGAR_UI_DIST');
    expect(got.join('\n')).toContain('HANGAR_LAUNCHER');
  });
});

// 殻は Finder から起きたときの最小の PATH に、手元のツールの置き場と、殻が選んだ Node の置き場を後ろへ足してサーバへ渡す（server.rs の augmented_path）。
describe('サーバへ渡る PATH', () => {
  const rs = fs.readFileSync(path.join(app, 'src-tauri/src/server.rs'), 'utf8');
  it('server.rs の augmented_path が足す置き場と同じものを、同じ順で足し、最後に殻が選んだ Node の置き場を足す', () => {
    const fn = rs.match(/pub fn augmented_path\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/);
    expect(fn, 'augmented_path が見つかりません').not.toBeNull();
    // 引数は 3 つで、3 つ目が殻の選んだ Node の置き場（server_command が node.parent() を渡す）。
    expect(fn![1]!.split(',').map((a) => a.trim().split(':')[0])).toEqual(['current', 'user_home', 'node_dir']);
    expect(rs).toMatch(/augmented_path\(\s*std::env::var\("PATH"\)\.ok\(\)\.as_deref\(\),\s*&crate::paths::user_home\(\),\s*node\.parent\(\),\s*\)/);
    const body = fn![2]!.match(/let extra = \[([\s\S]*?)\];/)?.[1];
    expect(body, 'augmented_path の extra が見つかりません').toBeDefined();
    // 決まった置き場の後ろに node_dir をつなぐ（Unix の道）。
    expect(fn![2]!).toMatch(/\.chain\(node_dir\)/);
    const home = '/h';
    const want = [...body!.matchAll(/user_home\.join\("([^"]+)"\)|PathBuf::from\("([^"]+)"\)/g)].map((m) => (m[1] ? `${home}/${m[1]}` : m[2]!));
    expect(want.length).toBeGreaterThan(0);
    expect(extraPathDirs(home, '/n/bin')).toEqual([...want, '/n/bin']);
    expect(extraPathDirs(home, '')).toEqual(want);
  });
  it('元の並びを保ち、既にある置き場は足さない', () => {
    expect(expectedServerPath('/usr/bin:/bin:/usr/sbin:/sbin', '/h', '/n/bin')).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/h/.claude/local:/n/bin');
    expect(expectedServerPath('/opt/homebrew/bin:/usr/bin', '/h', '/n/bin')).toBe('/opt/homebrew/bin:/usr/bin:/h/.local/bin:/usr/local/bin:/h/.claude/local:/n/bin');
    // Node が決まった置き場（Homebrew など）にあれば、2 度は足さない。
    expect(expectedServerPath('/usr/bin', '/h', '/opt/homebrew/bin')).toBe('/usr/bin:/h/.local/bin:/opt/homebrew/bin:/usr/local/bin:/h/.claude/local');
  });
});

describe('UI の頁と資産', () => {
  it('index.html が読み込む最初の資産のパスを拾う', () => {
    const html = '<!doctype html><link rel="icon" href="/favicon.svg"><script type="module" crossorigin src="/assets/index-AbC123.js"></script><link rel="stylesheet" href="/assets/index-x.css">';
    expect(firstAsset(html)).toBe('/assets/index-AbC123.js');
    expect(firstAsset('<html></html>')).toBeNull();
  });
});

// 画面がサーバの頁へ移ると、WebKit の通信のプロセスがサーバへつなぐ（UI は起動の時に WebSocket を張る）。
describe('サーバへつないでいる WebKit', () => {
  // lsof -F pc の出力。p が pid、c がコマンドの名前、それに続く f と n はそのプロセスのつなぎ。
  const lsof = ['p500', 'ccom.apple.WebKit.Networking', 'f10', 'nTCP 127.0.0.1:60123->127.0.0.1:4177', 'p4321', 'cnode', 'f26', 'nTCP 127.0.0.1:4177->127.0.0.1:60123', 'p600', 'ccurl', 'f3', 'nTCP 127.0.0.1:60200->127.0.0.1:4177'].join('\n');
  it('サーバ自身とほかのものを除いて、WebKit のプロセスだけを挙げる', () => {
    expect(webkitClients(lsof, 4321)).toEqual([{ pid: 500, command: 'com.apple.WebKit.Networking' }]);
  });
  it('つないでいなければ空', () => {
    expect(webkitClients('', 4321)).toEqual([]);
    expect(webkitClients('p4321\ncnode\nf26\n', 4321)).toEqual([]);
  });
});

describe('確かめる口（run）', () => {
  const script = path.join(app, 'scripts/boot-normal-check.ts');
  const run = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, 'run', ...args], { encoding: 'utf8' });
  const base = (pid: number, home: string) => ['--port', '9', '--hangar-home', home, '--server-dir', '/nope/server', '--node', process.execPath, '--shell-pid', String(pid), '--user-home', home, '--path-base', '/usr/bin:/bin', '--probe', path.join(home, 'probe.json'), '--timeout', '30'];

  it('使い方が違えば、2 で終わる', () => {
    expect(run([]).status).toBe(2);
    expect(run(['--port', '9']).status).toBe(2);
    // 合図の書き出しは必須にしない（サーバが先に用意できると、起動画面は合図を描く前に移る）。
    expect(run([...base(process.pid, '/tmp'), '--require-probe']).status).toBe(2);
  });
  it('殻が先に終わったら、上限を待たずに落とす', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-normal-'));
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.on('exit', r));
    const started = Date.now();
    const r = run(base(child.pid!, home));
    expect(r.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.stderr).toContain('殻が終わった');
  });
  it('殻が起動の失敗を記録したら、その行を出して落とす', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-normal-'));
    fs.writeFileSync(path.join(home, 'desktop.log'), '1700000000000 [desktop] boot failed (node-missing): Node 22 was not found\n');
    const r = run(base(process.pid, home));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('boot failed (node-missing)');
  });
});

describe('CI の段', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const sh = fs.readFileSync(path.join(app, 'scripts/ci-boot-normal-macos.sh'), 'utf8');
  const job = (text: string, name: string) => {
    const at = text.indexOf(`\n  ${name}:\n`);
    const next = text.slice(at + 1).search(/\n {2}[a-z-]+:\n/);
    return next < 0 ? text.slice(at) : text.slice(at, at + 1 + next);
  };
  const stepOf = (j: string, at: number) => j.slice(j.lastIndexOf('- name:', at), j.indexOf('\n      - ', at) < 0 ? undefined : j.indexOf('\n      - ', at));

  it('desktop ジョブは build した .app を setup-node の Node で起こし、上限を付け、記録を残す', () => {
    const d = job(ci, 'desktop');
    const build = d.indexOf('run: npm run tauri -- build --bundles app');
    const probe = d.indexOf('run: bash apps/desktop/scripts/ci-boot-normal-macos.sh');
    expect(build).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(build);
    const step = stepOf(d, probe);
    expect(step).toContain('--node "$(command -v node)"');
    expect(step).toMatch(/timeout-minutes: [1-5]\n/);
    // 失敗の札の段が落ちても、正常な道の段は走らせる（どちらが壊れたかを 1 回で見分ける）。
    expect(step).toMatch(/if: \$\{\{ !cancelled\(\) && steps\.app\.outcome == 'success' \}\}/);
    expect(d).toMatch(/id: app\n/);
    expect(d.slice(probe)).toContain('name: boot-normal-macos');
  });
  it('release の macos ジョブは、署名した後、dmg の前に、署名した .app で同じ確かめをする', () => {
    const m = job(release, 'macos');
    const sign = m.indexOf('run: bash apps/desktop/scripts/ci-sign-macos.sh');
    const probe = m.indexOf('run: bash apps/desktop/scripts/ci-boot-normal-macos.sh');
    const dmg = m.indexOf('make-dmg.sh');
    expect(sign).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(sign);
    expect(dmg).toBeGreaterThan(probe);
    const step = stepOf(m, probe);
    expect(step).toContain('--node "$(command -v node)"');
    expect(step).toContain('release/bundle/macos/Hangar.app');
    expect(step).toMatch(/timeout-minutes: [1-5]\n/);
  });
  it('台本は、一時のホームと最小の PATH で、nodePath と書き出しの先を渡して起こし、判定を通す', () => {
    expect(sh).toContain('env -i');
    expect(sh).toContain('HANGAR_HOME=');
    expect(sh).toContain('HANGAR_BOOT_PROBE=');
    expect(sh).toContain('PATH="$base_path"');
    expect(sh).toContain('base_path=/usr/bin:/bin:/usr/sbin:/sbin');
    expect(sh).toContain('nodePath');
    expect(sh).toContain('boot-normal-check.ts');
    // 写す先は実の名前に直す（殻はシンボリックリンクの混じるパスでリソースを決められない）。
    expect(sh).toContain('pwd -P');
  });
});
