import { compatState, gitInstallCommand, PSMUX_UPGRADE_COMMAND, type SetupTarget, type SettingsAt, type UiAction, type NodeCheckDto, type ReadinessDto, type ToolCheckDto, type Translate } from '@agent-hangar/shared';
import type { MuxCheck, State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { readinessCompat } from './compat.ts';
import type { BandAction, BandGroup, BandRow } from './home.ts';
import { clientPlatform } from '../keys.ts';

/**
 * 欄の下の 1 行の検証（設定の B1）。
 * ok なら「✓ text（note）」、そうでなければ「✗ text」の後ろに直し方（fix か fixCommand）を並べる。
 * soft は無くても動くもので、赤ではなく弱い色で出す。
 */
export type VerifyLine = { ok: boolean; soft: boolean; text: string; note: string | null; fix: string | null; fixCommand: string | null };

export type ToolKey = 'tmux' | 'claude' | 'node' | 'git';

/** tmux の役を担う道具の入れ方。Windows は psmux を入れる。 */
export function muxInstallCommand(platform: string): string {
  return platform === 'win32' ? 'winget install marlocarlo.psmux' : 'brew install tmux';
}

// 画面を開いている PC の OS は、キーの表と同じ 1 つの判定（keys.ts）から読む。
export { clientPlatform };

/** tmux の役を担う道具の名前。Windows は psmux で、ほかは tmux である。 */
export function muxName(platform: string): string {
  return platform === 'win32' ? 'psmux' : 'tmux';
}

/**
 * psmux（tmux）の状態（段 6 の案内）。ホームの帯の行（B1）、始める前のダイアログ（B2）、設定のツールの行（B3）が読む。
 * windows は文を選ぶ印（PowerShell かターミナルか）、command は入れるコマンドである。
 * checking は再確認の答えを待っている間、stillMissing は再確認しても見つからなかったこと（見つかったら立てない）。
 */
export type MuxStatus = {
  name: string; windows: boolean; installed: boolean; version: string | null; path: string | null; command: string; checking: boolean; stillMissing: boolean;
  /** Windows の psmux が下限より古いときの、下限と上げる 1 行（issue #245）。古くなければ null。 */
  outdated: { min: string; command: string } | null;
};

/** 準備の確かめと再確認の進みから、psmux（tmux）の状態を作る。準備の確かめが届く前は null。 */
export function presentMux(r: ReadinessDto | null, check: MuxCheck, platform: string = clientPlatform()): MuxStatus | null {
  if (r === null) return null;
  const c = r.tools.tmux;
  return { name: muxName(platform), windows: platform === 'win32', installed: c.ok, version: c.ok ? c.version : null, path: c.ok ? c.path : null, command: muxInstallCommand(platform), checking: check === 'checking', stillMissing: !c.ok && check === 'missing', outdated: c.ok && c.outdated ? { min: c.outdated.min, command: PSMUX_UPGRADE_COMMAND } : null };
}

/** 始める前の案内のダイアログ（B2）。開いていなければ null。 */
export function presentMuxGuide(state: State, store: Store, platform: string = clientPlatform()): { mux: MuxStatus } | null {
  if (state.overlay.kind !== 'muxGuide') return null;
  const mux = presentMux(store.readiness, state.muxCheck, platform);
  return mux ? { mux } : null;
}

/**
 * 通知が OS で切られているときの案内の文の鍵。
 * 許可する場所は OS ごとに名前が違う（macOS はシステム設定、Windows は Windows の設定）ので、画面を開いている OS で選ぶ。
 * settings は設定の欄の文、toast は右下の知らせの文。
 */
export function notifyBlockedKey(platform: string, where: 'settings' | 'toast'): 'settings.general.notify.blocked' | 'settings.general.notify.blockedWindows' | 'runtime.notify.blocked' | 'runtime.notify.blockedWindows' {
  const win = platform === 'win32';
  if (where === 'settings') return win ? 'settings.general.notify.blockedWindows' : 'settings.general.notify.blocked';
  return win ? 'runtime.notify.blockedWindows' : 'runtime.notify.blocked';
}

/** ツールごとの直し方。コマンドで直せるものはコマンドを、そうでなければ文（辞書の鍵）を持つ。tmux の入れ方だけは OS で変わるので、toolLine で差し替える。 */
const FIX = {
  tmux: { fix: null, fixCommand: 'brew install tmux', soft: false },
  claude: { fix: 'readiness.fix.claude', fixCommand: null, soft: false },
  node: { fix: 'readiness.fix.node', fixCommand: null, soft: false },
  // git は無くても動く（git の表示が出ないだけ）。入れ方は OS で変わるので、toolLine で差し替える。
  git: { fix: 'readiness.fix.git', fixCommand: null, soft: true },
} as const satisfies Record<ToolKey, { fix: 'readiness.fix.claude' | 'readiness.fix.node' | 'readiness.fix.git' | null; fixCommand: string | null; soft: boolean }>;

/**
 * 動かせない理由の文。パスがあればパスを主語にする。
 * フルパスでない、Node でない、版が古いかアーキが違う、の 3 つは Node の設定だけのもの（殻が使える Node かを見た結果）。
 */
function problemText(t: Translate, c: ToolCheckDto & Partial<Pick<NodeCheckDto, 'found' | 'need'>>): string {
  if (c.path === null || c.problem === 'unset') return t('readiness.problem.unset');
  if (c.problem === 'notFile') return t('readiness.problem.notFile', { path: c.path });
  if (c.problem === 'notExecutable') return t('readiness.problem.notExecutable', { path: c.path });
  if (c.problem === 'notAbsolute') return t('readiness.problem.notAbsolute', { path: c.path });
  if (c.problem === 'notNode') return t('readiness.problem.notNode', { path: c.path });
  // 版が古い（Node-API が足りない）のか、アーキが違うのかを分けて言う。両方なら版を言う（サーバの nodeFit と同じ順）。
  if (c.problem === 'wrongNode' && c.found && c.need && c.found.napi < c.need.napi) return t('readiness.problem.nodeTooOld', { path: c.path, found: c.found.version, min: c.need.min, napi: c.need.napi });
  if (c.problem === 'wrongNode' && c.found && c.need) return t('readiness.problem.nodeWrongArch', { path: c.path, foundArch: c.found.arch, arch: c.need.arch });
  if (c.problem === 'wrongNode') return t('readiness.problem.notNode', { path: c.path });
  return t('readiness.problem.missing', { path: c.path });
}

export function toolLine(t: Translate, key: ToolKey, c: ToolCheckDto & Partial<NodeCheckDto>, platform: string = clientPlatform()): VerifyLine {
  const f = FIX[key];
  if (c.ok) {
    const auto = key === 'node' && c.auto ? t('readiness.tool.autoFound') : null;
    const note = [c.version, auto].filter((x): x is string => x !== null).join(t('common.list.separator'));
    return { ok: true, soft: false, text: c.path ?? '', note: note === '' ? null : note, fix: null, fixCommand: null };
  }
  return { ok: false, soft: f.soft, text: problemText(t, c), note: f.soft ? t('readiness.tool.optional') : null, fix: f.fix === null ? null : t(f.fix), fixCommand: key === 'tmux' ? muxInstallCommand(platform) : key === 'git' ? gitInstallCommand(platform) : f.fixCommand };
}

/**
 * 新しいフォルダの作成場所の検証。作成場所は任意なので（2026-10-13）、空なら行を出さない（null）。
 * 決めた場所が無ければ注意（soft）で直し方を言い、あればその直下から登録したプロジェクトの数を添える（0 件でも ✓）。
 */
export function workspaceLine(t: Translate, w: ReadinessDto['workspace']): VerifyLine | null {
  if (w.path === '') return null;
  // 決めた場所が無くても hangar は動く（作るときに場所を選ぶだけ）。赤の「要修正」ではなく注意にとどめる。
  // 古い設定のままの今の利用者で、~/workspace がその PC に無いときに起きる（0.6.0-rc.1 の Windows の確かめ）。
  if (!w.exists) return { ok: false, soft: true, text: t('readiness.workspace.missing'), note: null, fix: t('readiness.fix.workspace'), fixCommand: null };
  return { ok: true, soft: false, text: w.path, note: t('readiness.workspace.projects', { n: w.projectCount }), fix: null, fixCommand: null };
}

/**
 * 準備の確かめの「プロジェクト」の数を、画面が持っているプロジェクトの数で置き換える。
 * 準備の確かめは取り直すまで古いままなので、登録した直後やプロジェクトを外した直後でも、行が今の数で決まるようにする。
 * 数えるのは、この PC で場所の分かっている、クイックセッションでないものである（サーバの resolvedProjectCount と同じ）。
 * projects を持たない古いサーバの答えは、そのまま返す。
 */
export function liveReadiness(r: ReadinessDto, projects: readonly { isScratch: boolean; resolved: boolean }[]): ReadinessDto {
  if (!r.projects) return r;
  const resolved = projects.filter((p) => !p.isScratch && p.resolved).length;
  return resolved === r.projects.resolved ? r : { ...r, projects: { ...r.projects, resolved } };
}

/**
 * 始める前の確認の行の名前。git とエディタは 0.5.0 で足した任意の行で、古いサーバの答えには無い。
 * notify は OS の通知の許可をまだ尋ねていないときだけの任意の行で、サーバの答えではなく画面の Store（notify.ask）から足す（2026-10-13 の決定、9c）。
 */
export type ReadinessKey = 'tmux' | 'claude' | 'workspace' | 'projects' | 'git' | 'mcp' | 'statusline' | 'editor' | 'compat' | 'notify';
/**
 * 帯の行ごとの、直す場所（設定の開く先）。「設定を開く」はここを指して開く（節の中の欄まで移って目立たせる）。
 * 全部の行が節を持つ（試験が縛る）。MCP とステータスラインは命令をコピーする行なので、欄までは指さず連携の節にする。
 */
export const READINESS_AT: Record<ReadinessKey, SettingsAt> = {
  tmux: 'tmux', claude: 'claude', workspace: 'workspace', projects: 'workspace', git: 'environment', mcp: 'integrations', statusline: 'integrations', editor: 'editor', compat: 'compat', notify: 'general',
};
/** 任意の行。無くても始められるので、残りがこれだけになったら帯ごと消す（設計書 2.11.4）。通知の行だけは例外で、答えるまで群を残す（presentReadiness）。 */
const OPTIONAL: ReadonlySet<ReadinessKey> = new Set(['git', 'mcp', 'statusline', 'editor', 'notify']);
/** 行の調子。info は止めていない知らせ（未確認のバージョン）で、済んだものに数える。soft は弱い印で、任意の行と、プロジェクトが 0 件の行に使う。 */
type Tone = 'ok' | 'info' | 'soft' | 'ng';
/** 確認の 1 行の事実。文は、帯の行にするときに辞書から引く。 */
type Check = { key: ReadinessKey; ok: boolean; tone: Tone };

/** 確認の行を並べる。互換の行は、古いサーバの答え（compat が無い）では出さず、5 つで数える。 */
function checksOf(r: ReadinessDto): Check[] {
  const ws = r.workspace;
  const rows: Check[] = [
    // 古い psmux（issue #245）は始められるので注意にとどめ、任意にはしない。任意にすると、準備を済ませた既存の利用者には帯ごと出なくなる。
    r.tools.tmux.ok && r.tools.tmux.outdated ? { key: 'tmux', ok: false, tone: 'soft' } : { key: 'tmux', ok: r.tools.tmux.ok, tone: r.tools.tmux.ok ? 'ok' : 'ng' },
    { key: 'claude', ok: r.tools.claude.ok, tone: r.tools.claude.ok ? 'ok' : 'ng' },
    // プロジェクトの行（2026-10-13）。この PC に場所の分かっているプロジェクトが 1 件以上で済み、0 件は注意（任意の札は付けない）。
    // projects を持たない古いサーバの答えは、今までの「プロジェクトの親フォルダ」の行で見る。
    r.projects
      ? { key: 'projects', ok: r.projects.resolved > 0, tone: r.projects.resolved > 0 ? 'ok' : 'soft' }
      : { key: 'workspace', ok: ws.exists && ws.projectCount > 0, tone: ws.exists && ws.projectCount > 0 ? 'ok' : 'ng' },
    // git は無くても始められる（git の表示が出ないだけ）。古いサーバの答えには無い。
    ...(r.tools.git ? [{ key: 'git' as const, ok: r.tools.git.ok, tone: r.tools.git.ok ? 'ok' as const : 'soft' as const }] : []),
    { key: 'mcp', ok: r.mcp.registered, tone: r.mcp.registered ? 'ok' : 'soft' },
    { key: 'statusline', ok: r.statusline.installed, tone: r.statusline.installed ? 'ok' : 'soft' },
    // エディタは「アプリだけ」でも開けるので済んだものに数える。見つからないときだけ直すもの（任意）にする。
    ...(r.editor ? [{ key: 'editor' as const, ok: r.editor.state !== 'none', tone: r.editor.state !== 'none' ? 'ok' as const : 'soft' as const }] : []),
  ];
  const summary = readinessCompat(r);
  if (summary) {
    const state = compatState(summary);
    rows.push({ key: 'compat', ok: state !== 'drift', tone: state === 'drift' ? 'soft' : state === 'unverified' ? 'info' : 'ok' });
  }
  return rows;
}

/**
 * 帯に始める前の確認を出す条件。任意の行（MCP、statusline）以外に済んでいないものがあるときだけ真である。
 * 偽になると帯の群が消える。真から偽に変わったことが、トーストの合図になる（runtime.ts）。
 */
export function readinessPending(r: ReadinessDto): boolean {
  return checksOf(r).some((c) => !c.ok && !OPTIONAL.has(c.key));
}

/** 済んでいない行が 1 つも無いこと（トーストの文を選ぶ）。 */
export function readinessComplete(r: ReadinessDto): boolean {
  return checksOf(r).every((c) => c.ok);
}

/** 帯の群 1 つと、帯の右端の注記。注記は始めるのに要る道具が足りないときだけ持つ。 */
export type ReadinessBand = { group: BandGroup; note: string | null };

/** 名前を並べる。最後の 2 つは「と」でつなぎ、それより前は読点でつなぐ。 */
function joinNames(t: Translate, names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(t('home.ready.separator'))}${t('home.ready.and')}${names.at(-1)}`;
}

/** 動かせないツールの理由の文。パスがあればパスを主語にする。 */
function toolProblem(t: Translate, c: ToolCheckDto): string {
  if (c.path === null || c.problem === 'unset') return t('home.ready.problem.unset');
  if (c.problem === 'notFile') return t('home.ready.problem.notFile', { path: c.path });
  if (c.problem === 'notExecutable') return t('home.ready.problem.notExecutable', { path: c.path });
  return t('home.ready.problem.missing', { path: c.path });
}

const toolOk = (t: Translate, c: ToolCheckDto) => (c.version ? t('home.ready.tool.ok', { path: c.path ?? '', version: c.version }) : c.path ?? '');

/**
 * 始める前の確認の最後の「仕上げ」の行（セットアップのすゝめ、試作の案 C）。
 * Claude Code に貼る一言（設定の連携の札と同じもの）をコピーさせる。直すものではないので、件数にも分母にも数えない。
 * 群が出る・消える規則は変えない。この行のために群を出し続けることはせず、群が消えれば一緒に消える（設定の札は残る）。
 */
function guideRow(t: Translate, prompt: string): BandRow {
  const name = t('home.ready.guide.name');
  const label = t('home.ready.guide.copy');
  return {
    key: 'ready:guide', lead: { kind: 'guide' }, name, badge: null, context: null, text: t('home.ready.guide.text'), detail: null, tone: null, trail: [], open: null,
    actions: [{ id: 'copyGuide', label, ariaLabel: t('home.band.actionFor', { action: label, name }), primary: false, ghost: false, send: { type: 'clipboard.copy', text: prompt }, copyFeedback: true }],
  };
}

/**
 * 始める前の確認を、ホームの帯の群にする（設計書 2.11.4、試作の始める前の確認の B）。
 * 引き出しには直すものだけを 1 行ずつ出し（必須を先、任意を後ろ）、済んだものは 1 行に畳む（fold）。
 * 錠剤は「準備完了 3 / 6」（分母は任意の行も含めて数え、互換の未確認の版は済んだものに数える）で、件数は直すものの数である。
 * 残りの件数の要約は持たない（錠剤の数と並ぶと読み取りにくかった）。
 * 帯の右端の文は、始めるのに要る道具（tmux の役の道具と claude）のうち足りないものだけを名指しし、揃っていれば出さない。
 * 必須が済んで任意の行だけが残るか、全部そろったときは null で、帯の群を出さない。
 * 互換のずれは、直すものとして残る（任意の札は付けない）。
 * 右端のボタンは 1 つで、「設定を開く」か「コマンドをコピー」である。殻の中では、MCP とステータスラインの行を設定の連携の節と同じボタン（setup.run）にする。
 */
export function presentReadiness(r: ReadinessDto, t: Translate, platform: string = clientPlatform(), check: MuxCheck = 'idle', setup: { desktop: boolean; running: SetupTarget | null; notifyAsk?: boolean; guide?: string | null } = { desktop: false, running: null }): ReadinessBand | null {
  // OS の通知の許可をまだ尋ねていなければ、任意の行「通知」を足す。押したときだけ OS に尋ねる（notify.set の on）。
  // この行だけは、答える（許可するか要らないを押す）まで群を残す。ほかの任意の行と違い、放っておくと通知が届かないまま気付けないからである。
  if (!readinessPending(r) && !setup.notifyAsk) return null;
  const checks: Check[] = [...checksOf(r), ...(setup.notifyAsk ? [{ key: 'notify' as const, ok: false, tone: 'soft' as const }] : [])];
  // tmux の行は、Windows では psmux の名で出す（段 6）。
  const name = (k: ReadinessKey) => (k === 'tmux' ? muxName(platform) : t(`home.ready.name.${k}`));
  const action = (label: string, who: string, send: UiAction, primary: boolean): BandAction => ({ id: 'fix', label, ariaLabel: t('home.band.actionFor', { action: label, name: who }), primary, ghost: false, send });
  const toSettings = (k: ReadinessKey) => action(t('home.ready.openSettings'), name(k), { type: 'nav.go', to: { name: 'settings', at: READINESS_AT[k] } }, true);
  const copy = (k: ReadinessKey, command: string) => action(t('home.ready.copyCommand'), name(k), { type: 'clipboard.copy', text: command }, false);
  // 殻の中では、MCP とステータスラインの行も設定の連携の節と同じボタンにする（殻が承認の窓で見せてから書く）。
  const write = (k: ReadinessKey, target: SetupTarget, label: string) => action(setup.running === target ? t('settings.integrations.waiting') : label, name(k), { type: 'setup.run', target }, true);
  const sl = r.statusline;
  const ws = r.workspace;
  const summary = readinessCompat(r);

  /** 直すものの行。 */
  const fixRow = (c: Check): BandRow => {
    let text = '';
    let detail: string | null = null;
    let act: BandAction;
    let extra: BandAction[] = [];
    switch (c.key) {
      case 'tmux':
      case 'claude': {
        const tool = r.tools[c.key];
        // 古い psmux は、症状と下限を言い、上げ方は設定の節（注意とコピー）へ案内する。
        if (c.key === 'tmux' && tool.ok && tool.outdated) {
          // detail は等幅の欄（コマンド用）なので使わず、互換の行と同じく 1 つの文にする。
          text = t('home.ready.mux.outdated', { name: muxName(platform), version: tool.version ?? '', min: tool.outdated.min });
          act = toSettings('tmux');
          break;
        }
        text = toolProblem(t, tool);
        // 見つからないものだけ、入れる命令を添える（tmux）。claude と、パスはあるのに使えないものは設定で直す。
        const missing = tool.path === null || tool.problem === 'unset';
        const command = c.key === 'tmux' && missing ? muxInstallCommand(platform) : null;
        detail = command;
        act = command ? copy(c.key, command) : toSettings(c.key);
        if (c.key === 'tmux' && missing) text = t(check === 'missing' ? 'mux.status.stillMissing' : 'mux.status.notInstalled', { name: muxName(platform) });
        // 入れたあとにその場で探し直せるよう、再確認を添える（段 6 の B1）。置いたファイルが消えたときも、探し直せば直る。
        if (c.key === 'tmux' && (missing || tool.problem === 'missing')) {
          const label = t(check === 'checking' ? 'mux.action.checking' : 'mux.action.recheck');
          extra = [{ id: 'recheck', label, ariaLabel: t('home.band.actionFor', { action: label, name: name('tmux') }), primary: false, ghost: false, send: { type: 'mux.recheck' } }];
        }
        break;
      }
      case 'workspace':
        text = ws.path === '' ? t('home.ready.workspace.unset') : !ws.exists ? t('home.ready.workspace.missing', { path: ws.path }) : t('home.ready.workspace.empty', { path: ws.path });
        act = toSettings('workspace');
        break;
      case 'projects': {
        // 候補があれば候補のダイアログを開き、無ければ新しいプロジェクトの作成へ案内する。
        const n = r.projects?.candidates ?? 0;
        text = n > 0 ? t('home.ready.projects.found', { n }) : t('home.ready.projects.none');
        act = n > 0 ? action(t('home.ready.projects.choose'), name('projects'), { type: 'project.candidates.open' }, true) : action(t('home.ready.projects.create'), name('projects'), { type: 'project.new.open' }, true);
        break;
      }
      case 'mcp':
        text = t('home.ready.mcp.text');
        detail = setup.desktop ? r.mcp.file : r.commands.mcp;
        act = setup.desktop ? write('mcp', 'mcp-install', t('settings.integrations.mcp.register')) : copy('mcp', r.commands.mcp);
        break;
      case 'statusline':
        text = sl.scriptPath ? t('home.ready.statusline.text') : t(setup.desktop ? 'home.ready.statusline.noScriptApp' : 'home.ready.statusline.noScript');
        // スクリプトが無ければ書く先が無いので、殻の中でも設定の節へ案内する。
        detail = setup.desktop ? sl.scriptPath : r.commands.statusline;
        act = !setup.desktop ? copy('statusline', r.commands.statusline) : sl.scriptPath ? write('statusline', 'statusline-install', t('settings.integrations.statusline.setup')) : toSettings('statusline');
        break;
      case 'compat':
        text = t('home.ready.compat.drift', { n: summary?.driftCount ?? 0 });
        act = toSettings('compat');
        break;
      case 'git': {
        // 入れ方のコマンドがある OS（macOS と Windows）はコピーさせ、無い OS は設定のツールの節を開く。
        const command = gitInstallCommand(platform);
        text = t('home.ready.git.text');
        detail = command;
        act = command ? copy('git', command) : toSettings('git');
        break;
      }
      case 'editor': {
        const e = r.editor!;
        text = e.name === null ? t('home.ready.editor.customMissing', { command: e.path ?? '' }) : t('home.ready.editor.missing', { name: e.name });
        act = toSettings('editor');
        break;
      }
      case 'notify':
        text = t('home.ready.notify.text');
        act = action(t('home.ready.notify.allow'), name('notify'), { type: 'notify.set', on: true }, true);
        // 要らない人は、通知をオフにして行を消せる（オフにすると ask も下りる。runtime.ts の notify.off）。
        extra = [{ id: 'decline', label: t('home.ready.notify.decline'), ariaLabel: t('home.band.actionFor', { action: t('home.ready.notify.decline'), name: name('notify') }), primary: false, ghost: true, send: { type: 'notify.set', on: false } }];
        break;
    }
    return { key: `ready:${c.key}`, lead: { kind: 'check', tone: c.tone === 'ng' ? 'ng' : 'soft', label: t(c.key === 'compat' ? 'home.ready.state.drift' : c.tone === 'ng' ? 'home.ready.state.ng' : 'home.ready.state.soft') }, name: name(c.key), badge: OPTIONAL.has(c.key) ? t('home.ready.optional') : null, context: null, text, detail, tone: null, trail: [], open: null, actions: [act, ...extra] };
  };

  /** 済んだものの行。畳んだ行を開いたときに出す。 */
  const doneRow = (c: Check): BandRow => {
    let text = '';
    switch (c.key) {
      case 'tmux':
      case 'claude': text = toolOk(t, r.tools[c.key]); break;
      case 'workspace': text = t('home.ready.workspace.ok', { path: ws.path, n: ws.projectCount }); break;
      case 'projects': text = t('home.ready.projects.ok', { n: r.projects?.resolved ?? 0 }); break;
      case 'mcp': text = t('home.ready.mcp.ok'); break;
      case 'statusline': text = t('home.ready.statusline.ok'); break;
      case 'git': text = toolOk(t, r.tools.git!); break;
      case 'editor': {
        const e = r.editor!;
        const name = e.name ?? t('home.ready.name.editor');
        text = e.state === 'app' ? t('home.ready.editor.appOnly', { name, path: e.path ?? '' }) : t('home.ready.editor.ok', { name, path: e.path ?? '' });
        break;
      }
      // 通知の行は尋ね終えたら消えるので、済んだ行にはならない。
      case 'notify': break;
      case 'compat': text = c.tone === 'info' ? t('home.ready.compat.unverified', { local: summary?.localVersion ?? '', verified: summary?.verifiedVersion ?? '' }) : t('home.ready.compat.ok', { version: summary?.verifiedVersion ?? '' }); break;
    }
    const tone = c.tone === 'info' ? 'info' : 'ok';
    return { key: `ready:${c.key}`, lead: { kind: 'check', tone, label: t(`home.ready.state.${tone}`) }, name: name(c.key), badge: null, context: null, text, detail: null, tone: null, trail: [], open: null, actions: [] };
  };

  const todo = checks.filter((c) => !c.ok).sort((a, b) => Number(OPTIONAL.has(a.key)) - Number(OPTIONAL.has(b.key)));
  const done = checks.filter((c) => c.ok);
  const total = checks.length;
  // 始めるのに要る道具のうち、足りないもの。tmux の役の道具は OS の名で言う（Windows は psmux）。
  // 古い psmux は始められるので数えない（道具の ok で見る）。
  const lacking = (['tmux', 'claude'] as const).filter((k) => !r.tools[k].ok).map((k) => name(k));
  const group: BandGroup = {
    id: 'readiness', label: t('home.ready.label'), icon: 'alert', tone: 'warn', count: todo.length, countText: t('home.ready.progress', { done: done.length, total }),
    progress: Math.round((done.length / total) * 100), summary: '', morning: true, rows: todo.map(fixRow),
    fold: done.length > 0 ? { text: t('home.ready.fold', { names: done.map((c) => name(c.key)).join(t('home.ready.separator')) }), rows: done.map(doneRow) } : undefined,
    ...(setup.guide ? { tail: [guideRow(t, setup.guide)] } : {}),
  };
  return { group, note: lacking.length === 0 ? null : t('home.ready.noteNeed', { names: joinNames(t, lacking) }) };
}
