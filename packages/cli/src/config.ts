import fs from 'node:fs';
import type { ConfigExecMark, ConfigItemKind } from '@agent-hangar/shared';
import {
  ApplyError, dbPath, defaultClaudeDir, defaultTargetPaths, hangarHome, listAllBackups, loadSettings, openDb, planApply, planApplyFiles, planRestoreTarget, planRestoreTargetFiles, runApply, runRestoreTarget,
  type ApplyAllPlan, type ApplyPlan, type ApplyPlanItem, type Db,
} from '@agent-hangar/server/src/cliEntry.ts';
import { promptYesNo, type Ask } from './statusline.ts';

/**
 * hangar config apply と hangar config restore。
 * 設定の同期で他の PC から届いた項目を、項目の対象ごとの入れ物（`~/.claude`、`$CODEX_HOME`、opencode の設定、`~/.agents/skills`）へ書く、あるいは控えの世代へ戻す。サーバは書かない（全体計画の D9）。
 * 書く処理の本体は server の sync/config/apply.ts で、ここは確認の出し方と、結果の見せ方だけを持つ。
 * 殻の命令（apps/desktop）も、ネイティブの確認を出したあとで、この命令の --yes --json を走らせる。
 */

type Common = {
  /** hangar の置き場。試験は一時のディレクトリを渡す。 */
  home?: string;
  /** 書き込む `~/.claude`。省くと、設定の claudeDir。 */
  claudeDir?: string;
  /** ほかの対象の入れ物と利用者のホーム。省くと、この PC の既定の場所（試験は一時のディレクトリを渡す）。 */
  codexHome?: string;
  opencodeDir?: string;
  agentsSkillsDir?: string;
  userHome?: string;
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
  /** 承諾の窓で見せた書く先の指紋（見立ての fingerprint）。見せた後に手元が変わっていたら書かない。殻が使う。 */
  expect?: string;
};

export type ConfigRestoreOpts = Common & {
  /** 戻す世代の名前。省くと一覧を出す。 */
  name?: string;
  /** 世代の対象（claude、codex、opencode、agents-skills）。省くと claude。 */
  target?: string;
  /** 戻す先と消す先を出すだけで、何も戻さない。 */
  plan?: boolean;
  /** 承諾の窓で見せた書く先の指紋。見せた後に手元が変わっていたら戻さない。殻が使う。 */
  expect?: string;
};

const KIND_LABEL: Record<ConfigItemKind, string> = {
  'claude-md': 'CLAUDE.md', settings: 'settings.json のキー', keybindings: 'keybindings.json', skills: 'スキル', commands: 'コマンド', agents: 'エージェント', memory: 'メモリ',
  'claude-mcp': 'Claude の MCP サーバー',
  'claude-hooks': 'Claude のフック',
  'claude-statusline': 'Claude のステータス行',
  'plugins': 'プラグイン',
  'codex-file': 'Codex のファイル',
  'codex-config': 'Codex の設定',
  'codex-mcp': 'Codex の MCP サーバー',
  'opencode-file': 'opencode のファイル',
  'opencode-config': 'opencode の設定',
  'opencode-cli': 'opencode の CLI 設定',
  'opencode-mcp': 'opencode の MCP サーバー',
  'agents-skills': '共通のスキル',
  'hangar-pref': 'Hangar の好み',
};
const MARK_LABEL: Record<ConfigExecMark, string> = { hooks: 'フック', shell: 'シェルのコマンド実行', script: 'スクリプト' };
const MAX_LISTED = 40;

const claudeDirOf = (o: Common, home: string): string => o.claudeDir ?? (loadSettings(home).claudeDir || defaultClaudeDir());

/** 書く先の入れ物を全部そろえる（殻と CLI はいつも渡す。省いた場所を対象が勝手に決めないため）。 */
function pathsOf(o: Common, home: string) {
  const d = defaultTargetPaths(process.env, o.userHome);
  return {
    home, claudeDir: claudeDirOf(o, home), userHome: o.userHome,
    codexHome: o.codexHome ?? d.codexHome, opencodeDir: o.opencodeDir ?? d.opencodeDir, agentsSkillsDir: o.agentsSkillsDir ?? d.agentsSkillsDir, claudeJsonPath: d.claudeJsonPath,
  };
}

