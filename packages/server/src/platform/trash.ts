import { execFile } from 'node:child_process';
import fs from 'node:fs';

/**
 * ファイルやフォルダを OS のゴミ箱へ移す（docs/design.md の原則「ファイルを消さない」の例外）。
 * セッションの削除（sessions/trash.ts）が、手元の本文をゴミ箱へ移すのに使う。
 * 利用者がゴミ箱から戻せるようにするため、移せなかったら投げるだけで、rm には決して倒さない。
 *
 * - macOS：`osascript -l JavaScript` で NSFileManager の trashItemAtURL を呼ぶ。Finder を操作しないので、自動操作の許可を求められない。
 * - Windows：PowerShell で Microsoft.VisualBasic.FileIO.FileSystem の DeleteFile（フォルダは DeleteDirectory）に SendToRecycleBin を渡す。
 * - Linux：`gio trash`。
 * パスは台本の文字列に埋めない。macOS は run(argv) の引数、Windows は環境変数で渡し、引用符や空白を含むパスでも台本が壊れないようにする。
 */

/** ゴミ箱へ移せなかった。message は OS の答え（標準エラー）か、移せなかった理由である。 */
export class TrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrashError';
  }
}

/** コマンドを 1 回打った結果。error は起こせなかったとき（コマンドが無いなど）と、締め切りで止めたときに入る。 */
export type TrashRunResult = { code: number | null; stdout: string; stderr: string; error?: Error };
/** コマンドを打つ口。試験が差し替える。 */
export type TrashRun = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<TrashRunResult>;
/** 打つコマンド。 */
export type TrashCommand = { file: string; args: string[]; env: NodeJS.ProcessEnv };
/** ゴミ箱へ移す口。sessions/trash.ts が受け取る形である。 */
export type TrashFn = (p: string) => Promise<void>;

/** 1 回のコマンドの締め切り。PowerShell の起動は CI の Windows で数秒かかることがある。 */
const TRASH_TIMEOUT_MS = 60_000;

/**
 * macOS の台本。JavaScript for Automation で Foundation を呼ぶ。
 * 移した先（resultingItemURL）と誤り（error）の受け口は null で渡す。
 * JXA の Ref() を受け口に渡すと、osascript ごと落ちる（終了コード 139、2026-10-16 に macOS 27 で実測）。
 * 落ちても移動は済んでいることがあり、成否が読めなくなるので、受け口は使わず、成否の真偽だけを受け取る。
 * 移せなかった理由は分からないが、無いパスは呼ぶ前に断っており、移した後に元のパスが残っていないことも確かめる。
 */
const MAC_SCRIPT = [
  'function run(argv) {',
  "  ObjC.import('Foundation');",
  '  var url = $.NSURL.fileURLWithPath(argv[0]);',
  '  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, null, null)) {',
  "    throw new Error('trashItemAtURL failed');",
  '  }',
  "  return '';",
  '}',
].join('\n');

/**
 * Windows の台本。パスは環境変数 HANGAR_TRASH_PATH で受ける。
 * UICancelOption を ThrowException にし、失敗を終了コードで返す。
 */
const WIN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  '$p = $env:HANGAR_TRASH_PATH',
  '$ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs',
  '$bin = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin',
  '$cancel = [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException',
  'if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, $ui, $bin, $cancel) }',
  "elseif (Test-Path -LiteralPath $p -PathType Leaf) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, $ui, $bin, $cancel) }",
  "else { throw ('not found: ' + $p) }",
].join('; ');

/** OS ごとに打つコマンドを組む。 */
export function trashCommand(p: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): TrashCommand {
  if (platform === 'darwin') return { file: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', MAC_SCRIPT, p], env };
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT], env: { ...env, HANGAR_TRASH_PATH: p } };
  return { file: 'gio', args: ['trash', '--', p], env };
}

/** 本物の実行。終了コードと出力を受け取る。 */
const realRun: TrashRun = (file, args, env) => new Promise((resolve) => {
  execFile(file, args, { env, encoding: 'utf8', windowsHide: true, timeout: TRASH_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
    resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', error: err && code === null ? err : undefined });
  });
});

/** そのパスに何かあるか。壊れたリンクも「ある」と見る。 */
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * p（ファイルかフォルダ）を OS のゴミ箱へ移す。ゴミ箱の中のどこへ入ったかは返さない（OS が同じ名前を避けて名前を変えることがある）。
 * 無いパス、コマンドの失敗、コマンドが成功を返したのに元のパスが残っているときは TrashError を投げる。どの場合も元のパスには触らない。
 */
export async function moveToTrash(p: string, o: { platform?: NodeJS.Platform; run?: TrashRun; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  if (!exists(p)) throw new TrashError(`not found: ${p}`);
  const platform = o.platform ?? process.platform;
  const c = trashCommand(p, platform, o.env ?? process.env);
  const r = await (o.run ?? realRun)(c.file, c.args, c.env);
  if (r.error) throw new TrashError(r.error.message);
  if (r.code !== 0) throw new TrashError(r.stderr.trim() || `${c.file} exited with ${r.code}`);
  // 成功を返しても、移っていなければ移せなかったものとして扱う。黙って残ったままの本文を「消した」と記録しないためである。
  if (exists(p)) throw new TrashError(`still exists after trashing: ${p}`);
}
