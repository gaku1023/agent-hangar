// 承認の窓（承認のダイアログ）。殻が自分の窓（approve）で開く、殻に同梱した頁である。サーバを通らない。
// 殻は CLI の見立て（--dry-run --json、設定の同期は --plan --json）をそのまま渡し（approve_view）、頁はここで文を作って出す。
// 利用者が「書き込み」を押したときだけ、頁は殻に write を答え（approve_answer）、殻が CLI を --yes で走らせる。
// この頁は UI の辞書（packages/shared/src/i18n）を持たないので、承認の窓の文（approve.*）を写した小さい日英の表をここに持つ。
// 表は辞書と同じでなければならない（apps/desktop/test/approve.test.ts が突き合わせる）。

/** 承認の窓の文。packages/shared/src/i18n/{ja,en}/approve.ts の写しである。 */
export const WORDS = {
  ja: {
    'approve.title.mcpInstall': 'MCP サーバーを登録',
    'approve.title.mcpUninstall': 'MCP サーバーの登録を解除',
    'approve.title.shellInstall': 'シェル連携をインストール',
    'approve.title.shellUninstall': 'シェル連携をアンインストール',
    'approve.title.statuslineInstall': 'ステータスラインを設定',
    'approve.title.statuslineUninstall': 'ステータスラインの設定を解除',
    'approve.title.apply': '同期された設定を適用',
    'approve.title.restore': 'バックアップから復元（{when}）',
    'approve.title.restoreOf': '{target} のバックアップから復元（{when}）',
    'approve.tab.what': '変更内容',
    'approve.tab.diff': '差分',
    'approve.tab.command': '同等のコマンド',
    'approve.op.create': '新規',
    'approve.op.modify': '変更',
    'approve.op.remove': '削除',
    'approve.op.own': 'hangar の管理ファイル',
    'approve.what.mcpAdd': 'mcpServers に「hangar」を 1 件追加します。他のキーは変更しません。',
    'approve.what.mcpReplace': 'mcpServers の「hangar」を最新の値に置き換えます。他のキーは変更しません。',
    'approve.what.mcpRemove': 'mcpServers から「hangar」を削除します。他のキーは変更しません。',
    'approve.what.shellAdd': '末尾に 1 行追加します（# agent-hangar のコメント付き）。',
    'approve.what.shellReplace': '# agent-hangar のコメントが付いた古い行を、最新の形式の 1 行に置き換えます。',
    'approve.what.shellRemove': '# agent-hangar のコメントが付いた行だけを削除します。',
    'approve.what.shellScript': 'hangar の管理ファイルです。起動のたびに再生成します。',
    'approve.what.statuslineAdd': '先頭（shebang の直後）に {n} 行追加します。表示は変わりません。',
    'approve.what.statuslineReplace': '古い形式の hangar の行を、最新の形式の {n} 行に置き換えます。',
    'approve.what.statuslineRemove': 'hangar が追加した {n} 行を削除します。',
    'approve.what.statuslineHeader': 'hangar の管理ファイルです。API トークンをここから読み込みます。',
    'approve.what.configCreate': '同期された内容で新規作成します。',
    'approve.what.configModify': '同期された内容で上書きします。',
    'approve.what.configRemove': '他の PC で削除されたため、この PC でも削除します。',
    'approve.what.restoreCreate': 'バックアップから作成します。',
    'approve.what.restoreModify': 'バックアップの内容に戻します。',
    'approve.what.restoreRemove': 'バックアップの時点で無かったため、削除します。',
    'approve.what.binary': 'バイナリファイルのため、差分は表示しません。',
    'approve.diff.head': '（先頭）',
    'approve.diff.tail': '（末尾）',
    'approve.diff.more': 'ほか {n} 行',
    'approve.diff.none': '内容に変更はありません。',
    'approve.kv.targets': '対象',
    'approve.kv.backup': 'バックアップ',
    'approve.target.claude': 'Claude Code',
    'approve.target.codex': 'Codex',
    'approve.target.opencode': 'opencode',
    'approve.target.agentsSkills': '共通のスキル',
    'approve.target.claudeMcp': 'Claude の MCP',
    'approve.target.codexMcp': 'Codex の MCP',
    'approve.target.opencodeMcp': 'opencode の MCP',
    'approve.target.hangar': 'Hangar',
    'approve.kv.after': '変更後',
    'approve.kv.note': '補足',
    'approve.backup.none': '元のファイルが無いため、バックアップは作成しません。',
    'approve.backup.generation': '{path}（新しい世代）',
    'approve.backup.stamped': '{path}（{stamp} は書き込み日時）',
    'approve.after.mcpInstall': '新しく起動した Claude Code のセッションから使えます。',
    'approve.after.mcpUninstall': '実行中のセッションでは、再起動するまで引き続き使えます。',
    'approve.after.shellInstall': '新しく開いたターミナルから有効です。開いているターミナルでは exec zsh で再読み込みできます。ラッパーを通さずに 1 回だけ起動するには command claude を実行します。',
    'approve.after.shellUninstall': '新しく開いたターミナルから有効です。',
    'approve.after.statuslineInstall': '次に Claude Code を起動すると、使用率がヘッダーに表示されます。',
    'approve.after.statuslineUninstall': 'ヘッダーの使用率のゲージは更新されなくなります。',
    'approve.after.apply': '実行中のセッションには、次回の読み込みから反映されます。',
    'approve.after.restore': '復元前の内容も、新しい世代としてバックアップに保存します。',
    'approve.note.secret': 'マスクした値は hangar の API トークンです（この PC でのみ使います）。',
    'approve.note.check': '書き込む直前に、表示後にファイルが変更されていないかを確認します。変更されていた場合は書き込みません。',
    'approve.note.instructions': 'Claude が読み込んで実行する指示（スキル、コマンド、エージェント）を {n} 件書き込みます。',
    'approve.note.exec': 'フックやコマンドの実行を含むもの：{names}',
    'approve.command.lead': 'ターミナルで次のコマンドを実行するのと同じ操作です。',
    'approve.button.cancel': 'キャンセル',
    'approve.button.write': '書き込み',
    'approve.button.unregister': '登録を解除',
    'approve.button.uninstall': 'アンインストール',
    'approve.button.removeSetup': '設定を解除',
    'approve.button.apply': '適用',
    'approve.button.restore': '復元',
    'approve.button.close': '閉じる',
    'approve.button.reload': '再読み込み',
    'approve.button.writing': '書き込み中…',
    'approve.stage.writing': 'バックアップを作成して書き込み中…',
    'approve.done.write': '書き込みました。',
    'approve.done.unregister': '登録を解除しました。',
    'approve.done.uninstall': 'アンインストールしました。',
    'approve.done.removeSetup': '設定を解除しました。',
    'approve.done.apply': '適用しました。',
    'approve.done.restore': '復元しました。',
    'approve.fail.title': '書き込めませんでした。ファイルは変更していません。',
    'approve.fail.changed': '表示後に、書き込み先のファイルが別のプログラムで変更されました。再読み込みして、差分を確認してください。',
    'approve.fail.reason': '理由',
    'approve.stage.loading': '読み込み中…',
  },
  en: {
    'approve.title.mcpInstall': 'Register the MCP server',
    'approve.title.mcpUninstall': 'Unregister the MCP server',
    'approve.title.shellInstall': 'Install shell integration',
    'approve.title.shellUninstall': 'Uninstall shell integration',
    'approve.title.statuslineInstall': 'Set up the status line',
    'approve.title.statuslineUninstall': 'Remove status line setup',
    'approve.title.apply': 'Apply settings from other computers',
    'approve.title.restore': 'Restore backup ({when})',
    'approve.title.restoreOf': 'Restore {target} backup ({when})',
    'approve.tab.what': 'What and where',
    'approve.tab.diff': 'Diff',
    'approve.tab.command': 'Same command',
    'approve.op.create': 'New',
    'approve.op.modify': 'Change',
    'approve.op.remove': 'Delete',
    'approve.op.own': "Hangar's own file",
    'approve.what.mcpAdd': 'Adds "hangar" to mcpServers. Other keys stay as they are.',
    'approve.what.mcpReplace': 'Replaces "hangar" in mcpServers with the current value. Other keys stay as they are.',
    'approve.what.mcpRemove': 'Deletes "hangar" from mcpServers. Other keys stay as they are.',
    'approve.what.shellAdd': 'Adds one line at the end (marked # agent-hangar).',
    'approve.what.shellReplace': 'Replaces the old line marked # agent-hangar with the current one.',
    'approve.what.shellRemove': 'Deletes only the lines marked # agent-hangar.',
    'approve.what.shellScript': "Hangar's own file. Rewritten at every launch.",
    'approve.what.statuslineAdd': 'Adds {n} lines at the top (after the shebang). The display does not change.',
    'approve.what.statuslineReplace': "Replaces Hangar's old lines with the current {n} lines.",
    'approve.what.statuslineRemove': 'Deletes the {n} lines Hangar added.',
    'approve.what.statuslineHeader': "Hangar's own file. The API token is read from here.",
    'approve.what.configCreate': 'Creates it with the contents that arrived.',
    'approve.what.configModify': 'Overwrites it with the contents that arrived.',
    'approve.what.configRemove': 'Deletes it because it was deleted on another computer.',
    'approve.what.restoreCreate': 'Creates it because it was in the backup.',
    'approve.what.restoreModify': 'Restores the contents in the backup.',
    'approve.what.restoreRemove': 'Deletes it because it did not exist at the time of the backup.',
    'approve.what.binary': 'Not text, so no diff is shown.',
    'approve.diff.head': ' (top)',
    'approve.diff.tail': ' (end)',
    'approve.diff.more': '{n} more lines',
    'approve.diff.none': 'The contents do not change.',
    'approve.kv.targets': 'Targets',
    'approve.kv.backup': 'Backup',
    'approve.target.claude': 'Claude Code',
    'approve.target.codex': 'Codex',
    'approve.target.opencode': 'opencode',
    'approve.target.agentsSkills': 'Shared skills',
    'approve.target.claudeMcp': 'Claude MCP',
    'approve.target.codexMcp': 'Codex MCP',
    'approve.target.opencodeMcp': 'opencode MCP',
    'approve.target.hangar': 'Hangar',
    'approve.kv.after': 'After writing',
    'approve.kv.note': 'Note',
    'approve.backup.none': 'There is no file yet, so there is nothing to back up.',
    'approve.backup.generation': '{path} (a new generation)',
    'approve.backup.stamped': '{path} ({stamp} is the date and time of writing)',
    'approve.after.mcpInstall': 'Available in Claude Code sessions started from now on.',
    'approve.after.mcpUninstall': 'Running sessions keep it until they restart.',
    'approve.after.shellInstall': 'Takes effect in newly opened terminals. In an open terminal, run exec zsh to reload. To start once without wrapping, run command claude.',
    'approve.after.shellUninstall': 'Takes effect in newly opened terminals.',
    'approve.after.statuslineInstall': 'The next time Claude Code starts, usage appears in the header.',
    'approve.after.statuslineUninstall': 'The usage gauge in the header stops updating.',
    'approve.after.apply': 'Running sessions pick it up the next time they load settings.',
    'approve.after.restore': 'The current contents are also kept as a new backup generation.',
    'approve.note.secret': "The blacked-out value is Hangar's API token (used only on this computer).",
    'approve.note.check': 'Right before writing, Hangar checks that the files have not changed since they were shown. If they have, nothing is written.',
    'approve.note.instructions': 'Instructions that Claude reads and runs (skills, commands and agents) to write: {n}.',
    'approve.note.exec': 'With hooks or commands that run: {names}',
    'approve.command.lead': 'This does the same as running the following in a terminal.',
    'approve.button.cancel': 'Cancel',
    'approve.button.write': 'Write',
    'approve.button.unregister': 'Unregister',
    'approve.button.uninstall': 'Uninstall',
    'approve.button.removeSetup': 'Remove setup',
    'approve.button.apply': 'Apply',
    'approve.button.restore': 'Restore',
    'approve.button.close': 'Close',
    'approve.button.reload': 'Reload',
    'approve.button.writing': 'Writing…',
    'approve.stage.writing': 'Backing up, then writing…',
    'approve.done.write': 'Written.',
    'approve.done.unregister': 'Unregistered.',
    'approve.done.uninstall': 'Uninstalled.',
    'approve.done.removeSetup': 'Setup removed.',
    'approve.done.apply': 'Applied.',
    'approve.done.restore': 'Restored.',
    'approve.fail.title': 'Could not write. Nothing was changed.',
    'approve.fail.changed': 'Another program changed a file after it was shown. Reload and check the diff.',
    'approve.fail.reason': 'Reason',
    'approve.stage.loading': 'Loading…',
  },
};

