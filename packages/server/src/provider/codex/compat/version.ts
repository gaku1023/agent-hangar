import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_VERIFIED_RANGE, type CodexStatusDto } from '@agent-hangar/shared';
import { MessageError } from '../../../i18n/message.ts';
import { captureOutput } from '../../../platform/capture.ts';
import { needsShell } from '../../../platform/exec.ts';
import { codexBaseEnv } from '../env.ts';

/**
 * 手元の codex の版と、確かめた範囲との突き合わせ（docs/design.md「Codex の検出（ベータ）」）。
 * 範囲の外でも起動は止めない。知らせの種（範囲外）を出すだけにする（決定 8）。
 */

/** 版の判定。verified は確かめた範囲の中、unverified は範囲の外、unknown は読めない。 */
export type CodexVersionVerdict = 'verified' | 'unverified' | 'unknown';

/** `codex --version` の出力（`codex-cli 0.164.0`）から版を取り出す。前後の語と、後ろに付く先行版の印（`-alpha.1`）は読み捨てる。 */
export function codexVersionOf(out: string): string | null {
  return /\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
}

/**
 * 版を範囲と突き合わせる。範囲は区切りごとの数か x（その区切りを問わない）で、範囲より後ろの区切りは見ない。
 * 0.164.x なら 0.164.0 から 0.164 の終わりまでが中である。
 */
export function judgeCodexVersion(version: string | null, range: string = CODEX_VERIFIED_RANGE): CodexVersionVerdict {
  const v = version === null ? null : codexVersionOf(version);
  if (v === null) return 'unknown';
  const parts = v.split('.').map((p) => Number.parseInt(p, 10));
  const inRange = range.split('.').every((r, i) => r === 'x' || Number.parseInt(r, 10) === parts[i]);
  return inRange ? 'verified' : 'unverified';
}

export type LocalCodexDeps = {
  /** いまの codex の場所。見つからなければ null。呼ばれた時点の値を読む。 */
  bin: () => string | null;
  /** 空の環境を作る元。試験が呼び手の印を混ぜて渡す。既定はサーバの環境。 */
  env?: NodeJS.ProcessEnv;
  /** 1 回の問いの時間の上限。 */
  timeoutMs?: number;
  /** codex の本物の置き場（既定は ~/.codex）。無ければ login status は打たない（打つと置き場が生えるため）。 */
  codexHome?: string;
};

/**
 * 手元の codex を読む係。版は `--version` を空の環境で 1 回だけ打って読む。
 * 同じファイル（パス、更新時刻、大きさ）なら打ち直さない。同時に聞かれても 1 回にまとめる。
 * 読めなかった答えも覚える。時間切れと起動の失敗だけは覚えず、次に聞かれたら打ち直す。
 * ログインの有無は `codex login status` の終了コード（0 ならログイン済み、0 以外は未ログイン、時間切れは null＝分からない）で、ログインや logout で変わるので、聞かれるたびに打つ。
 */
export class LocalCodex {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: LocalCodexDeps) {}

  /** 検出の答え。決して拒否しない。 */
  status = async (): Promise<CodexStatusDto> => {
    const bin = this.deps.bin();
    const st = bin ? fs.statSync(bin, { throwIfNoEntry: false }) : undefined;
    if (!bin || !st?.isFile()) return { found: false, version: null, verified: false, loggedIn: false };
    const [version, loggedIn] = await Promise.all([this.version(bin, `${bin}\0${st.mtimeMs}\0${st.size}`), this.loggedIn(bin)]);
    return { found: true, version, verified: judgeCodexVersion(version) === 'verified', loggedIn };
  };

  private run(bin: string, args: string[], env: NodeJS.ProcessEnv = codexBaseEnv(bin, this.deps.env)): ReturnType<typeof captureOutput> {
    return captureOutput(bin, args, { timeoutMs: this.deps.timeoutMs ?? 5000, env, stderr: true, shell: needsShell(bin) });
  }

  /** 終了コード 0 ならログイン済み、0 以外なら未ログイン。時間切れは分からない（null）。起こせなかったときは偽（起動はそのあと自分で失敗する）。 */
  private loggedIn(bin: string): Promise<boolean | null> {
    // 置き場がまだ無いなら、ログインしたことが無い。打つと codex が置き場（tmp/arg0-*）を作ってしまうので、打たない。
    const home = this.deps.codexHome ?? path.join(os.homedir(), '.codex');
    if (!fs.statSync(home, { throwIfNoEntry: false })?.isDirectory()) return Promise.resolve(false);
    return this.run(bin, ['login', 'status']).then((r) => r.code === 0, (e: unknown) => (e instanceof MessageError && e.text?.key === 'platform.capture.timeout' ? null : false));
  }

  private version(bin: string, key: string): Promise<string | null> {
    const hit = this.cache.get(key);
    if (hit) return hit;
    // 版は一時の CODEX_HOME で読む。既定の置き場に何も作らせず、打ったあとに一時の置き場ごと消す。
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-codex-ver-'));
    const p = this.run(bin, ['--version'], { ...codexBaseEnv(bin, this.deps.env), CODEX_HOME: tmpHome })
      .then((r) => codexVersionOf(r.stdout) ?? codexVersionOf(r.stderr))
      .catch(() => {
        this.cache.delete(key);
        return null;
      })
      .finally(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });
    this.cache.set(key, p);
    return p;
  }
}
