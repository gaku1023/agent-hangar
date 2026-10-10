// Windows で、外のアプリ（ターミナル、エディタ、ブラウザ）を Hangar のジョブの外で起こす。
//
// Windows の殻は、サーバとその孫をジョブオブジェクトに入れ、Hangar を閉じるとジョブごと止める（apps/desktop/src-tauri/src/winjob.rs）。
// サーバがそのまま起こしたものはジョブに入るので、Hangar を閉じると、開いた Windows Terminal や VS Code の窓まで止まる。
// Node は子を起こすときに CREATE_BREAKAWAY_FROM_JOB を付けられない。
// そこで殻の実行ファイルを起こし役にする。殻は `--hangar-breakaway <起こすもの> <引数の 1 行>` で起こされると、窓を出さずに、
// 印を付けて子を起こし、子の終わりを待ってその終了コードで降りる（src-tauri/src/breakaway.rs）。
// 起こされた子とその子孫はジョブの外にいるので、Hangar を閉じても残る（macOS の open で開いたアプリと同じ）。
import type { Exec } from './open.ts';

/** 殻が起こし役として振る舞う印。正本は src-tauri/src/breakaway.rs の FLAG で、一致は試験で縛る。 */
export const BREAKAWAY_FLAG = '--hangar-breakaway';

/**
 * Windows の規則（CommandLineToArgvW と MSVC の C 実行時）で読み戻せるように 1 つの語を引用する。
 * Node（libuv の quote_cmd_arg）と同じ規則である。空白も引用符も無ければそのまま、空なら ""。
 * 引用するときは、" の前の \ と、末尾の \ を倍にし、" を \" にする。
 */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(slashes) + ch;
    }
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/**
 * Exec を、殻の起こし役越しに起こす形へ包む。
 * 起こし役は受け取った 1 行を、起こすものの名前の後ろにそのまま付けて CreateProcess に渡す。
 * なので、引数の引用はここで Node と同じに済ませる。
 * - verbatim：cmd.exe へ自前で組んだ 1 行なので、引用せずに並べる（Node の windowsVerbatimArguments と同じ）。
 * - shell：Node と同じく `cmd.exe /d /s /c "<コマンドと引数を空白でつないだもの>"` に組み直す。
 * 起こし役の終了コードは子の終了コードなので、結果はそのまま返す。
 */
export function breakawayExec(inner: Exec, launcher: string, o: { comspec?: string } = {}): Exec {
  return (cmd, args, opts) => {
    let file = cmd;
    let line: string;
    if (opts?.shell) {
      file = o.comspec ?? process.env.ComSpec ?? 'cmd.exe';
      line = `/d /s /c "${[cmd, ...args].join(' ')}"`;
    } else if (opts?.verbatim) {
      line = args.join(' ');
    } else {
      line = args.map(quoteWindowsArg).join(' ');
    }
    return inner(launcher, [BREAKAWAY_FLAG, file, line], opts?.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs });
  };
}
