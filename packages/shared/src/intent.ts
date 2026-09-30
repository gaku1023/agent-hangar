import type { ProjectStatus, ResolveAction, SettingsDto } from './api.ts';
import type { Route } from './route.ts';

export type ProjectId = string;
export type SessionId = string;
export type RunId = string;
export type TabId = string;
export type TodoId = string;
export type ArtifactId = string;

export type SearchFilter = { projectId?: string; since?: number; until?: number; running?: boolean; file?: string };
export type LaunchParams = { projectId?: string; scratch?: boolean; name?: string; prompt?: string; model?: string; effort?: string; permissionMode?: string; worktree?: string; addDirs?: string[] };
export type PaletteCommand = { id: string; label: string };
export type Settings = SettingsDto;

export type Intent =
  | { type: 'nav.go'; to: Route }
  // 履歴を 1 つ戻る / 進む。ブラウザの戻ると同じもので、2 本指のスワイプもここへ来る。
  | { type: 'nav.back' } | { type: 'nav.forward' }
  | { type: 'shortcuts.open' }
  | { type: 'palette.open' } | { type: 'palette.close' } | { type: 'palette.run'; command: PaletteCommand }
  | { type: 'search.query'; text: string } | { type: 'search.filter'; patch: Partial<SearchFilter> }
  | { type: 'project.open'; id: ProjectId } | { type: 'project.setStatus'; id: ProjectId; status: ProjectStatus }
  | { type: 'project.new.open' } | { type: 'project.new.submit'; name: string; gitInit: boolean; startSession: boolean }
  | { type: 'project.resolve.open'; id: ProjectId } | { type: 'project.resolve'; id: ProjectId; action: ResolveAction }
  | { type: 'project.openEditor'; id: ProjectId } | { type: 'project.openTerminalApp'; id: ProjectId }
  | { type: 'todo.add'; projectId: ProjectId; text: string } | { type: 'todo.toggle'; id: TodoId } | { type: 'todo.remove'; id: TodoId }
  | { type: 'todo.confirm'; id: TodoId } | { type: 'todo.reject'; id: TodoId }
  | { type: 'memo.save'; projectId: ProjectId; markdown: string }
  | { type: 'artifact.open'; id: ArtifactId } | { type: 'artifact.add'; projectId: ProjectId; url: string } | { type: 'artifact.openEditor'; id: ArtifactId }
  | { type: 'session.open'; id: SessionId; focus?: 'terminal' } | { type: 'session.setMemo'; id: SessionId; text: string }
  | { type: 'session.new.open'; projectId?: ProjectId; scratch?: boolean } | { type: 'session.new.submit'; params: LaunchParams }
  | { type: 'session.resume'; id: SessionId } | { type: 'session.fork'; id: SessionId } | { type: 'session.kill'; runId: RunId }
  // attach はバックグラウンドのサービスが持つセッションに hangar からつなぐ。adopt は外のターミナルの claude を引き取る。confirmed が無ければ先に確認を出す。
  | { type: 'session.attach'; id: SessionId } | { type: 'session.adopt'; id: SessionId; confirmed?: boolean }
  | { type: 'session.openTerminalApp'; runId: RunId; tabId?: TabId } | { type: 'session.openEditor'; sessionId: SessionId }
  | { type: 'session.promote.open'; id: SessionId } | { type: 'session.promote.submit'; id: SessionId; name: string; gitInit: boolean; moveFiles: boolean }
  | { type: 'session.takeover'; id: SessionId; force: boolean }
  | { type: 'session.resumeHere'; id: SessionId; overwrite?: boolean }
  | { type: 'session.takeover.cancel'; id: SessionId }
  | { type: 'sync.config.preview' } | { type: 'sync.config.apply' }
  | { type: 'sync.joinToken.show' }
  | { type: 'summary.toggle'; sessionId: SessionId } | { type: 'summary.regenerate'; sessionId: SessionId }
  | { type: 'tab.open'; sessionId: SessionId; kind: 'agent' | 'shell' } | { type: 'tab.close'; tabId: TabId } | { type: 'tab.select'; tabId: TabId }
  | { type: 'split.toggle' } | { type: 'split.resize'; ratio: number } | { type: 'transcript.toggle' }
  | { type: 'sidebar.toggle' }
  | { type: 'summarizer.test' }
  | { type: 'transcript.showThinking'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.showRaw'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.follow'; sessionId: SessionId; follow: boolean }
  | { type: 'transcript.loadMore'; sessionId: SessionId }
  | { type: 'transcript.selectAgent'; sessionId: SessionId; agentId: string | null }
  // ターンの目次。開いたターンの中身を見せ、run が生きていれば左の Claude のタブもその指示へ跳ばす。
  // 跳ぶ先の数え方は目次の並びで決まるので、View が書き出しの切り出しを添えて送る。
  | { type: 'turn.open'; sessionId: SessionId; seq: number; runId: RunId | null; jump: { heads: string[]; index: number; from: 'top' | 'bottom' } | null }
  | { type: 'turn.latest'; sessionId: SessionId; runId: RunId | null }
  | { type: 'index.rebuild' }
  | { type: 'overlay.close' }
  | { type: 'toast.dismiss'; id: string }
  | { type: 'sync.now' } | { type: 'sync.pause'; paused: boolean }
  | { type: 'conn.retry' }
  | { type: 'settings.update'; patch: Partial<Settings> };
