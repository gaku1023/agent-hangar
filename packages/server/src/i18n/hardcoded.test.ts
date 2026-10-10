import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * サーバのソースに、辞書の鍵へ移っていない日本語の直書きがどれだけ残っているかを、ファイルごとに数える。
 * 数えるのは、文字列、テンプレート、JSX の文のうち、かなか漢字を含むものが始まる行である（コメントと試験は数えない）。
 * 許可の一覧と数が食い違えば落ちる。増やしたときは、辞書へ移すか、理由を添えて一覧に足す。
 * 減らしたときは、一覧の数を下げる。残りを黙って増やさないための歯止めである。
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAPANESE = /[぀-ヿ一-鿿]/;

const LOG = '開発者向けのログの行。画面にも Claude にも出さない';
const FILE_BODY = '利用者の PC に置くファイルの中身（スクリプトとその注釈）。文言ではない';
const SYNC = '同期の文。段 4 の PR 14 と 18 で作り直すときに鍵へ移す';
const DB = 'DB の起動の失敗の文と、DB の中の注釈。標準エラーかファイルへ出る。鍵へ移すのは別の PR';
const BASELINE = 'DB に保存する自動の要約の本文。書いた文は言語を変えても残るので、言語の扱いを決めてから鍵へ移す';
const FIRST_NAME = '最初に保存するときの名前。書いたあとは利用者が変えられるデータで、言語を変えても書き直さない';
const INTERNAL = '呼び手の誤りを弾く内部の検査の文。利用者には届かない（受け取った側は例外の名前だけを記録し、文は捨てる）';
const TEST_SUPPORT = '試験用の偽物の中身。製品では使わない';
const CLI = 'hangar config apply と restore の CLI が端末に出す文。packages/cli は日本語だけで、鍵へ移すのは CLI の多言語化と一緒にする';
const LEFT = '利用者に見える文で、まだ鍵へ移していない。次に画面の文を鍵へ移すときに一緒に移す';

/** ファイル（server/src からの相対）ごとの、直書きの日本語の行の数と、残す理由。 */
const ALLOWED: Record<string, { lines: number; why: string }> = {
  'boot/bootError.ts': { lines: 1, why: LOG },
  'boot/home.ts': { lines: 1, why: LOG },
  'boot/http.ts': { lines: 1, why: LOG },
  'boot/runs.ts': { lines: 2, why: LOG },
  'boot/stopping.ts': { lines: 2, why: LOG },
  'boot/summary.ts': { lines: 1, why: LOG },
  'boot/sync.ts': { lines: 1, why: LOG },
  'config/accounts.ts': { lines: 1, why: FIRST_NAME },
  'config/shellHook.ts': { lines: 3, why: FILE_BODY },
  'config/shellWrap.ts': { lines: 1, why: LOG },
  'db/backup.ts': { lines: 3, why: DB },
  'db/migrations.ts': { lines: 1, why: DB },
  'db/notify.ts': { lines: 3, why: LOG },
  'db/open.ts': { lines: 1, why: DB },
  'http/testing.ts': { lines: 9, why: TEST_SUPPORT },
  'indexer/baseline.ts': { lines: 11, why: BASELINE },
  'launch/wrapper.ts': { lines: 3, why: FILE_BODY },
  'platform/proc.ts': { lines: 1, why: LOG },
  'projects/memo.ts': { lines: 1, why: LOG },
  'projects/scratch.ts': { lines: 1, why: FIRST_NAME },
  'provider/claude-code/compat/localClaude.ts': { lines: 1, why: LOG },
  'provider/claude-code/compat/log.ts': { lines: 1, why: LOG },
  'provider/claude-code/config/accountAuth.ts': { lines: 1, why: LOG },
  'provider/claude-code/config/statusline.ts': { lines: 1, why: FILE_BODY },
  'provider/claude-code/index.ts': { lines: 1, why: INTERNAL },
  'runs/manager.ts': { lines: 4, why: LOG },
  'runs/queries.ts': { lines: 1, why: LEFT },
  'sessions/park.ts': { lines: 1, why: LOG },
  'summary/job.ts': { lines: 2, why: LOG },
  'sync/apply.ts': { lines: 4, why: SYNC },
  'sync/client.ts': { lines: 6, why: SYNC },
  'sync/config/apply.ts': { lines: 26, why: CLI },
  'sync/config/bundle.ts': { lines: 17, why: INTERNAL },
  'sync/config/inbox.ts': { lines: 1, why: INTERNAL },
  'sync/config/service.ts': { lines: 4, why: LOG },
  'sync/copy.ts': { lines: 8, why: SYNC },
  'sync/crypto.ts': { lines: 6, why: SYNC },
  'sync/engine.ts': { lines: 9, why: SYNC },
  'sync/pruneBackups.ts': { lines: 3, why: SYNC },
  'sync/puller.ts': { lines: 7, why: SYNC },
  'sync/uploader.ts': { lines: 2, why: SYNC },
  'sync/usage.ts': { lines: 1, why: SYNC },
  'tmux/tmux.ts': { lines: 1, why: INTERNAL },
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'i18n' || e.name === 'node_modules' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function japaneseLines(file: string): number {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const visit = (n: ts.Node): void => {
    const literal = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
    if (literal && JAPANESE.test(n.text)) lines.add(sf.getLineAndCharacterOfPosition(n.getStart()).line);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines.size;
}

describe('サーバに残る日本語の直書き', () => {
  const actual: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    const n = japaneseLines(file);
    // 許可の一覧は / で書く。Windows の path.relative は \ を返すので、そろえてから比べる。
    if (n > 0) actual[path.relative(SRC, file).split(path.sep).join('/')] = n;
  }

  it('ファイルごとの行数が、許可の一覧と同じである', () => {
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.lines]));
    expect(actual).toEqual(expected);
  });

  it('許可の一覧の理由は、どれも書いてある', () => {
    for (const [file, a] of Object.entries(ALLOWED)) expect([file, a.why.trim() !== '']).toEqual([file, true]);
  });

  it('理由の定数は、一覧のどこかで使っている', () => {
    const used = new Set(Object.values(ALLOWED).map((a) => a.why));
    for (const why of [LOG, FILE_BODY, SYNC, DB, BASELINE, FIRST_NAME, INTERNAL, TEST_SUPPORT, CLI, LEFT]) expect([why, used.has(why)]).toEqual([why, true]);
  });
});
