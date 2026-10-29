import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { codexEnabledOf, codexInjectionOf, codexInterceptOf, codexShareOf, opencodeShareOf, isCodexInjection, DEFAULT_AUTO_DONE_IDLE_DAYS, DEFAULT_SUMMARY_CLAUDE_MODEL, EDITOR_TERMINALS, isAutoDoneIdleDays, isEditorId, isLanguage, isModelName, isIdleUnload, isLocalContext, isOpencodeInjection, isProviderPrepId, isSummaryEngine, idleUnloadOf, localContextOf, providerPrepOf, providerPrepsOf, languageOf, LANGUAGES, opencodeEnabledOf, opencodeInjectionOf, opencodeInterceptOf, opencodePermissionPresetOf, terminalAppsFor, type EditorSetting, type EditorTerminal, type MessageKey, type SettingsDto, type TerminalApp, type WorkspaceRootPreviewDto } from '@agent-hangar/shared';
import { isLoopbackSummarizerUrl, type Settings } from '../../config/paths.ts';
import { createNodeCheck, isFullPath, nodeBuildIssue } from '../../config/node.ts';
import { checkToolPath, expandHome, isCommandName, toolPathIssue } from '../../config/readiness.ts';
import { touchRow, tryWrites } from '../../db/notify.ts';
import { workspaceSyncOutcomes } from '../../projects/registerMany.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../../projects/registry.ts';
import { allTargets } from '../../sync/config/targets/index.ts';
import { translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, readJson, tooLargeResult } from './common.ts';

/** 設定の経路が使う依存。 */
export type SettingsRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'settings' | 'updateSettings' | 'nodeCheck' | 'hub' | 'live'> & LanguageDeps;

/** 空にできない文字列の設定。作成場所（workspaceRoot）は任意なので、ここに入れず別に見る。 */
const TEXT_SETTING_KEYS = ['claudeDir'] as const;
/** 未設定を null で表すパスの設定。空文字は null と同じに扱う。 */
const PATH_SETTING_KEYS = ['tmuxPath', 'nodePath', 'claudePath', 'codexPath', 'opencodePath'] as const;
/** 外部ターミナルは、動いている OS で開けるものだけを受ける。別の OS の値を保存させない。 */
const TERMINAL_APPS = new Set<string>(terminalAppsFor(process.platform));
const TERMINAL_APP_INVALID = process.platform === 'win32' ? ('settings.terminalApp.invalidWindows' as const) : ('settings.terminalApp.invalid' as const);
/**
 * 「1 時間の上限」の上限。
 * 画面の入力（SettingsScreen の Stepper）と同じにする。
 */
const SUMMARY_HOURLY_CAP_MAX = 200;
/**
 * 設定の項目の、画面の欄の見出し。
 * エラー文は画面のトーストに出るので、内部のキー名ではなくこの見出しで言う。
 * 見出しそのものは辞書（settings.label.*）にあり、ここには鍵を置く。
 */
type LabeledSetting = 'workspaceRoot' | (typeof TEXT_SETTING_KEYS)[number] | (typeof PATH_SETTING_KEYS)[number];
const SETTING_LABEL = {
  workspaceRoot: 'settings.label.workspaceRoot', claudeDir: 'settings.label.claudeDir', tmuxPath: 'settings.label.tmuxPath', nodePath: 'settings.label.nodePath', claudePath: 'settings.label.claudePath', codexPath: 'settings.label.codexPath', opencodePath: 'settings.label.opencodePath',
} as const satisfies Record<LabeledSetting, MessageKey>;

/**
 * 設定を画面へ返す形にする。
 * API キーは返さず、保存しているかだけを返す。設定の変更は全部の画面へ配る（settings.changed）ので、秘密を載せない。
 */
/** Codex の 3 項目（ベータ）。設定の画面の行があるので、書かれていなくても既定（切、最小限、切）で常に返す。 */
const codexSettingsDto = (s: Settings): Pick<SettingsDto, 'codexEnabled' | 'codexInjection' | 'codexIntercept'> => ({ codexEnabled: codexEnabledOf(s), codexInjection: codexInjectionOf(s), codexIntercept: codexInterceptOf(s) });

