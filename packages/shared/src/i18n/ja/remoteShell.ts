import type { remoteShellKeys } from '../keys/remoteShell.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const remoteShellJa: AreaDictionary<typeof remoteShellKeys> = {
  'remoteShell.tab.title': 'シェル',
  'remoteShell.tab.connecting': '接続しています',
  'remoteShell.reason.noSshd': '{device} に SSH サーバーがありません',
  'remoteShell.reason.unreachable': '{device} に届きません',
  'remoteShell.reason.auth': 'キーが拒否されました',
  'remoteShell.reason.hostKey': 'ホストキーが保存された指紋と合いません',
  'remoteShell.reason.noMux': '{device} に tmux も psmux も見つかりません',
  'remoteShell.reason.noClient': 'この PC に ssh がありません',
  'remoteShell.reason.outdated': '{device} の hangar が古く、接続できません',
  'remoteShell.reason.dropped': '接続が切れました',
  'remoteShell.reason.badCwd': '作業ディレクトリを開けません',
  'remoteShell.action.change': '接続先を変える',
  'remoteShell.addr.field': '接続先（Host 名または IP）',
  'remoteShell.action.go': '接続',
  'remoteShell.action.retry': 'もう一度',
};