/** 伏せた値の印。CLI の setupPlan.ts の SECRET_MASK と同じ（NUL の 1 字）。 */
export const SECRET_MASK = '\u0000';

/** バックアップの名前の日時の置き場。CLI の setupPlan.ts の BACKUP_STAMP と同じ。 */
export const BACKUP_STAMP = 'YYYYMMDDhhmmss';

/** 対象ごとの、題と主の釦と完了の文と書いた後の文の鍵の頭。危ない（消す）操作は赤い釦にする。 */
const TARGETS = {
  'mcp-install': { key: 'mcpInstall', button: 'write', done: 'write', danger: false },
  'mcp-uninstall': { key: 'mcpUninstall', button: 'unregister', done: 'unregister', danger: true },
  'shell-install': { key: 'shellInstall', button: 'write', done: 'write', danger: false },
  'shell-uninstall': { key: 'shellUninstall', button: 'uninstall', done: 'uninstall', danger: true },
  'statusline-install': { key: 'statuslineInstall', button: 'write', done: 'write', danger: false },
  'statusline-uninstall': { key: 'statuslineUninstall', button: 'removeSetup', done: 'removeSetup', danger: true },
  apply: { key: 'apply', button: 'apply', done: 'apply', danger: false },
  restore: { key: 'restore', button: 'restore', done: 'restore', danger: false },
};