const TARGET_LABEL: Record<string, string> = { claude: 'Claude Code', 'claude-keys2': 'Claude Code', 'claude-hooks': 'Claude Code', 'claude-plugins': 'Claude Code', codex: 'Codex', opencode: 'opencode', 'agents-skills': '共通のスキル', hangar: 'Hangar' };
const targetsText = (names: string[]): string => [...new Set(names.map((n) => TARGET_LABEL[n] ?? n))].join('、');

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
  if (c.conflictRemote) parts.push(`競合で他の PC の内容を採用 ${c.conflictRemote} 件`);
  if (c.conflictMine) parts.push(`競合でこの PC の内容を残す ${c.conflictMine} 件`);
  return parts.join('、');
}

const opWord = (i: ApplyPlanItem): string => {
  if (i.act === 'keep') return 'この PC の内容を残す';
  if (i.act === 'remove') return '削除';
  return i.op === 'create' ? '新規' : '上書き';
};

/** 端末に出す見立て。殻の確認と同じ項目を、件数、種類、実行されるものの順に並べる。 */
export function formatPlan(p: ApplyPlan | ApplyAllPlan): string[] {
  const targets = 'targets' in p ? p.targets : ['claude'];
  const onlyClaude = targets.every((t) => TARGET_LABEL[t] === 'Claude Code');
  const lines = [onlyClaude ? '他の PC から受信した設定を ~/.claude に書き込みます。' : `他の PC から受信した設定を書き込みます（対象: ${targetsText(targets)}）。`, `  ${counts(p)}`];
  lines.push(`  種類: ${Object.entries(p.byKind).map(([k, n]) => `${KIND_LABEL[k as ConfigItemKind]} ${n}`).join('、')}`);
  if (p.instructions > 0) lines.push(`Claude が読んで実行する指示（スキル、コマンド、エージェント）を ${p.instructions} 件書き込みます。`);
  if (p.exec.length > 0) {
    lines.push('実行される内容を含む項目:');
    for (const i of p.exec) lines.push(`  ${i.label}（${i.marks.map((m) => MARK_LABEL[m]).join('、')}）`);
  }
  lines.push('項目:');
  for (const i of p.items.slice(0, MAX_LISTED)) lines.push(`  ${opWord(i)}  ${i.label}`);
  if (p.items.length > MAX_LISTED) lines.push(`  ほか ${p.items.length - MAX_LISTED} 件`);
  lines.push('書き込む前に、現在の内容をバックアップの世代に保存します。hangar config restore で元に戻せます。');
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
  const paths = pathsOf(o, home);
  let plan: ApplyPlan;
  try {
    plan = planApply(paths);
    if (o.order !== undefined && o.order !== plan.createdAt) throw new ApplyError('stale', '確認したあとに、適用内容が変わりました。何も書き込んでいません。適用する項目をもう一度確認してください。');
  } catch (e) { return fail(o, e, log); }
  if (o.plan) {
    // 機械向けには、書く先ごとの差分と指紋も添える（殻の承諾の窓が「何をどこに」と「差分」に出す）。
    if (o.json) {
      let files: ReturnType<typeof planApplyFiles>;
      try { files = planApplyFiles(paths); } catch (e) { return fail(o, e, log); }
      log(JSON.stringify({ ok: true, plan: { ...plan, files: files.files, fingerprint: files.fingerprint } }));
    } else for (const l of formatPlan(plan)) log(l);
    return 0;
  }
  if (!o.yes) {
    const interactive = o.interactive ?? !!process.stdin.isTTY;
    if (o.json || !interactive) {
      log(o.json ? JSON.stringify({ ok: false, code: 'confirm-required', message: '確認できないため、何も書き込んでいません。--yes を指定してください' }) : '標準入力が対話型ではないため、確認できません。ターミナルから実行するか、--yes を指定してください');
      return 1;
    }
    for (const l of formatPlan(plan)) log(l);
    if (!(await (o.ask ?? promptYesNo)('適用しますか？'))) {
      log('適用しませんでした。適用内容はそのまま保存されています');
      return 1;
    }
  }
  let db: Db | null = null;
  try {
    db = openDbFor(home);
    const r = runApply({ ...paths, db, now: o.now, expect: o.expect });
    if (o.json) log(JSON.stringify({ ok: true, result: r }));
    else {
      log(`適用しました（書き込み ${r.written} 件、削除 ${r.removed} 件、この PC の内容を残す ${r.keptMine} 件）`);
      for (const g of r.generations ?? []) {
        const cmd = g.target === 'claude' ? `hangar config restore ${g.name}` : `hangar config restore --target ${g.target} ${g.name}`;
        log(`バックアップの世代（${TARGET_LABEL[g.target] ?? g.target}）: ${g.name}。元に戻すには ${cmd} を実行してください`);
      }
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
    const gens = listAllBackups(home);
    if (o.json) log(JSON.stringify({ ok: true, generations: gens }));
    else if (gens.length === 0) log('バックアップの世代はありません。');
    else {
      log('バックアップの世代（新しい順）:');
      for (const g of gens) log(`  ${g.name}  ${TARGET_LABEL[g.target ?? 'claude'] ?? g.target}  ${g.files} ファイル  ${atLabel(g.at)}`);
      log('元に戻すには hangar config restore <世代> を実行してください（Claude Code 以外の世代は --target <対象> も付けます）');
    }
    return 0;
  }
  const ro = { ...pathsOf(o, home), name: o.name, target: o.target };
  let plan: ReturnType<typeof planRestoreTarget>;
  try { plan = planRestoreTarget(ro); } catch (e) { return fail(o, e, log); }
  const listPlan = (): void => {
    if (plan.restore.length > 0) { log('書き戻すファイル:'); for (const f of plan.restore.slice(0, MAX_LISTED)) log(`  ${f}`); }
    if (plan.remove.length > 0) { log('その時点で無かったため削除するファイル:'); for (const f of plan.remove.slice(0, MAX_LISTED)) log(`  ${f}`); }
  };
  if (o.plan) {
    if (o.json) {
      let files: ReturnType<typeof planRestoreTargetFiles>;
      try { files = planRestoreTargetFiles(ro); } catch (e) { return fail(o, e, log); }
      log(JSON.stringify({ ok: true, plan: { ...plan, files: files.files, fingerprint: files.fingerprint } }));
    } else { log(`世代 ${plan.name} の時点に戻すと、次のようになります。`); listPlan(); }
    return 0;
  }
  if (!o.yes) {
    const interactive = o.interactive ?? !!process.stdin.isTTY;
    if (o.json || !interactive) {
      log(o.json ? JSON.stringify({ ok: false, code: 'confirm-required', message: '確認できないため、何も戻していません。--yes を指定してください' }) : '標準入力が対話型ではないため、確認できません。ターミナルから実行するか、--yes を指定してください');
      return 1;
    }
    log(`世代 ${plan.name} の時点に戻します。`);
    listPlan();
    log('その世代のあとにこの PC で変更した内容も、世代の時点に戻ります。戻す前の状態は、新しい世代としてバックアップに保存します。');
    if (!(await (o.ask ?? promptYesNo)('戻しますか？'))) {
      log('戻しませんでした');
      return 1;
    }
  }
  // 基準の表は、DB があるときだけ戻す。DB が無い PC でも、ファイルは戻せる。
  let db: Db | null = null;
  try {
    if (fs.existsSync(dbPath(home))) db = openDbFor(home);
    const r = runRestoreTarget({ ...ro, db: db ?? undefined, now: o.now, expect: o.expect });
    if (o.json) log(JSON.stringify({ ok: true, result: r }));
    else {
      log(`戻しました（書き戻し ${r.restored.length} 件、削除 ${r.removed.length} 件）`);
      const again = o.target && o.target !== 'claude' ? `hangar config restore --target ${o.target} ${r.safety}` : `hangar config restore ${r.safety}`;
      log(`戻す前の状態は世代 ${r.safety} にバックアップしました。取り消すには ${again} を実行してください`);
    }
    return 0;
  } catch (e) {
    return fail(o, e, log);
  } finally {
    db?.close();
  }
}
