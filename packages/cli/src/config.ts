import fs from 'node:fs';
import type { ConfigExecMark, ConfigItemKind } from '@agent-hangar/shared';
import {
  ApplyError, dbPath, defaultClaudeDir, hangarHome, listBackups, loadSettings, openDb, planApply, planRestore, runApply, runRestore,
  type ApplyPlan, type ApplyPlanItem, type Db,
} from '@agent-hangar/server/src/cliEntry.ts';
import { promptYesNo, type Ask } from './statusline.ts';

/**
 * hangar config apply と hangar config restore。
 * 設定の同期で他の PC から届いた項目を `~/.claude` へ書く、あるいは控えの世代へ戻す。サーバは書かない（全体計画の D9）。
 * 書く処理の本体は server の sync/config/apply.ts で、ここは確認の出し方と、結果の見せ方だけを持つ。
 * 殻の命令（apps/desktop）も、ネイティブの確認を出したあとで、この命令の --yes --json を走らせる。
 */

type Common = {
  /** hangar の置き場。試験は一時のディレクトリを渡す。 */
  home?: string;
  /** 書き込む `~/.claude`。省くと、設定の claudeDir。 */
  claudeDir?: string;
  /** 聞かずに進める。 */
  yes?: boolean;
  /** 機械が読む JSON を 1 行だけ標準出力へ出す（殻が使う）。 */
  json?: boolean;
  /** 端末で対話できるか。省くと標準入力が端末かどうか。 */
  interactive?: boolean;
  ask?: Ask;
  log?: (s: string) => void;
  now?: () => number;
};

export type ConfigApplyOpts = Common & {
  /** 見立てを出すだけで、何も書かない。 */
  plan?: boolean;
  /** 確認した指示書の作成時刻（見立ての createdAt）。違う指示書に替わっていたら書かない。殻が使う。 */
  order?: number;
};

export type ConfigRestoreOpts = Common & {
  /** 戻す世代の名前。省くと一覧を出す。 */
  name?: string;
  /** 戻す先と消す先を出すだけで、何も戻さない。 */
  plan?: boolean;
};

const KIND_LABEL: Record<ConfigItemKind, string> = {
  'claude-md': 'CLAUDE.md', settings: 'settings.json の鍵', keybindings: 'keybindings.json', skills: 'スキル', commands: 'コマンド', agents: 'エージェント', memory: 'メモリ',
};
const MARK_LABEL: Record<ConfigExecMark, string> = { hooks: 'フック', shell: 'シェルのコマンド実行', script: 'スクリプト' };
const MAX_LISTED = 40;

const claudeDirOf = (o: Common, home: string): string => o.claudeDir ?? (loadSettings(home).claudeDir || defaultClaudeDir());

/** 失敗は 1 行にして、JSON のときは符号もつける。終了コードは 1。 */
function fail(o: Common, e: unknown, log: (s: string) => void): number {
  if (!(e instanceof ApplyError)) throw e;
  log(o.json ? JSON.stringify({ ok: false, code: e.code, message: e.message }) : e.message);
  return 1;
}

function counts(p: ApplyPlan): string {
  const c = p.counts;
  const parts: string[] = [];
  if (c.create) parts.push(`新規 ${c.create} 件`);
  if (c.overwrite) parts.push(`上書き ${c.overwrite} 件`);
  if (c.delete) parts.push(`削除 ${c.delete} 件`);
  if (c.conflictRemote) parts.push(`競合で相手を採る ${c.conflictRemote} 件`);
  if (c.conflictMine) parts.push(`競合で手元を残す ${c.conflictMine} 件`);
  return parts.join('、');
}

const opWord = (i: ApplyPlanItem): string => {
  if (i.act === 'keep') return '手元を残す';
  if (i.act === 'remove') return '削除';
  return i.op === 'create' ? '新規' : '上書き';
};

/** 端末に出す見立て。殻の確認と同じ項目を、件数、種類、実行されるものの順に並べる。 */
export function formatPlan(p: ApplyPlan): string[] {
  const lines = ['他の PC から届いた設定を、このあと設定の入れ物（~/.claude）に書きます。', `  ${counts(p)}`];
  lines.push(`  種類: ${Object.entries(p.byKind).map(([k, n]) => `${KIND_LABEL[k as ConfigItemKind]} ${n}`).join('、')}`);
  if (p.instructions > 0) lines.push(`Claude が読んで実行する指示（スキル、コマンド、エージェント）を ${p.instructions} 件書きます。`);
  if (p.exec.length > 0) {
    lines.push('実行される内容を含む項目:');
    for (const i of p.exec) lines.push(`  ${i.label}（${i.marks.map((m) => MARK_LABEL[m]).join('、')}）`);
  }
  lines.push('項目:');
  for (const i of p.items.slice(0, MAX_LISTED)) lines.push(`  ${opWord(i)}  ${i.label}`);
  if (p.items.length > MAX_LISTED) lines.push(`  ほか ${p.items.length - MAX_LISTED} 件`);
  lines.push('書く前に、元の中身を控えの世代に取ります。hangar config restore で戻せます。');
  return lines;
}

function openDbFor(home: string): Db {
  return openDb(dbPath(home));
}

