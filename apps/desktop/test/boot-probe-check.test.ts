import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { judge } from '../scripts/boot-probe-check.ts';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '../..');
const script = path.join(app, 'scripts/boot-probe-check.ts');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'boot-probe-'));

// CI の「Node の無い機械で、読み込み画面が失敗の札に切り替わる」段は、殻が書き出した頁の様子（lib.rs の boot_probe）を読んで判定する。
// 判定は macOS と Windows で同じものを使う。
describe('頁が描いた様子の判定', () => {
  const want = { kind: 'other', detail: /Node \d+/ };
  const card = { level: 'error', card: true, kind: 'other', lang: 'ja', title: '起動できませんでした', detail: 'Node 22（arm64）が見つかりません。' };
  const text = (o: unknown) => JSON.stringify(o);

  it('頁がまだ何も書いていなければ、待ち続ける', () => {
    expect(judge(null, want)).toMatchObject({ done: false });
    expect(judge('{"level":', want)).toMatchObject({ done: false });
  });
  it('待っている間の様子なら、待ち続ける', () => {
    expect(judge(text({ ...card, level: null, card: false, kind: null, title: '', detail: '' }), want)).toMatchObject({ done: false });
  });
  it('札が出て、種類と詳細が合えば通す', () => {
    expect(judge(text(card), want)).toMatchObject({ done: true, ok: true });
    expect(judge(text({ ...card, lang: 'en', detail: 'Node 22 (arm64) was not found.' }), want)).toMatchObject({ done: true, ok: true });
  });
  it('読み込みが終わった合図を描いたら、Node が見つかったとして落とす', () => {
    const r = judge(text({ ...card, level: 'ready', card: false, kind: null, title: '', detail: '' }), want);
    expect(r).toMatchObject({ done: true, ok: false });
    expect(r.message).toContain('Node');
  });
  it('印は立ったのに札が見えない、見出しが空、種類か詳細が違うときは落とす', () => {
    for (const bad of [{ card: false }, { title: '' }, { kind: 'port-in-use' }, { detail: 'listen EADDRINUSE' }]) {
      expect(judge(text({ ...card, ...bad }), want), JSON.stringify(bad)).toMatchObject({ done: true, ok: false });
    }
  });
});

describe('待つ口（wait）', () => {
  const run = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, 'wait', ...args], { encoding: 'utf8' });

  it('札が書かれていれば、すぐに通す', () => {
    const d = tmp();
    const f = path.join(d, 'probe.json');
    fs.writeFileSync(f, JSON.stringify({ level: 'error', card: true, kind: 'other', lang: 'ja', title: 't', detail: 'Node 22' }));
    const r = run([f, '--kind', 'other', '--detail', 'Node \\d+', '--timeout', '5']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('"level":"error"');
  });
  it('上限まで何も書かれなければ、落とす', () => {
    const d = tmp();
    const started = Date.now();
    const r = run([path.join(d, 'probe.json'), '--kind', 'other', '--detail', 'Node', '--timeout', '1']);
    expect(r.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.stderr).toContain('1 秒');
  });
  it('見張る殻が先に終わったら、上限を待たずに落とす', async () => {
    const d = tmp();
    // 終わって回収された殻。spawnSync の間はこの試験の側が子を回収できないので、先に終わりを待つ。
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.on('exit', r));
    const started = Date.now();
    const r = run([path.join(d, 'probe.json'), '--kind', 'other', '--detail', 'Node', '--timeout', '30', '--pid', String(child.pid)]);
    expect(r.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.stderr).toContain('終わった');
  });
  it('使い方が違えば、2 で終わる', () => {
    expect(run([]).status).toBe(2);
    expect(run(['f', '--kind']).status).toBe(2);
  });
});

