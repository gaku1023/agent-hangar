// CI の「Node の無い機械で、読み込み画面が失敗の札に切り替わる」段の判定。macOS と Windows の台本（ci-boot-probe-*）が呼ぶ。
// 殻は HANGAR_BOOT_PROBE を持って起きると、起動画面が描いた様子をそのファイルへ書く（src-tauri/src/bootprobe.rs、loading/boot.js の report）。
// ここはそのファイルを読み、札が出て、種類と詳細が期待どおりになるまで待つ。
// 使い方:
//   node --experimental-strip-types scripts/boot-probe-check.ts wait <ファイル> --kind <種類> --detail <正規表現> --timeout <秒> [--pid <殻の pid>]
//     通れば 0、落ちれば 1、使い方が違えば 2 で終わる。最後に読んだ様子を標準出力に書く。
// CI の段は npm ci の後でなくても動くよう、Node が型を剥がすだけで動く書き方（import は node: だけ）にしておく。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 起動画面が描いた様子。loading/boot.js の report が渡す 6 つ。 */
export type Drawn = { level: string | null; card: boolean; kind: string | null; lang: string; title: string; detail: string };

export type Want = { kind: string; detail: RegExp };

export type Verdict = { done: boolean; ok: boolean; message: string };

const wait = (message: string): Verdict => ({ done: false, ok: false, message });
const fail = (message: string): Verdict => ({ done: true, ok: false, message });

/** 書き出されたファイルの中身（無ければ null）を判定する。札が出るまでは done が偽である。 */
export function judge(raw: string | null, want: Want): Verdict {
  if (raw === null) return wait('頁はまだ何も書いていない');
  let d: Partial<Drawn>;
  try {
    d = JSON.parse(raw) as Partial<Drawn>;
  } catch {
    return wait('書き出しを読めない');
  }
  if (d.level === 'ready') return fail('頁は読み込みが終わった合図を描いた。殻が Node を見つけて、サーバが起きている');
  if (d.level !== 'error') return wait('頁は待っている間の画面のまま');
  const wrong: string[] = [];
  if (d.card !== true) wrong.push('札が見えていない');
  if (!d.title) wrong.push('札の見出しが空');
  if (d.kind !== want.kind) wrong.push(`種類が ${String(d.kind)}（期待は ${want.kind}）`);
  if (typeof d.detail !== 'string' || !want.detail.test(d.detail)) wrong.push(`詳細が ${want.detail} に合わない`);
  if (wrong.length > 0) return fail(`札は出たが、${wrong.join('、')}`);
  return { done: true, ok: true, message: `札が出た（${d.title}）` };
}

/** 殻がまだ生きているか。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

type Args = { file: string; want: Want; timeoutS: number; pid: number | null };

function parseArgs(argv: string[]): Args | null {
  const [cmd, file, ...rest] = argv;
  if (cmd !== 'wait' || !file) return null;
  const opt: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    const v = rest[i + 1];
    if (!k?.startsWith('--') || v === undefined) return null;
    opt[k.slice(2)] = v;
  }
  const timeoutS = Number(opt.timeout);
  if (!opt.kind || !opt.detail || !Number.isFinite(timeoutS) || timeoutS <= 0) return null;
  const pid = opt.pid === undefined ? null : Number(opt.pid);
  if (pid !== null && !Number.isInteger(pid)) return null;
  return { file, want: { kind: opt.kind, detail: new RegExp(opt.detail) }, timeoutS, pid };
}

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  if (!a) {
    process.stderr.write('使い方: boot-probe-check.ts wait <ファイル> --kind <種類> --detail <正規表現> --timeout <秒> [--pid <pid>]\n');
    return 2;
  }
  const deadline = Date.now() + a.timeoutS * 1000;
  let raw: string | null = null;
  let v: Verdict = wait('');
  for (;;) {
    raw = read(a.file);
    v = judge(raw, a.want);
    if (v.done) break;
    if (a.pid !== null && !alive(a.pid)) {
      // 終わる間際に書いたものを拾い直す。
      raw = read(a.file);
      v = judge(raw, a.want);
      if (!v.done) v = fail(`札が出る前に殻が終わった（${v.message}）`);
      break;
    }
    if (Date.now() >= deadline) {
      v = fail(`${a.timeoutS} 秒待っても札が出ない（${v.message}）`);
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stdout.write(`${raw ?? '(書き出し無し)'}\n`);
  (v.ok ? process.stdout : process.stderr).write(`${v.message}\n`);
  return v.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