const words = (lang) => WORDS[lang === 'en' ? 'en' : 'ja'];
const fill = (s, p = {}) => s.replace(/\{(\w+)\}/g, (_, k) => (k in p ? String(p[k]) : `{${k}}`));

/** ホームの下のパスを ~ から書く。区切りは元のまま残す。 */
export function shortPath(p, home) {
  if (typeof p !== 'string') return '';
  if (!home) return p;
  const h = home.replace(/[\\/]+$/, '');
  if (p === h) return '~';
  return p.startsWith(`${h}/`) || p.startsWith(`${h}\\`) ? `~${p.slice(h.length)}` : p;
}

/** 対象の名前を、store の名前（hangar config restore --target の名前）にそろえる。claude-hooks などの Claude Code の対象は claude にまとめる。 */
const storeOf = (name) => (typeof name === 'string' && name.startsWith('claude') && name !== 'claude-mcp' ? 'claude' : name);
/** 対象の名前の文の鍵。知らない名前は None で、名前をそのまま出す。 */
const TARGET_WORD = { claude: 'claude', codex: 'codex', opencode: 'opencode', 'agents-skills': 'agentsSkills', 'claude-mcp': 'claudeMcp', 'codex-mcp': 'codexMcp', 'opencode-mcp': 'opencodeMcp', hangar: 'hangar' };
/** 控えの世代の置き場の名前（<hangar の置き場>/backups/<これ>/）。サーバの targets/stores.ts の backups と同じ。hangar は置き場を持たない。 */
export const BACKUP_DIRS = { claude: 'claude-config', codex: 'codex-config', opencode: 'opencode-config', 'agents-skills': 'agents-skills-config', 'claude-mcp': 'claude-mcp-config', 'codex-mcp': 'codex-mcp-config', 'opencode-mcp': 'opencode-mcp-config' };

