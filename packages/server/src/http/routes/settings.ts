import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { isLanguage, languageOf, LANGUAGES, terminalAppsFor, type MessageKey, type SettingsDto, type TerminalApp } from '@agent-hangar/shared';
import { isLoopbackSummarizerUrl, type Settings } from '../../config/paths.ts';
import { checkToolPath, expandHome, isCommandName, toolPathIssue } from '../../config/readiness.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../../projects/registry.ts';
import { translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, readJson, tooLargeResult } from './common.ts';

/** 設定の経路が使う依存。 */
export type SettingsRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'settings' | 'updateSettings'> & LanguageDeps;

/** 空にできない文字列の設定。 */
const TEXT_SETTING_KEYS = ['workspaceRoot', 'claudeDir'] as const;
/** 未設定を null で表すパスの設定。空文字は null と同じに扱う。 */
const PATH_SETTING_KEYS = ['tmuxPath', 'codePath', 'nodePath', 'claudePath'] as const;
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
type LabeledSetting = (typeof TEXT_SETTING_KEYS)[number] | (typeof PATH_SETTING_KEYS)[number];
const SETTING_LABEL = {
  workspaceRoot: 'settings.label.workspaceRoot', claudeDir: 'settings.label.claudeDir', tmuxPath: 'settings.label.tmuxPath', codePath: 'settings.label.codePath', nodePath: 'settings.label.nodePath', claudePath: 'settings.label.claudePath',
} as const satisfies Record<LabeledSetting, MessageKey>;

export const toSettingsDto = (s: Settings): SettingsDto => ({ workspaceRoot: s.workspaceRoot, claudeDir: s.claudeDir, tmuxPath: s.tmuxPath, terminalApp: s.terminalApp, codePath: s.codePath, lmStudioUrl: s.lmStudioUrl, lmStudioModel: s.lmStudioModel, summaryFallback: s.summaryFallback, summaryHourlyCap: s.summaryHourlyCap, allowExternalSummarizer: s.allowExternalSummarizer, configApproval: s.configApproval === 'auto' ? 'auto' : 'each', configBundleSync: s.configBundleSync === true, nodePath: s.nodePath ?? null, claudePath: s.claudePath ?? null, language: languageOf(s.language) });

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
    // ワークスペースは、保存する前にディレクトリがあることを確かめる。
    // 無いところを保存すると、プロジェクトが 1 つも登録されないまま、何が悪いのかが画面から読めない。
    if (patch.workspaceRoot !== undefined) {
      const root = expandHome(patch.workspaceRoot.trim());
      const st = fs.statSync(root, { throwIfNoEntry: false });
      if (!st) return c.json({ error: tr('settings.path.missing', { label: label('workspaceRoot'), path: root }) }, 400);
      if (!st.isDirectory()) return c.json({ error: tr('settings.path.notDirectory', { label: label('workspaceRoot'), path: root }) }, 400);
      patch.workspaceRoot = root;
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
      if (!name && !path.isAbsolute(expandHome(raw))) return c.json({ error: tr('settings.path.badForm', { label: label(key) }) }, 400);
      // 判定は起動の前の確かめ（RunManager の precheck）と同じ toolPathIssue を使う。
      const issue = toolPathIssue(raw);
      if (issue) return c.json({ error: issue.key === 'settings.path.notOnPath' ? tr(issue.key, { label: label(key), name: issue.name }) : tr(issue.key, { label: label(key), path: issue.path }) }, 400);
      const t = checkToolPath(raw);
      // パスは ~ を直した値で保存する（起動するときに ~ は直されない）。名前は打たれたまま残す。
      patch[key] = name ? raw : t.path;
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
    // 届いた skills、commands、agents の承諾の仕方。実行される指示なので、既定は毎回で、auto は明示で選ぶ。
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
    const s = deps.updateSettings(patch);
    // ワークスペースが変わったら、その場でプロジェクトを登録し直す。
    // 登録したプロジェクトと、そこへ入ったセッションは、書いた行から配る層が配る。
    // claudeDir の変更は索引の読み取り元なので、次の起動で反映する。
    if (patch.workspaceRoot !== undefined && patch.workspaceRoot !== before.workspaceRoot) {
      syncProjectsFromWorkspace(db, deviceId, patch.workspaceRoot);
      assignSessions(db, deviceId);
    }
    // 保存の知らせは画面が欄の横に出す（設定の C1）。サーバからはトーストを配らない。
    return c.json(toSettingsDto(s));
  });
}