/**
 * 適用の指示書を読み、承諾を得て、控えを取って書く。戻り値は終了コード（0 が成功）。
 * --plan は見立てを出すだけ。--json は機械向けで、聞けないので --yes か --plan と一緒に使う。
 */
export async function runConfigApply(o: ConfigApplyOpts = {}): Promise<number> {
  const log = o.log ?? ((s: string) => console.log(s));
  const home = o.home ?? hangarHome();
  let plan: ApplyPlan;
  try {
    plan = planApply({ home });
    if (o.order !== undefined && o.order !== plan.createdAt) throw new ApplyError('stale', '確認したあとに、適用の指示書が選び直されました。何も書いていません。もう一度、適用する項目を確かめてください。');
  } catch (e) { return fail(o, e, log); }
  if (o.plan) {
    if (o.json) log(JSON.stringify({ ok: true, plan })); else for (const l of formatPlan(plan)) log(l);
    return 0;
  }
  if (!o.yes) {
    const interactive = o.interactive ?? !!process.stdin.isTTY;
    if (o.json || !interactive) {
      log(o.json ? JSON.stringify({ ok: false, code: 'confirm-required', message: '確認を取れないので、何も書いていません。--yes を付けてください' }) : '標準入力が対話ではないので確認を取れません。端末から実行するか、--yes を付けてください');
      return 1;
    }
    for (const l of formatPlan(plan)) log(l);
    if (!(await (o.ask ?? promptYesNo)('書きますか？'))) {
      log('適用しませんでした。指示書はそのまま残しています');
      return 1;
    }
  }
  let db: Db | null = null;
  try {
    db = openDbFor(home);
    const r = runApply({ home, claudeDir: claudeDirOf(o, home), db, now: o.now });
    if (o.json) log(JSON.stringify({ ok: true, result: r }));
    else {
      log(`適用しました（書き込み ${r.written} 件、削除 ${r.removed} 件、手元を残す ${r.keptMine} 件）`);
      if (r.generation) log(`控えの世代: ${r.generation}。戻すには hangar config restore ${r.generation}`);
    }
    return 0;
  } catch (e) {
    return fail(o, e, log);
  } finally {
    db?.close();
  }
}

const atLabel = (at: number | null): string => (at === null ? '' : new Date(at).toLocaleString());

/**
 * 控えの世代へ戻す。名前を省くと一覧を出す。戻す前の状態も新しい世代に取るので、戻しも取り消せる。
 */
export async function runConfigRestore(o: ConfigRestoreOpts = {}): Promise<number> {
  const log = o.log ?? ((s: string) => console.log(s));
  const home = o.home ?? hangarHome();
  if (!o.name) {
    const gens = listBackups(home);
    if (o.json) log(JSON.stringify({ ok: true, generations: gens }));
    else if (gens.length === 0) log('控えの世代はありません。');
    else {
      log('控えの世代（新しい順）:');
      for (const g of gens) log(`  ${g.name}  ${g.files} ファイル  ${atLabel(g.at)}`);
      log('戻すには hangar config restore <世代>');
    }
    return 0;
  }
  const claudeDir = claudeDirOf(o, home);
  let plan: ReturnType<typeof planRestore>;
  try { plan = planRestore({ home, claudeDir, name: o.name }); } catch (e) { return fail(o, e, log); }
  const listPlan = (): void => {
    if (plan.restore.length > 0) { log('書き戻すファイル:'); for (const f of plan.restore.slice(0, MAX_LISTED)) log(`  ${f}`); }
    if (plan.remove.length > 0) { log('その時点で無かったので消すファイル:'); for (const f of plan.remove.slice(0, MAX_LISTED)) log(`  ${f}`); }
  };
  if (o.plan) {
    if (o.json) log(JSON.stringify({ ok: true, plan })); else { log(`世代 ${plan.name} の時点へ戻すと、次のようになります。`); listPlan(); }
    return 0;
  }
  if (!o.yes) {
    const interactive = o.interactive ?? !!process.stdin.isTTY;
    if (o.json || !interactive) {
      log(o.json ? JSON.stringify({ ok: false, code: 'confirm-required', message: '確認を取れないので、何も戻していません。--yes を付けてください' }) : '標準入力が対話ではないので確認を取れません。端末から実行するか、--yes を付けてください');
      return 1;
    }
    log(`世代 ${plan.name} の時点へ戻します。`);
    listPlan();
    log('その世代のあとで手元で変えた内容も、世代の時点へ戻ります。戻す前の状態は新しい世代に控えます。');
    if (!(await (o.ask ?? promptYesNo)('戻しますか？'))) {
      log('戻しませんでした');
      return 1;
    }
  }
  // 基準の表は、DB があるときだけ戻す。DB が無い PC でも、ファイルは戻せる。
  let db: Db | null = null;
  try {
    if (fs.existsSync(dbPath(home))) db = openDbFor(home);
    const r = runRestore({ home, claudeDir, name: o.name, db: db ?? undefined, now: o.now });
    if (o.json) log(JSON.stringify({ ok: true, result: r }));
    else {
      log(`戻しました（書き戻し ${r.restored.length} 件、消去 ${r.removed.length} 件）`);
      log(`戻す前の状態は世代 ${r.safety} に控えました。取り消すには hangar config restore ${r.safety}`);
    }
    return 0;
  } catch (e) {
    return fail(o, e, log);
  } finally {
    db?.close();
  }
}