/** 世代の名前（yyyyMMdd-HHmmss）を読める形にする。形が違えばそのまま返す。 */
export function generationLabel(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : (name ?? '');
}

/** 見立ての what（`mcp.add` など）を、文の鍵（approve.what.mcpAdd）にする。 */
const whatKey = (what) => {
  const [a, b] = String(what).split('.');
  return `approve.what.${a}${b ? b[0].toUpperCase() + b.slice(1) : ''}`;
};

/** 設定の同期の見立ての 1 ファイルを、連携の見立てと同じ形にする。 */
function configFile(job, f) {
  const op = f.op === 'create' ? 'Create' : f.op === 'remove' ? 'Remove' : 'Modify';
  return {
    path: f.path, op: f.op, what: `${job === 'apply' ? 'config' : 'restore'}.${op}`, n: undefined, where: null, binary: !!f.binary, target: f.target,
    lines: (f.lines ?? []).map((l) => ({ k: l.kind, t: l.text })),
  };
}

/** 頁に出すものを、殻の材料（approve.rs の Session::view）から作る。DOM に触らない（試験が読む）。 */
export function model(view, tab = 'what') {
  const w = words(view.lang);
  const t = (k, p) => fill(w[k] ?? k, p);
  const target = TARGETS[view.target] ?? TARGETS['mcp-install'];
  const plan = view.plan ?? {};
  const files = view.job === 'setup' ? (plan.files ?? []) : (plan.files ?? []).map((f) => configFile(view.job, f));
  const sep = view.windows ? '\\' : '/';
  const label = (name) => (name in TARGET_WORD ? t(`approve.target.${TARGET_WORD[name]}`) : String(name));
  const config = view.job === 'apply' || view.job === 'restore';
  // 戻す先の対象。対象を持たない見立て（古い殻）は Claude の世代として読む。
  const restoreTarget = view.job === 'restore' ? storeOf(view.configTarget ?? 'claude') : null;
  // 書く対象（重複と別名をまとめた並び）。見立ての targets を先に、無ければ書く先のファイルから拾う。
  const targets = [];
  if (view.job === 'apply') {
    for (const n of [...(plan.targets ?? []), ...(plan.files ?? []).map((f) => f.target)]) {
      const s = storeOf(n);
      if (s && !targets.includes(s)) targets.push(s);
    }
  }
  if (restoreTarget) targets.push(restoreTarget);
  // 対象の名前は、Claude Code だけのときは出さない（書く先のパスで足りる）。ほかの対象が一つでも入るときに出す。
  const showTargets = config && targets.some((n) => n !== 'claude');
  const title = restoreTarget && view.configTarget
    ? t('approve.title.restoreOf', { target: label(restoreTarget), when: generationLabel(view.name) })
    : t(`approve.title.${target.key}`, { when: generationLabel(view.name) });
  const command = view.job === 'setup' ? `hangar ${view.target.replace('-', ' ')}`
    : view.job === 'apply' ? 'hangar config apply'
      : `hangar config restore ${restoreTarget && restoreTarget !== 'claude' ? `--target ${restoreTarget} ` : ''}${view.name ?? ''}`;
  const backupRoot = `${shortPath(view.hangarHome, view.home)}${sep}backups${sep}`;
  /** 対象の世代の置き場。置き場を持たない対象（hangar）は None。 */
  const generationsOf = (name) => (BACKUP_DIRS[storeOf(name)] ? `${backupRoot}${BACKUP_DIRS[storeOf(name)]}${sep}` : null);
  let backup;
  // 連携の書き込みのバックアップの名前は、末尾の日時が書いたときに決まる。CLI の見立ては日時の形（BACKUP_STAMP）のまま渡すので、何の日時かを添える。
  if (view.job === 'setup') {
    const shown = plan.backup ? shortPath(plan.backup, view.home) : null;
    backup = shown === null ? t('approve.backup.none') : shown.endsWith(BACKUP_STAMP) ? t('approve.backup.stamped', { path: shown, stamp: BACKUP_STAMP }) : shown;
  }
  else {
    const dirs = (restoreTarget ? [restoreTarget] : targets).map(generationsOf).filter((d) => d !== null);
    backup = (dirs.length > 0 ? dirs : [generationsOf('claude')]).map((d) => t('approve.backup.generation', { path: d })).join('\n');
  }
  const notes = [];
  if (plan.secret) notes.push(t('approve.note.secret'));
  if (view.job === 'apply' && plan.instructions > 0) notes.push(t('approve.note.instructions', { n: plan.instructions }));
  if (view.job === 'apply' && Array.isArray(plan.exec) && plan.exec.length > 0) notes.push(t('approve.note.exec', { names: plan.exec.map((e) => e.label).join(view.lang === 'en' ? ', ' : '、') }));
  notes.push(t('approve.note.check'));
  const warn = view.job === 'apply' && (plan.instructions > 0 || (Array.isArray(plan.exec) && plan.exec.length > 0));
  const shown = files.map((f) => ({
    path: shortPath(f.path, view.home),
    op: f.op,
    opLabel: t(`approve.op.${f.op}`),
    what: f.binary ? t('approve.what.binary') : t(whatKey(f.what), { n: f.n ?? '' }),
    header: `${shortPath(f.path, view.home)}${f.where === 'head' ? t('approve.diff.head') : f.where === 'tail' ? t('approve.diff.tail') : ''}`,
    lines: f.lines ?? [],
    own: f.op === 'own',
    binary: !!f.binary,
    targetLabel: config && f.target ? label(storeOf(f.target)) : null,
  }));
  const result = view.result ?? null;
  let doneBackups = [];
  if (result && view.job === 'setup') doneBackups = (result.backups ?? []).map((b) => shortPath(b, view.home));
  if (result && view.job === 'apply') {
    // 対象ごとの世代。古い CLI は generation（Claude の世代）だけを返す。
    const gens = Array.isArray(result.generations) && result.generations.length > 0 ? result.generations : result.generation ? [{ target: 'claude', name: result.generation }] : [];
    doneBackups = gens.flatMap((g) => (generationsOf(g.target) ? [`${generationsOf(g.target)}${g.name}`] : []));
  }
  if (result && view.job === 'restore' && result.safety) doneBackups = [`${generationsOf(restoreTarget)}${result.safety}`];
  return {
    lang: view.lang === 'en' ? 'en' : 'ja',
    title, stage: view.stage, tab, warn,
    tabs: ['what', 'diff', 'command'].map((id) => ({ id, label: t(`approve.tab.${id}`), selected: id === tab })),
    files: shown,
    command, commandLead: t('approve.command.lead'),
    showTargets,
    kv: [...(showTargets ? [[t('approve.kv.targets'), targets.map(label).join('\n')]] : []), [t('approve.kv.backup'), backup], [t('approve.kv.after'), t(`approve.after.${target.key}`)], [t('approve.kv.note'), notes.join('\n')]],
    primary: { label: view.stage === 'writing' ? t('approve.button.writing') : t(`approve.button.${target.button}`), danger: target.danger },
    cancel: t('approve.button.cancel'), close: t('approve.button.close'), reload: t('approve.button.reload'),
    writing: t('approve.stage.writing'),
    done: { title: t(`approve.done.${target.done}`), after: t(`approve.after.${target.key}`), backups: doneBackups, backupLabel: t('approve.kv.backup'), note: result?.note ?? null },
    fail: view.failure
      ? { title: t('approve.fail.title'), detail: view.failure.code === 'changed' ? t('approve.fail.changed') : view.failure.message, reasonLabel: t('approve.fail.reason'), reload: true }
      : null,
    diffMore: (n) => t('approve.diff.more', { n }),
    diffNone: t('approve.diff.none'),
    loading: t('approve.stage.loading'),
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** 差分の行の文。伏せた値は黒い帯にする（中身は頁にも渡っていない）。 */
const lineHtml = (t) => String(t).split(SECRET_MASK).map(esc).join('<span class="mask" aria-label="•••"></span>');

const OP_MARK = { create: '+', modify: '±', remove: '−', own: '·' };

/** 差分の表。ファイルごとに、パスの見出しと +/- の行を並べる。 */
export function diffHtml(m) {
  return m.files.filter((f) => !f.own).map((f) => {
    const rows = f.binary ? `<div class="c">${esc(f.what)}</div>`
      : f.lines.length === 0 ? `<div class="c">${esc(m.diffNone)}</div>`
        : f.lines.map((l) => (l.k === 'gap' ? `<div class="c">… ${esc(m.diffMore(l.t))}</div>` : `<div class="${l.k === 'add' ? 'a' : l.k === 'del' ? 'd' : 'c'}">${l.k === 'add' ? '+ ' : l.k === 'del' ? '- ' : '  '}${lineHtml(l.t)}</div>`)).join('');
    return `<div class="diff"><div class="p">${esc(f.header)}</div>${rows}</div>`;
  }).join('');
}

/** 頁の中身の HTML。段（確認、書き込み中、完了、失敗）ごとに出し分ける。 */
export function render(m) {
  const kv = (rows) => `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v).replace(/\n/g, '<br>')}</dd>`).join('')}</dl>`;
  let body;
  let foot;
  if (m.stage === 'done') {
    body = `<div class="strip ok"><span class="ic">✓</span><div><b>${esc(m.done.title)}</b> ${esc(m.done.after)}</div></div>`
      + (m.done.backups.length ? kv([[m.done.backupLabel, m.done.backups.join('\n')]]) : '')
      + (m.done.note ? `<p class="muted pre">${esc(m.done.note)}</p>` : '');
    foot = `<span class="spacer"></span><button class="btn btn-primary" data-act="close" autofocus>${esc(m.close)}</button>`;
  } else if (m.stage === 'fail' && m.fail) {
    body = `<div class="strip danger"><span class="ic">!</span><div><b>${esc(m.fail.title)}</b><br><span class="pre">${esc(m.fail.detail)}</span></div></div>`;
    foot = `<button class="btn" data-act="close">${esc(m.close)}</button><span class="spacer"></span><button class="btn btn-primary" data-act="reload">${esc(m.reload)}</button>`;
  } else {
    const writing = m.stage === 'writing';
    const tabs = `<div class="tabs" role="tablist">${m.tabs.map((x) => `<button role="tab" data-tab="${x.id}" aria-selected="${x.selected}">${esc(x.label)}</button>`).join('')}</div>`;
    let pane;
    if (m.tab === 'diff') pane = diffHtml(m);
    else if (m.tab === 'command') pane = `<p class="muted">${esc(m.commandLead)}</p><pre class="cmd">${esc(m.command)}</pre>`;
    else pane = `<div class="what">${m.files.map((f) => `<div class="w"><span class="k ${f.op}">${OP_MARK[f.op] ?? '·'}</span><div><div class="mono">${m.showTargets && f.targetLabel ? `<span class="tg">${esc(f.targetLabel)}</span> ` : ''}${esc(f.path)}</div><div class="s">${esc(f.what)}</div></div><span class="faint">${esc(f.opLabel)}</span></div>`).join('')}</div>`;
    body = `${tabs}<div class="pane">${pane}</div>${writing ? `<p class="muted"><span class="spin"></span> ${esc(m.writing)}</p>` : ''}${kv(m.kv)}`;
    foot = `<button class="btn" data-act="cancel" ${writing ? 'disabled' : ''}>${esc(m.cancel)}</button><span class="spacer"></span><button class="btn ${m.primary.danger ? 'btn-danger' : 'btn-primary'}" data-act="write" ${writing ? 'disabled' : ''}>${esc(m.primary.label)}</button>`;
  }
  return `<header class="${m.warn ? 'warn' : ''}"><h1>${esc(m.title)}</h1></header><main>${body}</main><footer>${foot}</footer>`;
}

// ---- ここから下は頁の中だけで動く（試験は上の関数だけを読む）。 ----

const internals = typeof window === 'undefined' ? null : window.__TAURI_INTERNALS__;
let view = null;
let tab = 'what';

function draw() {
  if (!view) return;
  const m = model(view, tab);
  document.documentElement.lang = m.lang;
  document.title = m.title;
  document.getElementById('root').innerHTML = render(m);
}

async function answer(choice) {
  if (!internals) return;
  if (choice === 'write' && view) { view = { ...view, stage: 'writing' }; draw(); }
  try {
    const next = await internals.invoke('approve_answer', { choice });
    if (next && typeof next === 'object') { view = next; if (view.stage === 'confirm') tab = tab || 'what'; draw(); }
  } catch {
    // 窓が閉じていくところ。何もしない。
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-act],[data-tab]') : null;
    if (!el || el.hasAttribute('disabled')) return;
    if (el.dataset.tab) { tab = el.dataset.tab; draw(); return; }
    void answer(el.dataset.act);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view && view.stage !== 'writing') void answer(view.stage === 'confirm' ? 'cancel' : 'close');
  });
  if (internals) {
    internals.invoke('approve_view').then((v) => { view = v; draw(); }).catch(() => {});
  }
}
