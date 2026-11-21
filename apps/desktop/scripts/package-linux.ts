import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type LinuxArch = 'x64' | 'arm64';

/** Release の資産の名前。macOS と Windows の `Hangar-<タグ>-<os>-<arch>` に合わせる。 */
export function linuxTarballName(tag: string, arch: LinuxArch): string {
  return `Hangar-${tag}-linux-${arch}.tar.gz`;
}

export type PackageLinuxOptions = {
  /** bundle-server が出した束（cli.mjs、server.mjs、ui、node_modules ほか）。 */
  bundleDir: string;
  /** 同梱する Node の実行ファイル（公式の tar から取り出したもの）。 */
  nodeBinary: string;
  tag: string;
  arch: LinuxArch;
  outDir: string;
};

/**
 * Linux 用の tar を作る。展開すると hangar/ の下に、同梱の Node（node/bin/node）、束（app/）、
 * 同梱の Node で起こす台本（bin/hangar）、版（VERSION）が並ぶ。
 * Mac 用の bin/hangar は Node を探して回る台本なので持ち込まず、置き換える。
 */
export function packageLinux(o: PackageLinuxOptions): { tarball: string; sha256File: string } {
  if (!fs.existsSync(o.nodeBinary)) throw new Error(`同梱する node の実行ファイルがありません: ${o.nodeBinary}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-linux-pkg-'));
  try {
    const root = path.join(work, 'hangar');
    fs.mkdirSync(path.join(root, 'node', 'bin'), { recursive: true });
    fs.copyFileSync(o.nodeBinary, path.join(root, 'node', 'bin', 'node'));
    fs.chmodSync(path.join(root, 'node', 'bin', 'node'), 0o755);
    fs.cpSync(o.bundleDir, path.join(root, 'app'), { recursive: true, filter: (src) => path.basename(src) !== '.gitkeep' });
    // 束の bin/hangar（Mac 用）は app の中に残さず、root の bin/hangar だけを使う。
    fs.rmSync(path.join(root, 'app', 'bin'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'bin'));
    fs.copyFileSync(fileURLToPath(new URL('./hangar-linux.sh', import.meta.url)), path.join(root, 'bin', 'hangar'));
    fs.chmodSync(path.join(root, 'bin', 'hangar'), 0o755);
    fs.writeFileSync(path.join(root, 'VERSION'), `${o.tag}\n`);

    fs.mkdirSync(o.outDir, { recursive: true });
    const name = linuxTarballName(o.tag, o.arch);
    const tarball = path.join(o.outDir, name);
    // 所有者を持ち込まない（GNU tar は --owner/--group、bsdtar は --uid/--gid の形が違うので、両方で通る -c と -C だけにする）。
    execFileSync('tar', ['-czf', tarball, '-C', work, 'hangar']);
    const hash = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    const sha256File = `${tarball}.sha256`;
    fs.writeFileSync(sha256File, `${hash}  ${name}\n`);
    return { tarball, sha256File };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// 使い方: node --import tsx package-linux.ts <束> <node の実行ファイル> <タグ> <x64|arm64> <出力先>
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [bundleDir, nodeBinary, tag, arch, outDir] = process.argv.slice(2);
  if (!bundleDir || !nodeBinary || !tag || (arch !== 'x64' && arch !== 'arm64') || !outDir) {
    console.error('使い方: package-linux.ts <束> <node の実行ファイル> <タグ> <x64|arm64> <出力先>');
    process.exit(2);
  }
  const r = packageLinux({ bundleDir: path.resolve(bundleDir), nodeBinary: path.resolve(nodeBinary), tag, arch, outDir: path.resolve(outDir) });
  console.log(r.tarball);
}
