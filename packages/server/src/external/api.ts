import { execFile } from 'node:child_process';
import type { Settings } from '../config/paths.ts';
import type { ExternalApi } from '../http/deps.ts';
import { openDirInTerminalApp, openInEditor, openInTerminalApp } from './open.ts';
import { MessageError, msg } from '../i18n/message.ts';
import { openTargetCommand } from '../platform/browser.ts';

/**
 * ターミナルとエディタとブラウザへの受け渡しを、HTTP が触る形に組む。
 * 設定は書き替わるので、呼ばれた時点の settings を読む。
 */
export function createExternalApi(o: { home: string; settings: () => Pick<Settings, 'tmuxPath' | 'terminalApp' | 'codePath'> }): ExternalApi {
  return {
    openTerminal: ({ tmuxName }) => {
      const s = o.settings();
      if (!s.tmuxPath) throw new MessageError(msg('run.launch.tmuxMissing', { label: msg('settings.label.tmuxPath') }));
      return openInTerminalApp({ home: o.home, tmuxPath: s.tmuxPath, tmuxName, app: s.terminalApp });
    },
    openDirTerminal: ({ dir }) => openDirInTerminalApp({ home: o.home, dir, app: o.settings().terminalApp }),
    openEditor: ({ target }) => openInEditor({ codePath: o.settings().codePath, target }),
    openUrl: (url) => { const c = openTargetCommand(url); return new Promise<void>((resolve, reject) => execFile(c.file, c.args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()))); },
  };
}
