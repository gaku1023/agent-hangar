import fs from 'node:fs';
import path from 'node:path';
import { OPENCODE_VERIFIED_RANGE, type OpencodeStatusDto } from '@agent-hangar/shared';
import { captureOutput } from '../../../platform/capture.ts';
import { needsShell } from '../../../platform/exec.ts';

/**
 * 手元の opencode の版と、確かめた範囲との突き合わせ（docs/design.md「opencode の検出（ベータ）」）。
 * 範囲の外でも起動は止めない。知らせの種（範囲外と 1.x）を出すだけにする（決定 8）。
 */

/**
 * 版の判定。
 * verified は確かめた範囲の中、unverified は範囲の外、legacy は 1.x（2.x と API の形が違う古い系統）、unknown は読めない。
 */
export type OpencodeVersionVerdict = 'verified' | 'unverified' | 'legacy' | 'unknown';

/** `opencode --version` の出力（`2.1.4`）から版を取り出す。前後の語と、後ろに付く先行版の印（`-beta.1`）は読み捨てる。 */
export function opencodeVersionOf(out: string): string | null {
  return /\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
}

/**
 * 版を範囲と突き合わせる。範囲は区切りごとの数か x（その区切りを問わない）で、範囲より後ろの区切りは見ない。
 * 2.1.x なら 2.1.0 から 2.1 の終わりまでが中である。
 */
export function judgeOpencodeVersion(version: string | null, range: string = OPENCODE_VERIFIED_RANGE): OpencodeVersionVerdict {
  const v = version === null ? null : opencodeVersionOf(version);
  if (v === null) return 'unknown';
  const parts = v.split('.').map((p) => Number.parseInt(p, 10));
  if (parts[0] === 1) return 'legacy';
  const inRange = range.split('.').every((r, i) => r === 'x' || Number.parseInt(r, 10) === parts[i]);
  return inRange ? 'verified' : 'unverified';
}

/** macOS と Linux で opencode に渡す PATH の固定の部分。opencode の置き場はこの前に足す。 */
const POSIX_BASE_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
/** macOS と Linux で呼び手の環境から写す鍵。ほかは何も渡さない。 */
const POSIX_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'] as const;
/**
 * Windows で写す鍵。OS の DLL と一時ディレクトリとホームを引くのに要る最小である。
 * 起動（serve）の許可リストは段 G で実機を見て決める。ここは版を読むためだけの仮の一覧である。
 */
const WINDOWS_KEYS = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'] as const;

/**
 * opencode の版を読むときの空の環境。
 * hangar を Claude Code のセッションから起こすと、呼び手の印（CLAUDE で始まる鍵）と hangar の印（HANGAR_*）がサーバに入っている。
 * opencode は環境から設定（OPENCODE_* やプロバイダーの API キー）を読むので、版を読むだけでも決まった鍵のほかは渡さない。
 * PATH の先頭は opencode の置き場にする。npm で入れた opencode は `#!/usr/bin/env node` の台本で、隣の node を引くからである。
 */
export function opencodeProbeEnv(bin: string, src: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (platform === 'win32') {
    for (const k of WINDOWS_KEYS) if (src[k] !== undefined) env[k] = src[k];
    const root = src.SystemRoot ?? 'C:\\Windows';
    env.Path = [path.win32.dirname(bin), path.win32.join(root, 'System32'), root].join(';');
    return env;
  }
  for (const k of POSIX_KEYS) if (src[k] !== undefined) env[k] = src[k];
  env.LANG ??= 'en_US.UTF-8';
  const dir = path.posix.dirname(bin);
  env.PATH = [...(POSIX_BASE_PATH.includes(dir) ? [] : [dir]), ...POSIX_BASE_PATH].join(':');
  return env;
}

export type LocalOpencodeDeps = {
  /** いまの opencode の場所。見つからなければ null。呼ばれた時点の値を読む。 */
  bin: () => string | null;
  /** 空の環境を作る元。試験が呼び手の印を混ぜて渡す。既定はサーバの環境。 */
  env?: NodeJS.ProcessEnv;
  /** --version の時間の上限。 */
  timeoutMs?: number;
};

/**
 * 手元の opencode を読む係。版は `--version` を空の環境で 1 回だけ打って読む。
 * 同じファイル（パス、更新時刻、大きさ）なら打ち直さない。同時に聞かれても 1 回にまとめる。
 * 読めなかった答えも覚える（壊れた opencode を聞かれるたびに起こさない）。時間切れと起動の失敗だけは覚えず、次に聞かれたら打ち直す。
 */
export class LocalOpencode {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: LocalOpencodeDeps) {}

  /** GET /api/opencode/status の答え。決して拒否しない。 */
  status = async (): Promise<OpencodeStatusDto> => {
    const bin = this.deps.bin();
    const st = bin ? fs.statSync(bin, { throwIfNoEntry: false }) : undefined;
    if (!bin || !st?.isFile()) return { found: false, version: null, verified: false };
    const version = await this.version(bin, `${bin}\0${st.mtimeMs}\0${st.size}`);
    return { found: true, version, verified: judgeOpencodeVersion(version) === 'verified' };
  };

  private version(bin: string, key: string): Promise<string | null> {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const p = captureOutput(bin, ['--version'], { timeoutMs: this.deps.timeoutMs ?? 5000, env: opencodeProbeEnv(bin, this.deps.env), stderr: true, shell: needsShell(bin) })
      .then((r) => opencodeVersionOf(r.stdout) ?? opencodeVersionOf(r.stderr))
      .catch(() => {
        this.cache.delete(key);
        return null;
      });
    this.cache.set(key, p);
    return p;
  }
}
