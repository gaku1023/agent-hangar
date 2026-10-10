import { terminalAppFor } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import type { ExternalApi } from '../http/deps.ts';
import { openTargetCommand } from '../platform/browser.ts';
import { breakawayExec } from './breakaway.ts';
import { execFile, openDirInTerminalApp, openInEditor, openInTerminalApp, type Exec } from './open.ts';
import { MessageError, msg } from '../i18n/message.ts';

/**
 * ターミナルとエディタとブラウザへの受け渡しを、HTTP が触る形に組む。
 * 設定は書き替わるので、呼ばれた時点の settings を読む。
 * 外部ターミナルは、別の OS の値が残っていても、動いている OS で開ける値に読み替えてから渡す。
 *
 * launcher は Windows の殻が渡す、殻の実行ファイルの場所である（HANGAR_LAUNCHER）。
 * 渡されたら、外のアプリは殻を起こし役にして Hangar のジョブの外で起こす（breakaway.ts）。
 * 端末から起こしたサーバはジョブに入っていないので、渡されず、直に起こす。
 */
export function createExternalApi(o: {
  home: string;
  settings: () => Pick<Settings, 'tmuxPath' | 'terminalApp' | 'codePath'>;
  launcher?: string;
  /** 以下は試験が差し替える。 */
  exec?: Exec;
  platform?: NodeJS.Platform;
}): ExternalApi {
  const platform = o.platform ?? process.platform;
  const direct = o.exec ?? execFile;
  const exec = platform === 'win32' && o.launcher ? breakawayExec(direct, o.launcher) : direct;
  return {
    openTerminal: ({ tmuxName }) => {
      const s = o.settings();
      if (!s.tmuxPath) throw new MessageError(msg('run.launch.tmuxMissing', { label: msg('settings.label.tmuxPath') }));
      return openInTerminalApp({ home: o.home, tmuxPath: s.tmuxPath, tmuxName, app: terminalAppFor(s.terminalApp, platform), exec });
    },
    openDirTerminal: ({ dir }) => openDirInTerminalApp({ home: o.home, dir, app: terminalAppFor(o.settings().terminalApp, platform), exec }),
    openEditor: ({ target }) => openInEditor({ codePath: o.settings().codePath, target, exec, platform }),
    openUrl: async (url) => {
      const c = openTargetCommand(url, platform);
      const r = await exec(c.file, c.args);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `${c.file} exit ${r.code}`);
    },
  };
}
