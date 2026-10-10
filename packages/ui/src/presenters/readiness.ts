import { compatState, type Intent, type ReadinessDto, type ToolCheckDto, type Translate } from '@agent-hangar/shared';
import { readinessCompat } from './compat.ts';
import type { BandAction, BandGroup, BandRow } from './home.ts';

/**
 * 欄の下の 1 行の検証（設定の B1）。
 * ok なら「✓ text（note）」、そうでなければ「✗ text」の後ろに直し方（fix か fixCommand）を並べる。
 * soft は無くても動くもので、赤ではなく弱い色で出す。
 */
export type VerifyLine = { ok: boolean; soft: boolean; text: string; note: string | null; fix: string | null; fixCommand: string | null };

export type ToolKey = 'tmux' | 'claude' | 'code' | 'node';

/** tmux の役を担う道具の入れ方。Windows は psmux を入れる。 */
export function muxInstallCommand(platform: string): string {
  return platform === 'win32' ? 'winget install marlocarlo.psmux' : 'brew install tmux';
}

/**
 * 画面を開いている PC の OS。
 * hangar の画面は、サーバと同じ PC のブラウザか WebView で開くので、ブラウザの名乗りから読む。
 */
export function clientPlatform(userAgent: string | undefined = globalThis.navigator?.userAgent): string {
  return userAgent !== undefined && /Windows/.test(userAgent) ? 'win32' : 'darwin';
}

/** ツールごとの直し方。コマンドで直せるものはコマンドを、そうでなければ文（辞書の鍵）を持つ。tmux の入れ方だけは OS で変わるので、toolLine で差し替える。 */
const FIX = {
  tmux: { fix: null, fixCommand: 'brew install tmux', soft: false },
  claude: { fix: 'readiness.fix.claude', fixCommand: null, soft: false },
  code: { fix: 'readiness.fix.code', fixCommand: null, soft: true },
  node: { fix: 'readiness.fix.node', fixCommand: null, soft: false },
} as const satisfies Record<ToolKey, { fix: 'readiness.fix.claude' | 'readiness.fix.code' | 'readiness.fix.node' | null; fixCommand: string | null; soft: boolean }>;

/** 動かせない理由の文。パスがあればパスを主語にする。 */
function problemText(t: Translate, c: ToolCheckDto): string {
  if (c.path === null || c.problem === 'unset') return t('readiness.problem.unset');
  if (c.problem === 'notFile') return t('readiness.problem.notFile', { path: c.path });
  if (c.problem === 'notExecutable') return t('readiness.problem.notExecutable', { path: c.path });
  return t('readiness.problem.missing', { path: c.path });
}

export function toolLine(t: Translate, key: ToolKey, c: ToolCheckDto & { auto?: boolean }, platform: string = clientPlatform()): VerifyLine {
  const f = FIX[key];
  if (c.ok) {
    const auto = key === 'node' && c.auto ? t('readiness.tool.autoFound') : null;
    const note = [c.version, auto].filter((x): x is string => x !== null).join(t('common.list.separator'));
    return { ok: true, soft: false, text: c.path ?? '', note: note === '' ? null : note, fix: null, fixCommand: null };
  }
  return { ok: false, soft: f.soft, text: problemText(t, c), note: f.soft ? t('readiness.tool.optional') : null, fix: f.fix === null ? null : t(f.fix), fixCommand: key === 'tmux' ? muxInstallCommand(platform) : f.fixCommand };
}

/** ワークスペースの検証。登録したプロジェクトが 1 つも無いのも ✗ にする。何も始められないからである。 */
export function workspaceLine(t: Translate, w: ReadinessDto['workspace']): VerifyLine {
  if (!w.exists) return { ok: false, soft: false, text: t('readiness.problem.missing', { path: w.path }), note: null, fix: t('readiness.fix.workspace'), fixCommand: null };
  if (w.projectCount === 0) return { ok: false, soft: false, text: t('readiness.workspace.empty'), note: null, fix: null, fixCommand: null };
  return { ok: true, soft: false, text: w.path, note: t('readiness.workspace.projects', { n: w.projectCount }), fix: null, fixCommand: null };
}