/** 設定の同期の対象ごとの入切。登録済みの対象名と真偽値だけを残し、ほかは捨てる。 */
export const configTargetsOf = (v: unknown): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  const names = new Set(allTargets().map((t) => t.name));
  for (const [k, x] of Object.entries(v)) if (names.has(k) && typeof x === 'boolean') out[k] = x;
  return out;
};

export const toSettingsDto = (s: Settings): SettingsDto => ({ workspaceRoot: s.workspaceRoot, trustedWorkspaceRoot: s.trustedWorkspaceRoot ?? null, claudeDir: s.claudeDir, tmuxPath: s.tmuxPath, terminalApp: s.terminalApp, editor: s.editor, summaryEngine: s.summaryEngine ?? 'off', summaryClaudeModel: s.summaryClaudeModel ?? DEFAULT_SUMMARY_CLAUDE_MODEL, lmStudioUrl: s.lmStudioUrl, lmStudioModel: s.lmStudioModel, summaryApiKeySet: typeof s.summaryApiKey === 'string' && s.summaryApiKey !== '', summaryFallback: s.summaryFallback, summaryHourlyCap: s.summaryHourlyCap, allowExternalSummarizer: s.allowExternalSummarizer, configApproval: s.configApproval === 'auto' ? 'auto' : 'each', configBundleSync: s.configBundleSync === true, configTargets: configTargetsOf(s.configTargets), askStatusAtEnd: s.askStatusAtEnd !== false, liveHints: s.liveHints !== false, notifyUser: s.notifyUser !== false, unreadBadge: s.unreadBadge !== false, unreadOs: s.unreadOs !== false, unreadPhone: s.unreadPhone !== false, autoDone: s.autoDone !== false, autoDoneIdleDays: isAutoDoneIdleDays(s.autoDoneIdleDays) ? s.autoDoneIdleDays : DEFAULT_AUTO_DONE_IDLE_DAYS, autoPark: s.autoPark !== false, remoteControl: s.remoteControl !== false, defaultModel: s.defaultModel ?? null, nodePath: s.nodePath ?? null, claudePath: s.claudePath ?? null, codexPath: s.codexPath ?? null, opencodePath: s.opencodePath ?? null, language: languageOf(s.language), ...codexSettingsDto(s), codexShareInstructions: codexShareOf(s).instructions, codexShareMcp: codexShareOf(s).mcp, opencodeShareInstructions: opencodeShareOf(s).instructions, opencodeShareMcp: opencodeShareOf(s).mcp, opencodeEnabled: opencodeEnabledOf(s), opencodeInjection: opencodeInjectionOf(s), opencodeIntercept: opencodeInterceptOf(s), opencodePermissionPreset: opencodePermissionPresetOf(s), opencodeLocalContext: localContextOf(s), opencodeIdleUnload: idleUnloadOf(s), opencodeProviderPrep: providerPrepsOf(s.opencodeProviderPrep) });

/** http か https で、host のある URL だけを通す。`http://` のような繋ぎ先にならない文字列を弾く。 */
function parseHttpUrl(v: string): URL | null {
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '' ? u : null;
}

