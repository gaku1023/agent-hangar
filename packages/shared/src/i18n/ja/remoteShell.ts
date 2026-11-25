import type { remoteShellKeys } from '../keys/remoteShell.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const remoteShellJa: AreaDictionary<typeof remoteShellKeys> = {
  'remoteShell.tab.title': 'シェル',
  'remoteShell.tab.connecting': '接続しています',
  'remoteShell.reason.noSshd': '{device} が SSH を受け付けていません',
  'remoteShell.reason.unreachable': '{device} に届きません',
  'remoteShell.reason.auth': 'キーが通りません',
  'remoteShell.reason.hostKey': 'ホストキーが同期した指紋と合いません',
  'remoteShell.reason.noMux': 'tmux も psmux も見つかりません',
  'remoteShell.reason.noClient': 'この PC に ssh がありません',
  'remoteShell.reason.outdated': '他の PC の hangar が古く、接続できません',
  'remoteShell.reason.dropped': '接続が切れました',
  'remoteShell.reason.badCwd': '作業ディレクトリに入れません',
  'remoteShell.action.change': '住所を変える',
  'remoteShell.addr.field': '接続先の住所',
  'remoteShell.action.go': '接続',
  'remoteShell.action.retry': 'もう一度',
};
