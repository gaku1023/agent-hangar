import { execFile } from 'node:child_process';
import { terminalAppFor } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import type { ExternalApi } from '../http/deps.ts';
import { openDirInTerminalApp, openInEditor, openInTerminalApp } from './open.ts';
import { MessageError, msg } from '../i18n/message.ts';

/**
 * ターミナルとエディタとブラウザへの受け渡しを、HTTP が触る形に組む。
 * 設定は書き替わるので、呼ばれた時点の settings を読む。
 * 外部ターミナルは、別の OS の値が残っていても、動いている OS で開ける値に読み替えてから渡す。
 */
export function createExternalApi(o: { home: string; settings: () => Pick<Settings, 'tmuxPath' | 'terminalApp' | 'codePath'> }): ExternalApi {
  return {
    openTerminal: ({ tmuxName }) => {
      const s = o.settings();
      if (!s.tmuxPath) throw new MessageError(msg('run.launch.tmuxMissing', { label: msg('settings.label.tmuxPath') }));
      return openInTerminalApp({ home: o.home, tmuxPath: s.tmuxPath, tmuxName, app: terminalAppFor(s.terminalApp, process.platform) });
    },
    openDirTerminal: ({ dir }) => openDirInTerminalApp({ home: o.home, dir, app: terminalAppFor(o.settings().terminalApp, process.platform) }),
    openEditor: ({ target }) => openInEditor({ codePath: o.settings().codePath, target }),
    openUrl: (url) => new Promise<void>((resolve, reject) => execFile('open', [url], (err) => (err ? reject(err) : resolve()))),
  };
}