/** 始める前の確認の 6 行の名前。 */
export type ReadinessKey = 'tmux' | 'claude' | 'workspace' | 'mcp' | 'statusline' | 'compat';
/** 任意の行。無くても始められるので、残りがこれだけになったら帯ごと消す（設計書 2.11.4）。 */
const OPTIONAL: ReadonlySet<ReadinessKey> = new Set(['mcp', 'statusline']);
/** 行の調子。info は止めていない知らせ（未確認のバージョン）で、済んだものに数える。 */
type Tone = 'ok' | 'info' | 'soft' | 'ng';
/** 確認の 1 行の事実。文は、帯の行にするときに辞書から引く。 */
type Check = { key: ReadinessKey; ok: boolean; tone: Tone };

/** 確認の行を並べる。互換の行は、古いサーバの答え（compat が無い）では出さず、5 つで数える。 */
function checksOf(r: ReadinessDto): Check[] {
  const ws = r.workspace;
  const rows: Check[] = [
    { key: 'tmux', ok: r.tools.tmux.ok, tone: r.tools.tmux.ok ? 'ok' : 'ng' },
    { key: 'claude', ok: r.tools.claude.ok, tone: r.tools.claude.ok ? 'ok' : 'ng' },
    { key: 'workspace', ok: ws.exists && ws.projectCount > 0, tone: ws.exists && ws.projectCount > 0 ? 'ok' : 'ng' },
    { key: 'mcp', ok: r.mcp.registered, tone: r.mcp.registered ? 'ok' : 'soft' },
    { key: 'statusline', ok: r.statusline.installed, tone: r.statusline.installed ? 'ok' : 'soft' },
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

/** 帯の群 1 つと、帯の右端の注記。 */
export type ReadinessBand = { group: BandGroup; note: string };

/** 動かせないツールの理由の文。パスがあればパスを主語にする。 */
function toolProblem(t: Translate, c: ToolCheckDto): string {
  if (c.path === null || c.problem === 'unset') return t('home.ready.problem.unset');
  if (c.problem === 'notFile') return t('home.ready.problem.notFile', { path: c.path });
  if (c.problem === 'notExecutable') return t('home.ready.problem.notExecutable', { path: c.path });
  return t('home.ready.problem.missing', { path: c.path });
}

const toolOk = (t: Translate, c: ToolCheckDto) => (c.version ? t('home.ready.tool.ok', { path: c.path ?? '', version: c.version }) : c.path ?? '');

/**
 * 始める前の確認を、ホームの帯の群にする（設計書 2.11.4、試作の始める前の確認の B）。
 * 引き出しには直すものだけを 1 行ずつ出し（必須を先、任意を後ろ）、済んだものは 1 行に畳む（fold）。
 * 錠剤は「6 つ中 3 つ」（分母は任意の行も含めて数え、互換の未確認の版は済んだものに数える）で、件数は直すものの数である。
 * 必須が済んで任意の行だけが残るか、全部そろったときは null で、帯の群を出さない。
 * 互換のずれは、直すものとして残る（任意の札は付けない）。
 * 右端のボタンは 1 つで、いまは「設定を開く」か「コマンドをコピー」である（段 5 で文が替わるだけにする）。
 */
export function presentReadiness(r: ReadinessDto, t: Translate, platform: string = clientPlatform()): ReadinessBand | null {
  if (!readinessPending(r)) return null;
  const checks = checksOf(r);
  const name = (k: ReadinessKey) => t(`home.ready.name.${k}`);
  const settings: Intent = { type: 'nav.go', to: { name: 'settings' } };
  const action = (label: string, who: string, intent: Intent, primary: boolean): BandAction => ({ id: 'fix', label, ariaLabel: t('home.band.actionFor', { action: label, name: who }), primary, ghost: false, intent });
  const toSettings = (k: ReadinessKey) => action(t('home.ready.openSettings'), name(k), settings, true);
  const copy = (k: ReadinessKey, command: string) => action(t('home.ready.copyCommand'), name(k), { type: 'clipboard.copy', text: command }, false);
  const sl = r.statusline;
  const ws = r.workspace;
  const summary = readinessCompat(r);

  /** 直すものの行。 */
  const fixRow = (c: Check): BandRow => {
    let text = '';
    let detail: string | null = null;
    let act: BandAction;
    switch (c.key) {
      case 'tmux':
      case 'claude': {
        const tool = r.tools[c.key];
        text = toolProblem(t, tool);
        // 見つからないものだけ、入れる命令を添える（tmux）。claude と、パスはあるのに使えないものは設定で直す。
        const missing = tool.path === null || tool.problem === 'unset';
        const command = c.key === 'tmux' && missing ? muxInstallCommand(platform) : null;
        detail = command;
        act = command ? copy(c.key, command) : toSettings(c.key);
        break;
      }
      case 'workspace':
        text = ws.path === '' ? t('home.ready.workspace.unset') : !ws.exists ? t('home.ready.workspace.missing', { path: ws.path }) : t('home.ready.workspace.empty', { path: ws.path });
        act = toSettings('workspace');
        break;
      case 'mcp':
        text = t('home.ready.mcp.text');
        detail = r.commands.mcp;
        act = copy('mcp', r.commands.mcp);
        break;
      case 'statusline':
        text = sl.scriptPath ? t('home.ready.statusline.text') : t('home.ready.statusline.noScript');
        detail = r.commands.statusline;
        act = copy('statusline', r.commands.statusline);
        break;
      case 'compat':
        text = t('home.ready.compat.drift', { n: summary?.driftCount ?? 0 });
        act = toSettings('compat');
        break;
    }
    return { key: `ready:${c.key}`, lead: { kind: 'check', tone: c.tone === 'ng' ? 'ng' : 'soft', label: t(c.key === 'compat' ? 'home.ready.state.drift' : c.tone === 'ng' ? 'home.ready.state.ng' : 'home.ready.state.soft') }, name: name(c.key), badge: OPTIONAL.has(c.key) ? t('home.ready.optional') : null, context: null, text, detail, tone: null, trail: [], open: null, actions: [act] };
  };

  /** 済んだものの行。畳んだ行を開いたときに出す。 */
  const doneRow = (c: Check): BandRow => {
    let text = '';
    switch (c.key) {
      case 'tmux':
      case 'claude': text = toolOk(t, r.tools[c.key]); break;
      case 'workspace': text = t('home.ready.workspace.ok', { path: ws.path, n: ws.projectCount }); break;
      case 'mcp': text = t('home.ready.mcp.ok'); break;
      case 'statusline': text = t('home.ready.statusline.ok'); break;
      case 'compat': text = c.tone === 'info' ? t('home.ready.compat.unverified', { local: summary?.localVersion ?? '', verified: summary?.verifiedVersion ?? '' }) : t('home.ready.compat.ok', { version: summary?.verifiedVersion ?? '' }); break;
    }
    const tone = c.tone === 'info' ? 'info' : 'ok';
    return { key: `ready:${c.key}`, lead: { kind: 'check', tone, label: t(`home.ready.state.${tone}`) }, name: name(c.key), badge: null, context: null, text, detail: null, tone: null, trail: [], open: null, actions: [] };
  };

  const todo = checks.filter((c) => !c.ok).sort((a, b) => Number(OPTIONAL.has(a.key)) - Number(OPTIONAL.has(b.key)));
  const done = checks.filter((c) => c.ok);
  const total = checks.length;
  const basics = checks.filter((c) => c.key === 'tmux' || c.key === 'claude').every((c) => c.ok);
  const group: BandGroup = {
    id: 'readiness', label: t('home.ready.label'), icon: 'alert', tone: 'warn', count: todo.length, countText: t('home.ready.progress', { done: done.length, total }),
    progress: Math.round((done.length / total) * 100), summary: t('home.ready.summary', { n: todo.length }), morning: true, rows: todo.map(fixRow),
    fold: done.length > 0 ? { text: t('home.ready.fold', { names: done.map((c) => name(c.key)).join(t('home.ready.separator')) }), rows: done.map(doneRow) } : undefined,
  };
  return { group, note: t(basics ? 'home.ready.noteStart' : 'home.ready.noteNeed', { n: todo.length }) };
}
