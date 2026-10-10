/**
 * Windows の `bin\hangar.cmd` が呼ぶ入口。hangar.sh の Windows 版にあたる。
 * 配布版に同梱した cli.mjs は、better-sqlite3 などのネイティブモジュールを隣から読む。
 * ネイティブモジュールは Node の ABI に縛られるので、manifest.json と同じメジャー版とアーキテクチャの Node だけで動かす。
 * cmd は batch で JSON を読めないので、PATH などで見つけた Node でこの入口だけを動かし、残りはここで決める。
 * この入口は依存を持たない。同梱の束の中で単独の 1 ファイルとして動く。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Want = { nodeMajor: number; arch: string };
export type Probed = { major: number; arch: string };

/** 候補を 1 つ起動して版とアーキテクチャを訊く。答えなければ undefined。 */
export function probeNode(node: string): Probed | undefined {
  const r = spawnSync(node, ['-p', 'process.versions.node.split(".")[0] + " " + process.arch'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.error || r.status !== 0) return undefined;
  // 前置きや後置きの行が混ざっても拾えるように、全行から探す。
  for (const line of r.stdout.split(/\r?\n/).reverse()) {
    const m = /^(\d+) ([a-z0-9]+)$/.exec(line.trim());
    if (m) return { major: Number(m[1]), arch: m[2]! };
  }
  return undefined;
}

/** 候補を先頭から見て、版もアーキも合う最初の 1 つを返す。同じ場所は 1 度しか探らない。 */
export function chooseNode(candidates: string[], want: Want, probe: (node: string) => Probed | undefined): string | undefined {
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const got = probe(c);
    if (got && got.major === want.nodeMajor && got.arch === want.arch) return c;
  }
  return undefined;
}

const versionKey = (name: string): [number, number, number] | undefined => {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/**
 * Windows で Node がありそうな場所。
 * 順は、HANGAR_NODE、settings.json の nodePath、公式のインストーラの入れ先、nvm-windows（新しい版が先）。
 * 殻（src-tauri の node.rs）の探索と同じ並びにそろえてある。
 * パスは常に Windows の書式で組むので、どの OS 上でも同じ答えになる。
 */
export function windowsNodeCandidates(env: NodeJS.ProcessEnv, settingsNodePath: string | undefined, listDir: (dir: string) => string[]): string[] {
  const w = path.win32;
  const all: string[] = [];
  if (env.HANGAR_NODE) all.push(env.HANGAR_NODE);
  if (settingsNodePath) all.push(settingsNodePath);
  if (env.ProgramFiles) all.push(w.join(env.ProgramFiles, 'nodejs', 'node.exe'));
  if (env.LOCALAPPDATA) all.push(w.join(env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'));
  if (env.NVM_SYMLINK) all.push(w.join(env.NVM_SYMLINK, 'node.exe'));
  if (env.NVM_HOME) {
    const home = env.NVM_HOME;
    const versions = listDir(home)
      .map((n) => ({ n, k: versionKey(n) }))
      .filter((x): x is { n: string; k: [number, number, number] } => x.k !== undefined)
      .sort((a, b) => b.k[0] - a.k[0] || b.k[1] - a.k[1] || b.k[2] - a.k[2]);
    for (const v of versions) all.push(w.join(home, v.n, 'node.exe'));
  }
  // Windows のパスは大文字小文字を区別しない。
  const seen = new Set<string>();
  return all.filter((p) => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
}

function readSettingsNodePath(hangarHome: string): string | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(hangarHome, 'settings.json'), 'utf8')) as { nodePath?: unknown };
    return typeof v.nodePath === 'string' && v.nodePath.trim() !== '' ? v.nodePath.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readWant(dist: string): Want | string {
  const file = path.join(dist, 'manifest.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return `${file} がありません。アプリの中身が壊れています。agent-hangar を入れ直してください。`;
  }
  try {
    const m = JSON.parse(text) as { nodeMajor?: unknown; arch?: unknown };
    if (typeof m.nodeMajor === 'number' && typeof m.arch === 'string') return { nodeMajor: m.nodeMajor, arch: m.arch };
  } catch {
    // 下の案内へ進む。
  }
  return `${file} から Node の版とアーキテクチャを読めません。アプリの中身が壊れています。agent-hangar を入れ直してください。`;
}

/**
 * dist は束の根（この入口の置き場）。
 * 走っている Node が合えばそのまま cli.mjs を動かす。
 * 合わなければ、合う Node を探して、同じ引数でこの入口を渡し直す。
 */
export async function run(dist: string, argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const want = readWant(dist);
  if (typeof want === 'string') {
    process.stderr.write(want + '\n');
    process.exitCode = 1;
    return;
  }
  const mine: Probed = { major: Number(process.versions.node.split('.')[0]), arch: process.arch };
  // 渡し直された側は、探した側が確かめた Node なので、もう一度は確かめない。輪になるのを避けるためでもある。
  if (env.HANGAR_LAUNCHED === '1' || (mine.major === want.nodeMajor && mine.arch === want.arch)) {
    // 同梱した UI の場所を、束の中から渡す。hangar start が子として起こす server.mjs もこの値を継ぐ。
    process.env.HANGAR_UI_DIST = path.join(dist, 'ui');
    await import(pathToFileURL(path.join(dist, 'cli.mjs')).href);
    return;
  }
  const home = env.HANGAR_HOME || path.join(os.homedir(), '.agent-hangar');
  const candidates = windowsNodeCandidates(env, readSettingsNodePath(home), (d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  });
  const found = chooseNode(candidates, want, probeNode);
  if (found) {
    const r = spawnSync(found, [path.join(dist, 'launch-cli.mjs'), ...argv], { stdio: 'inherit', env: { ...env, HANGAR_LAUNCHED: '1' }, windowsHide: true });
    process.exitCode = r.status ?? 1;
    return;
  }
  process.stderr.write(
    `Node ${want.nodeMajor}（${want.arch}）が見つかりません。` +
      `Node ${want.nodeMajor} を入れるか、環境変数 HANGAR_NODE か ${path.join(home, 'settings.json')} の nodePath で場所を指定してください。\n`,
  );
  process.exitCode = 1;
}
