import fs from 'node:fs';
import path from 'node:path';

/**
 * Claude Code の設定ファイルを書き換えるときの共通の作法。
 * ロックを取り、リンクは実体まで解き、同じディレクトリの一時ファイルから rename する。
 * `~/.claude.json`（claudeJson.ts）と `settings.json` の保持期間（retention.ts）が使う。
 */

/** ロックが取れないときの文言。相手はたいてい Claude Code なので、次の一手を書く。 */
export const LOCK_BUSY_MESSAGE = 'Claude Code が設定を書いている最中のようです。閉じてからもう一度試してください。';

const LOCK_SUFFIX = '.hangar-lock';
const TMP_SUFFIX = '.hangar-tmp';

/**
 * リンクを解いて、実体のパスを返す。
 * 途中のディレクトリも解く。リンク先がまだ無いときも、リンクではなく実体の側を指す。
 * dotfiles のリポジトリへ ~/.claude.json をリンクしている人の設定を、実ファイルで置き換えないためである。
 */
export function resolveRealFile(file: string): string {
  const parent = fs.realpathSync(path.dirname(file));
  let p = path.join(parent, path.basename(file));
  for (let i = 0; i < 16; i++) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return p; // まだ無い。その場所に作る。
    }
    if (!st.isSymbolicLink()) return p;
    p = path.resolve(path.dirname(p), fs.readlinkSync(p));
    try {
      p = path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
  throw new Error(`${file} のシンボリックリンクが深すぎます。`);
}

/** 同期で少し待つ。ロックが空くのを待つだけなので、数十ミリ秒で足りる。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * O_EXCL でロックファイルを作る。取れなければ待ち直し、上限を超えたら書かずに投げる。
 * 落ちたプロセスが残したロックで永久に失敗しないよう、古いものだけは消して取り直す。
 */
export function acquireFileLock(realFile: string, waitMs: number, staleMs: number): () => void {
  const lock = `${realFile}${LOCK_SUFFIX}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try {
        fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          fs.unlinkSync(lock);
        } catch {
          // 既に消えていてもよい。
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let removedStale = false;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
        fs.unlinkSync(lock);
        removedStale = true;
      }
    } catch {
      // 見に行った時点で消えていた、または消せなかった。どちらも取り直しで扱う。
    }
    if (removedStale) continue;
    if (Date.now() >= deadline) throw new Error(LOCK_BUSY_MESSAGE);
    sleepSync(20);
  }
}

/** 実体と同じディレクトリに書いてから rename する。途中で落ちても元のファイルが壊れない。 */
export function writeFileAtomically(realFile: string, content: string, mode: number): void {
  const tmp = `${realFile}${TMP_SUFFIX}`;
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, realFile);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 一時ファイルが作られる前に落ちた。
    }
    throw e;
  }
}
