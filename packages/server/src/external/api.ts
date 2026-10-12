import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LANGUAGE, terminalAppFor, type EditorSetting, type EditorsDto, type EditorTestDto, type KnownEditorId, type Language } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import { ToolVersions } from '../config/readiness.ts';
import type { ExternalApi } from '../http/deps.ts';
import { openTargetCommand } from '../platform/browser.ts';
import { breakawayExec } from './breakaway.ts';
import { currentEditor, defaultEditorHost, detectEditors, planEditorLaunch, type EditorHost, type EditorTarget } from './editors.ts';
import { EditorMissingError, execFile, openArgvInTerminalApp, openDirInTerminalApp, openInEditor, openInTerminalApp, type Exec } from './open.ts';
import { errorText, MessageError, msg, render } from '../i18n/message.ts';

/** 「テスト」で開く見本のファイルの名前。hangar の置き場に書き、3 行目を開く。 */
export const EDITOR_TEST_FILE = 'hangar-editor-test.md';

/** 版を読むエディタ。JetBrains の起動用のファイルは --version でも IDE を起こすことがあるので読まない。 */
const VERSIONED: ReadonlySet<KnownEditorId> = new Set(['vscode', 'cursor', 'windsurf', 'zed']);

/**
 * ターミナルとエディタとブラウザへの受け渡しを、HTTP が触る形に組む。
 * 設定は書き替わるので、呼ばれた時点の settings を読む。
 * 外部ターミナルは、別の OS の値が残っていても、動いている OS で開ける値に読み替えてから渡す。
 *
 * launcher は Windows の殻が渡す、殻の実行ファイルの場所である（HANGAR_LAUNCHER）。
 * 渡されたら、外のアプリは殻を起こし役にして Hangar のジョブの外で起こす（breakaway.ts）。
 * 端末から起こしたサーバはジョブに入っていないので、渡されず、直に起こす。
 *
 * openShellTab は、ターミナルの中で動くエディタ（任意のコマンドの「シェルタブで開く」）を、そのセッションの実行中の run のシェルタブで起こす口である。
 * run が無ければ偽を返し、そのときは外部ターミナルで開く。
 */
export function createExternalApi(o: {
  home: string;
  settings: () => Pick<Settings, 'tmuxPath' | 'terminalApp' | 'editor'>;
  launcher?: string;
  openShellTab?: (o: { sessionId: string; argv: string[]; title: string }) => boolean;
  /** テストの答えの文の言語。 */
  language?: () => Language;
  /** 以下は試験が差し替える。 */
  exec?: Exec;
  platform?: NodeJS.Platform;
  host?: EditorHost;
  /** エディタの CLI の版を読む。既定は 3 秒で切る ToolVersions。 */
  version?: (file: string) => Promise<string | null>;
}): ExternalApi {
  const platform = o.platform ?? process.platform;
  const direct = o.exec ?? execFile;
  const exec = platform === 'win32' && o.launcher ? breakawayExec(direct, o.launcher) : direct;
  const host = () => o.host ?? defaultEditorHost();
  const versions = new ToolVersions(3000);
  const version = o.version ?? ((file: string) => versions.get(file, ['--version']));

  /** 見つからないとき、ほかに見つかっているエディタを添える（画面の「今回は <名前> で開く」）。 */
  const withOthers = (e: unknown, current: EditorSetting): unknown => {
    if (e instanceof EditorMissingError) e.others = detectEditors(host()).filter((c) => c.state !== 'none' && c.id !== current.id).map((c) => c.id);
    return e;
  };

  async function openEditor(a: { target: string; line?: number | null; once?: KnownEditorId; sessionId?: string }): Promise<string> {
    const s = o.settings();
    // 「今回は <名前> で開く」は、設定を変えずにそのエディタで 1 回だけ開く（場所は自動で探す）。
    const editor: EditorSetting = a.once ? { id: a.once, path: null, fileCmd: '', dirCmd: '', terminal: 'none' } : s.editor;
    const dir = fs.statSync(a.target, { throwIfNoEntry: false })?.isDirectory() ?? false;
    const target: EditorTarget = { path: a.target, line: dir ? null : (a.line ?? null), dir };
    if (editor.id === 'custom' && editor.terminal !== 'none') {
      const plan = planEditorLaunch(editor, target, host());
      if (plan.kind === 'badCommand') throw new MessageError(msg('external.editor.badCommand', { token: '{path}' }));
      if (plan.kind === 'missing') throw withOthers(new EditorMissingError({ editor: 'custom', name: null, lastPath: plan.lastPath }), editor);
      const argv = [plan.file, ...plan.args];
      const title = path.basename(a.target);
      if (editor.terminal === 'shell' && a.sessionId && o.openShellTab?.({ sessionId: a.sessionId, argv, title })) return 'terminal';
      await openArgvInTerminalApp({ home: o.home, argv, title, app: terminalAppFor(s.terminalApp, platform), exec });
      return 'terminal';
    }
    try {
      return await openInEditor({ editor, target, host: host(), exec });
    } catch (e) {
      throw withOthers(e, editor);
    }
  }

  return {
    openTerminal: ({ tmuxName, title }) => {
      const s = o.settings();
      if (!s.tmuxPath) throw new MessageError(msg('run.launch.tmuxMissing', { label: msg('settings.label.tmuxPath') }));
      return openInTerminalApp({ home: o.home, tmuxPath: s.tmuxPath, tmuxName, title, app: terminalAppFor(s.terminalApp, platform), exec });
    },
    openDirTerminal: ({ dir }) => openDirInTerminalApp({ home: o.home, dir, app: terminalAppFor(o.settings().terminalApp, platform), exec }),
    openEditor: async (a) => { await openEditor(a); },
    editors: async (): Promise<EditorsDto> => {
      const h = host();
      const s = o.settings().editor;
      const list = detectEditors(h, s.id === 'custom' ? null : { id: s.id, path: s.path });
      const candidates = await Promise.all(list.map(async (c) => ({ ...c, version: c.state === 'found' && c.path && VERSIONED.has(c.id) ? await version(c.path).catch(() => null) : null })));
      return { candidates, current: currentEditor(s, h) };
    },
    testEditor: async (): Promise<EditorTestDto> => {
      const file = path.join(o.home, EDITOR_TEST_FILE);
      fs.mkdirSync(o.home, { recursive: true });
      const lang = o.language?.() ?? DEFAULT_LANGUAGE;
      fs.writeFileSync(file, `# ${render(lang, msg('external.editor.testTitle'))}\n\n${render(lang, msg('external.editor.testLine'))}\n`);
      try {
        const via = await openEditor({ target: file, line: 3 });
        return { ok: true, via: via as EditorTestDto['via'], file, message: null };
      } catch (e) {
        return { ok: false, via: null, file, message: errorText(o.language?.() ?? DEFAULT_LANGUAGE, e), missing: e instanceof EditorMissingError };
      }
    },
    openUrl: async (url) => {
      const c = openTargetCommand(url, platform);
      // Windows では、起こしたブラウザが rundll32 の出力の管を受け継ぎうるので、子の終わりで返す（open.ts の execUntilExit）。
      const r = await exec(c.file, c.args, platform === 'win32' ? { untilExit: true } : undefined);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `${c.file} exit ${r.code}`);
    },
  };
}