/** 設定の経路。読むと、項目ごとに検査してから書くを持つ。 */
export function settingsRoutes(api: Hono, deps: SettingsRouteDeps): void {
  const tr = translatorOf(deps.language);
  const label = (key: LabeledSetting) => tr(SETTING_LABEL[key]);
  const { db, deviceId } = deps;
  const nodeCheck = deps.nodeCheck ?? createNodeCheck();

  api.get('/settings', (c) => c.json(toSettingsDto(deps.settings())));
  api.patch('/settings', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as Record<string, unknown>;
    // 受け取るのは既知の項目だけにする。本文をそのまま設定に混ぜない。
    const patch: Partial<SettingsDto> = {};
    for (const key of TEXT_SETTING_KEYS) {
      if (!(key in body)) continue;
      const v = body[key];
      if (typeof v !== 'string' || v.trim() === '') return c.json({ error: tr('settings.error.empty', { label: label(key) }) }, 400);
      patch[key] = v;
    }
    // 新しいフォルダの作成場所（workspaceRoot）は任意で、空（null と空白だけも）は「決めていない」として保存する（2026-10-13）。
    // 決めるときは、保存する前にディレクトリがあることを確かめる。
    // 無いところを保存すると、プロジェクトが 1 つも登録されないまま、何が悪いのかが画面から読めない。
    if ('workspaceRoot' in body) {
      const v = body.workspaceRoot;
      if (v !== null && typeof v !== 'string') return c.json({ error: tr('settings.error.badValue', { label: label('workspaceRoot') }) }, 400);
      patch.workspaceRoot = typeof v === 'string' ? v.trim() : '';
    }
    if (patch.workspaceRoot !== undefined && patch.workspaceRoot !== '') {
      const root = expandHome(patch.workspaceRoot);
      const st = fs.statSync(root, { throwIfNoEntry: false });
      if (!st) return c.json({ error: tr('settings.path.missing', { label: label('workspaceRoot'), path: root }) }, 400);
      if (!st.isDirectory()) return c.json({ error: tr('settings.path.notDirectory', { label: label('workspaceRoot'), path: root }) }, 400);
      patch.workspaceRoot = root;
    }
    // 試し（hangar workspace set --dry-run、2026-10-15）。
    // 作成場所だけを受け、上の検証を通したうえで、保存のときに自動で登録される直下のフォルダを返す。
    // 保存の下の段と同じ関数（syncProjectsFromWorkspace と assignSessions）を走らせて巻き戻すので、何も書かず、何も配らない（db/notify.ts の tryWrites）。
    if ('dryRun' in body) {
      const dryRun = body.dryRun;
      const onlyRoot = Object.keys(body).every((k) => k === 'workspaceRoot' || k === 'dryRun') && patch.workspaceRoot !== undefined;
      if (typeof dryRun !== 'boolean' || (dryRun && !onlyRoot)) return c.json({ error: tr('settings.error.badValue', { label: 'dryRun' }) }, 400);
      if (dryRun) {
        const next = patch.workspaceRoot!;
        const previous = deps.settings().workspaceRoot;
        const unchanged = next === previous;
        const preview: WorkspaceRootPreviewDto = { dryRun: true, workspaceRoot: next, previous, unchanged, register: next === '' || unchanged ? [] : tryWrites(db, () => workspaceSyncOutcomes(db, deviceId, next)) };
        return c.json(preview);
      }
    }
    for (const key of PATH_SETTING_KEYS) {
      if (!(key in body)) continue;
      const v = body[key];
      if (v !== null && typeof v !== 'string') return c.json({ error: tr('settings.error.badValue', { label: label(key) }) }, 400);
      // 空文字は「未設定」と同じ意味なので null に寄せる。
      // 前後の空白は落とす。空白付きのままでは、そのパスで起動できない。
      if (typeof v !== 'string' || v.trim() === '') { patch[key] = null; continue; }
      // 保存する前に、あることと実行できることを確かめる。
      // 動かないパスを保存すると、起動や要約が後になって、別の場所で失敗する。
      // 名前だけ（tmux など）は PATH から探して確かめ、打たれたまま保存する。起動のときも子プロセスが PATH から探すからである。
      // ./x や bin/x のような相対パスは、サーバの作業ディレクトリで読むとどこを指すかが分からないので弾く。
      const raw = v.trim();
      const name = isCommandName(raw);
      // Node のパスは、殻（node.rs）が次の起動でそのまま起こす。殻は名前を PATH から引かず、相対のパスも読めないので、フルパスだけを受ける。
      // 殻と CLI は ~ も展開しないので、展開前の値で見る（~/x は、展開すれば保存できても使われない）。
      if (key === 'nodePath' && (name || !isFullPath(raw))) return c.json({ error: tr('settings.node.notAbsolute', { label: label(key) }) }, 400);
      if (!name && !path.isAbsolute(expandHome(raw))) return c.json({ error: tr('settings.path.badForm', { label: label(key) }) }, 400);
      // 判定は起動の前の確かめ（RunManager の precheck）と同じ toolPathIssue を使う。
      const issue = toolPathIssue(raw);
      if (issue) return c.json({ error: issue.key === 'settings.path.notOnPath' ? tr(issue.key, { label: label(key), name: issue.name }) : tr(issue.key, { label: label(key), path: issue.path }) }, 400);
      const t = checkToolPath(raw);
      // Node は、殻と同じ条件（Node-API が manifest.json の nodeApi 以上で、アーキテクチャが同じ）で確かめる。
      // 合わない Node を保存すると、画面では ✓ に見えても、次の起動で殻はその Node を使わず、ほかの場所を探す。
      if (key === 'nodePath' && t.path !== null) {
        const bad = await nodeBuildIssue(t.path, nodeCheck);
        if (bad?.kind === 'notNode') return c.json({ error: tr('settings.node.notNode', { label: label(key), path: t.path }) }, 400);
        if (bad?.kind === 'mismatch' && bad.fit === 'version') return c.json({ error: tr('settings.node.tooOld', { label: label(key), path: t.path, found: bad.found.version, min: bad.need.min, napi: bad.need.napi }) }, 400);
        if (bad?.kind === 'mismatch') return c.json({ error: tr('settings.node.wrongArch', { label: label(key), path: t.path, foundArch: bad.found.arch, arch: bad.need.arch }) }, 400);
      }
      // パスは ~ を直した値で保存する（起動するときに ~ は直されない）。名前は打たれたまま残す。
      patch[key] = name ? raw : t.path;
    }
    // エディタ。足りない項目は今の値で埋める。表のエディタのパスは、ほかのパスの欄と同じく保存する前に確かめる。
    // 任意のコマンドは {path} が要る（どのファイルを開くかが渡らない）。フォルダのコマンドは空なら、ファイルのコマンドから作る。
    if ('editor' in body) {
      const v = body.editor;
      const bad = () => c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.editor') }) }, 400);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad();
      const o = v as Record<string, unknown>;
      if ('id' in o && !isEditorId(o.id)) return bad();
      if ('terminal' in o && !(EDITOR_TERMINALS as readonly unknown[]).includes(o.terminal)) return bad();
      for (const k of ['fileCmd', 'dirCmd'] as const) if (k in o && typeof o[k] !== 'string') return bad();
      if ('path' in o && o.path !== null && typeof o.path !== 'string') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.editorPath') }) }, 400);
      const cur = deps.settings().editor;
      const next: EditorSetting = {
        id: isEditorId(o.id) ? o.id : cur.id,
        path: 'path' in o ? (typeof o.path === 'string' && o.path.trim() !== '' ? o.path.trim() : null) : cur.path,
        fileCmd: typeof o.fileCmd === 'string' ? o.fileCmd.trim() : cur.fileCmd,
        dirCmd: typeof o.dirCmd === 'string' ? o.dirCmd.trim() : cur.dirCmd,
        terminal: 'terminal' in o ? (o.terminal as EditorTerminal) : cur.terminal,
      };
      if (next.path !== null) {
        const raw = next.path;
        const name = isCommandName(raw);
        if (!name && !path.isAbsolute(expandHome(raw))) return c.json({ error: tr('settings.path.badForm', { label: tr('settings.label.editorPath') }) }, 400);
        const issue = toolPathIssue(raw);
        if (issue) return c.json({ error: issue.key === 'settings.path.notOnPath' ? tr(issue.key, { label: tr('settings.label.editorPath'), name: issue.name }) : tr(issue.key, { label: tr('settings.label.editorPath'), path: issue.path }) }, 400);
        next.path = name ? raw : checkToolPath(raw).path;
      }
      // 選んだばかりの任意のコマンドは空のまま保存できる（欄を出してから書いてもらう）。空のうちは開くと断る。
      if (next.id === 'custom' && next.fileCmd !== '' && !next.fileCmd.includes('{path}')) return c.json({ error: tr('settings.editor.needPath', { label: tr('settings.label.editorFileCmd'), token: '{path}' }) }, 400);
      if (next.id === 'custom' && next.dirCmd !== '' && !next.dirCmd.includes('{path}')) return c.json({ error: tr('settings.editor.needPath', { label: tr('settings.label.editorDirCmd'), token: '{path}' }) }, 400);
      patch.editor = next;
    }
    if ('terminalApp' in body) {
      const v = body.terminalApp;
      if (typeof v !== 'string' || !TERMINAL_APPS.has(v)) return c.json({ error: tr(TERMINAL_APP_INVALID, { label: tr('settings.label.terminalApp') }) }, 400);
      patch.terminalApp = v as TerminalApp;
    }
    if ('lmStudioUrl' in body) {
      // URL の解析は前後の空白を黙って落とすので、保存する値も落としておく。
      // 落とさないと、貼り付けで空白が混ざった値がそのまま設定に残る。
      const v = typeof body.lmStudioUrl === 'string' ? body.lmStudioUrl.trim() : body.lmStudioUrl;
      // host の無い http:// は繋ぎ先にならないので、形だけでなく URL として読めることを確かめる。
      if (typeof v !== 'string' || !parseHttpUrl(v)) return c.json({ error: tr('settings.lmStudioUrl.invalid', { label: tr('settings.label.lmStudioUrl') }) }, 400);
      // 末尾の / は付けない。呼び出し側が /v1/... を足すので、二重の / を作らない。
      patch.lmStudioUrl = v.replace(/\/+$/, '');
    }
    if ('lmStudioModel' in body) {
      const v = body.lmStudioModel;
      if (v !== null && typeof v !== 'string') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.lmStudioModel') }) }, 400);
      // 空文字と空白だけの文字列は「未設定」と同じ意味なので null に寄せる。
      // 前後の空白は落とす。パス系の設定と同じ扱いにそろえる。
      patch.lmStudioModel = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    }
    // 要約エンジン（使わない、Claude、OpenAI 互換）。
    if ('summaryEngine' in body) {
      const v = body.summaryEngine;
      if (!isSummaryEngine(v)) return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.summaryEngine') }) }, 400);
      patch.summaryEngine = v;
    }
    // モデルの名前は claude の --model へそのまま渡るので、形を確かめる（引数として読まれる先頭のハイフンを断る）。
    if ('summaryClaudeModel' in body) {
      const v = typeof body.summaryClaudeModel === 'string' ? body.summaryClaudeModel.trim() : body.summaryClaudeModel;
      if (!isModelName(v)) return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.summaryClaudeModel') }) }, 400);
      patch.summaryClaudeModel = v;
    }
    // 既定のモデル。空は Claude Code の既定（null）である。
    if ('defaultModel' in body) {
      const raw = body.defaultModel;
      const v = typeof raw === 'string' ? raw.trim() : raw;
      if (v === null || v === '') patch.defaultModel = null;
      else if (!isModelName(v)) return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.defaultModel') }) }, 400);
      else patch.defaultModel = v;
    }
    // API キーは書くだけで、返さない。空文字と null は消す。
    if ('summaryApiKey' in body) {
      const v = body.summaryApiKey;
      if (v !== null && typeof v !== 'string') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.summaryApiKey') }) }, 400);
      patch.summaryApiKey = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    }
    if ('summaryFallback' in body) {
      const v = body.summaryFallback;
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.summaryFallback') }) }, 400);
      patch.summaryFallback = v;
    }
    if ('summaryHourlyCap' in body) {
      const v = body.summaryHourlyCap;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > SUMMARY_HOURLY_CAP_MAX) return c.json({ error: tr('settings.hourlyCap.invalid', { max: SUMMARY_HOURLY_CAP_MAX, label: tr('settings.label.summaryHourlyCap') }) }, 400);
      patch.summaryHourlyCap = v;
    }
    if ('allowExternalSummarizer' in body) {
      const v = body.allowExternalSummarizer;
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.allowExternalSummarizer') }) }, 400);
      patch.allowExternalSummarizer = v;
    }
    // 届いた skills、commands、agents の承認の仕方。実行される指示なので、既定は毎回で、auto は明示で選ぶ。
    if ('configApproval' in body) {
      const v = body.configApproval;
      if (v !== 'each' && v !== 'auto') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.configApproval') }) }, 400);
      patch.configApproval = v;
    }
    // 設定の同期の入り切り。
    if ('configBundleSync' in body) {
      const v = body.configBundleSync;
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.configBundleSync') }) }, 400);
      patch.configBundleSync = v;
    }
    // 設定の同期の対象ごとの入切。全体の置き換えで、登録済みの対象名と真偽値だけを残す。
    if ('configTargets' in body) {
      const v = body.configTargets;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.configBundleSync') }) }, 400);
      patch.configTargets = configTargetsOf(v);
    }
    // hangar が起動する claude に足す段の入り切り（launch/injection.ts）。次に起こす claude から効く。
    // remoteControl は claude を会話アプリにつなぐ --remote-control の入り切り（launch/remoteControl.ts）。
    // notifyUser は notify_user を使う指示の段、unreadBadge・unreadOs・unreadPhone は未読の出し先（数、OS の通知、スマホ）の入り切りである。
    for (const key of ['askStatusAtEnd', 'liveHints', 'notifyUser', 'unreadBadge', 'unreadOs', 'unreadPhone', 'remoteControl'] as const) {
      if (!(key in body)) continue;
      const v = body[key];
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr(`settings.label.${key}`) }) }, 400);
      patch[key] = v;
    }
    // hangar が自分で行うこと（自動の Done、Done と Archived の自動の停止）の入り切り。次の見回りから効く。
    for (const key of ['autoDone', 'autoPark'] as const) {
      if (!(key in body)) continue;
      const v = body[key];
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr(key === 'autoDone' ? 'settings.label.autoDone' : 'settings.label.autoPark') }) }, 400);
      patch[key] = v;
    }
    // 長く動いていない会話を Done にする日数。選べる値だけを受ける。次の見回りから効く。
    if ('autoDoneIdleDays' in body) {
      const v = body.autoDoneIdleDays;
      if (!isAutoDoneIdleDays(v)) return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.autoDoneIdleDays') }) }, 400);
      patch.autoDoneIdleDays = v;
    }
    // opencode を有効にするか（ベータ）と、システムプロンプトへの追記。どちらも次に起こす opencode から効く。
    if ('opencodeEnabled' in body) {
      const v = body.opencodeEnabled;
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.opencodeEnabled') }) }, 400);
      patch.opencodeEnabled = v;
    }
    if ('opencodeInjection' in body) {
      const v = body.opencodeInjection;
      if (!isOpencodeInjection(v)) return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.opencodeInjection') }) }, 400);
      patch.opencodeInjection = v;
    }
    // 外のターミナルの opencode コマンドを hangar 経由で起動するか。包みの本体を書き直し、次に開いたターミナルから効く。
    if ('opencodeIntercept' in body) {
      const v = body.opencodeIntercept;
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.opencodeIntercept') }) }, 400);
      patch.opencodeIntercept = v;
    }
    // Codex を有効にするか（ベータ）、システムプロンプトへの追記、外のターミナルの横取り。設定の画面の行は段 C で足す。
    if ('codexEnabled' in body) {
      const v = body.codexEnabled;
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.codexEnabled') }) }, 400);
      patch.codexEnabled = v;
    }
    if ('codexInjection' in body) {
      const v = body.codexInjection;
      if (!isCodexInjection(v)) return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.codexInjection') }) }, 400);
      patch.codexInjection = v;
    }
    if ('codexIntercept' in body) {
      const v = body.codexIntercept;
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.codexIntercept') }) }, 400);
      patch.codexIntercept = v;
    }
    // hangar が起動する opencode に許可のひな形を重ねるか。次に起こす会話から効く。
    if ('opencodePermissionPreset' in body) {
      const v = body.opencodePermissionPreset;
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.opencodePermissionPreset') }) }, 400);
      patch.opencodePermissionPreset = v;
    }
    // Claude Code の指示と MCP の登録を Codex・opencode に渡すか。次に起こす会話から効く。
    for (const k of ['codexShareInstructions', 'codexShareMcp', 'opencodeShareInstructions', 'opencodeShareMcp'] as const) {
      if (!(k in body)) continue;
      const v = body[k];
      if (typeof v !== 'boolean') return c.json({ error: tr('settings.error.badValue', { label: tr(`settings.label.${k}`) }) }, 400);
      patch[k] = v;
    }
    // 起動前に LM Studio のモデルを載せる長さ。選べる長さだけを受ける。次の起動から効く。
    if ('opencodeLocalContext' in body) {
      const v = body.opencodeLocalContext;
      if (!isLocalContext(v)) return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.opencodeLocalContext') }) }, 400);
      patch.opencodeLocalContext = v;
    }
    // 使っていないローカルのモデルを外すまでの分。選べる分だけを受ける（0 は外さない）。見張りが呼ばれるたびに読むので、すぐ効く。
    if ('opencodeIdleUnload' in body) {
      const v = body.opencodeIdleUnload;
      if (!isIdleUnload(v)) return c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.opencodeIdleUnload') }) }, 400);
      patch.opencodeIdleUnload = v;
    }
    // 接続先の準備のコマンド。届いた接続先だけを替える（null か、始める前のコマンドが空なら外す）。次の起動から効く。
    if ('opencodeProviderPrep' in body) {
      const v = body.opencodeProviderPrep;
      const bad = () => c.json({ error: tr('settings.error.badValue', { label: tr('settings.label.opencodeProviderPrep') }) }, 400);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return bad();
      const next = { ...providerPrepsOf(deps.settings().opencodeProviderPrep) };
      for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
        if (!isProviderPrepId(id)) return bad();
        const p = raw === null ? null : providerPrepOf(raw);
        if (p) next[id] = p;
        else delete next[id];
      }
      patch.opencodeProviderPrep = next;
    }
    // 言語はこの PC の設定で、画面の文とサーバの文の両方が読む。辞書にある言語だけを受ける。
    if ('language' in body) {
      const v = body.language;
      if (!isLanguage(v)) return c.json({ error: tr('settings.language.invalid', { languages: LANGUAGES.join(tr('common.list.or')), label: tr('settings.label.language') }) }, 400);
      patch.language = v;
    }
    if (Object.keys(patch).length === 0) return c.json({ error: tr('settings.error.nothingToUpdate') }, 400);
    // 要約器には会話の本文が送られる。宛先は既定でループバックだけにし、明示の許しがあるときだけ外へ出す。
    // 許しと宛先は同じ要求で見る。片方ずつ変えて素通りする隙間を作らない。
    const cur = deps.settings();
    const allowExternal = patch.allowExternalSummarizer ?? cur.allowExternalSummarizer;
    const nextLmUrl = patch.lmStudioUrl ?? cur.lmStudioUrl;
    if (!allowExternal && !isLoopbackSummarizerUrl(nextLmUrl)) {
      return c.json({ error: tr('settings.summarizer.loopbackOnly', { label: tr('settings.label.allowExternalSummarizer') }) }, 400);
    }
    const before = deps.settings();
    // フォルダの信頼の同意は、同意した作業フォルダにだけ効く。作業フォルダを変えたら同意を消す（新しい場所は改めて同意を取る）。
    if (patch.workspaceRoot !== undefined && patch.workspaceRoot !== before.workspaceRoot && before.trustedWorkspaceRoot) patch.trustedWorkspaceRoot = null;
    const s = deps.updateSettings(patch);
    // ワークスペースが変わったら、その場でプロジェクトを登録し直す。
    // 登録したプロジェクトと、そこへ入ったセッションは、書いた行から配る層が配る。
    // claudeDir の変更は索引の読み取り元なので、次の起動で反映する。
    if (patch.workspaceRoot !== undefined && patch.workspaceRoot !== '' && patch.workspaceRoot !== before.workspaceRoot) {
      syncProjectsFromWorkspace(db, deviceId, patch.workspaceRoot);
      assignSessions(db, deviceId);
    }
    // 自動の停止を替えると、休みのまま残る Done と Archived を実行中に数えるか（parked）が変わる。
    // 行は変わらないので、動いているもののうち印の付いたものを名指しして配り直してもらう。
    if (patch.autoPark !== undefined && patch.autoPark !== (before.autoPark !== false)) touchParkable(db, deps.live().map((l) => l.sessionId));
    // 変えた欄を全部の画面へ知らせる。道具のパスや作業フォルダが変わると、準備の確かめ（ホームの帯、設定の欄の下）の答えも変わるので、画面は読み直す。
    // 保存の知らせは画面が欄の横に出す（設定の C1）。サーバからはトーストを配らない。
    deps.hub.broadcast({ type: 'settings.changed', settings: toSettingsDto(s), keys: Object.keys(patch) as (keyof SettingsDto)[] });
    return c.json(toSettingsDto(s));
  });
}

/** 動いている会話（Claude の UUID）のうち、Done か Archived の印が付いたものの行を配り直してもらう。 */
function touchParkable(db: SettingsRouteDeps['db'], providerSessionIds: string[]): void {
  if (providerSessionIds.length === 0) return;
  const rows = db.prepare(`
    select s.id from sessions s join session_states st on st.session_id = s.id and st.deleted_at is null
    where s.deleted_at is null and st.status in ('done', 'archived') and s.provider_session_id in (${providerSessionIds.map(() => '?').join(',')})
  `).all(...providerSessionIds) as { id: string }[];
  for (const r of rows) touchRow(db, 'sessions', r.id);
}