// 段は CI の 2 つのジョブにある。build した殻を、Node が見つからない環境で起こす。
describe('CI の段', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const job = (name: string) => {
    const at = ci.indexOf(`\n  ${name}:\n`);
    const next = ci.slice(at + 1).search(/\n {2}[a-z-]+:\n/);
    return next < 0 ? ci.slice(at) : ci.slice(at, at + 1 + next);
  };
  it('desktop ジョブは .app を build してから、Node の無い状態で起こして札を確かめ、撮った絵を残す', () => {
    const d = job('desktop');
    const build = d.indexOf('run: npm run tauri -- build --bundles app');
    const probe = d.indexOf('run: bash apps/desktop/scripts/ci-boot-probe-macos.sh --hide-system-node');
    expect(build).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(build);
    expect(d.slice(probe)).toContain('actions/upload-artifact');
    // 段の上限。待ちが固まってもジョブの上限まで引きずらない。
    expect(d.slice(d.lastIndexOf('- name:', probe))).toMatch(/timeout-minutes: [1-5]\n/);
  });
  it('windows ジョブは、作ったインストーラで入れた殻を Node の無い状態で起こして札を確かめる', () => {
    const w = job('windows');
    const installer = w.indexOf('./.github/actions/windows-installer');
    const probe = w.indexOf('run: pwsh -NoProfile -File apps/desktop/scripts/ci-boot-probe-windows.ps1');
    expect(installer).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(installer);
    expect(w.slice(w.lastIndexOf('- name:', probe))).toMatch(/timeout-minutes: [1-5]\n/);
  });
  it('macOS の台本は、一時のホームと最小の PATH で、殻に書き出しの先を渡して起こし、判定を通す', () => {
    const sh = fs.readFileSync(path.join(app, 'scripts/ci-boot-probe-macos.sh'), 'utf8');
    expect(sh).toContain('env -i');
    expect(sh).toContain('HANGAR_HOME=');
    expect(sh).toContain('HANGAR_BOOT_PROBE=');
    expect(sh).toContain('PATH=/usr/bin:/bin:/usr/sbin:/sbin');
    expect(sh).toContain('nodePath');
    expect(sh).toContain('boot-probe-check.ts');
  });
  // 殻が探す場所のうちホームの外にあるもの（node.rs の UNIX_NODE_PLACES の / で始まるもの）は、一時のホームでは外れない。
  // ランナーの Homebrew の Node がそこにあると殻が見つけてしまうので、台本はその全部を脇へ退ける。
  it('macOS の台本は、殻が探す場所のうちホームの外のものを、すべて脇へ退ける候補に入れる', () => {
    const sh = fs.readFileSync(path.join(app, 'scripts/ci-boot-probe-macos.sh'), 'utf8');
    const places = fs.readFileSync(path.join(app, 'src-tauri/src/node.rs'), 'utf8').match(/pub const UNIX_NODE_PLACES: &\[Place\] = &\[([\s\S]*?)\n\];/)?.[1];
    expect(places, 'UNIX_NODE_PLACES が見つかりません').toBeDefined();
    const fixed = [...places!.matchAll(/Place::Fixed\("(\/[^"]+)"\)/g)].map((m) => m[1]!);
    const versions = [...places!.matchAll(/parent: "(\/[^"]+)",\s*leaf: "([^"]+)"/g)].map((m) => `${m[1]}/*/${m[2]}`);
    expect(fixed.length).toBeGreaterThan(0);
    expect(versions.length).toBeGreaterThan(0);
    for (const p of [...fixed, ...versions]) expect(sh, p).toContain(` ${p}`);
  });
  it('Windows の台本も、一時のホームと書き出しの先を渡し、PATH から node を外して起こす', () => {
    const ps = fs.readFileSync(path.join(app, 'scripts/ci-boot-probe-windows.ps1'), 'utf8');
    expect(ps).toContain('HANGAR_HOME');
    expect(ps).toContain('HANGAR_BOOT_PROBE');
    expect(ps).toContain('nodePath');
    expect(ps).toContain('node.exe');
    expect(ps).toContain('boot-probe-check.ts');
  });
});
