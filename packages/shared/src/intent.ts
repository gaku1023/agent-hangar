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
  | { type: 'palette.open' } | { type: 'palette.close' } | { type: 'palette.run'; command: PaletteCommand }
  | { type: 'search.query'; text: string } | { type: 'search.filter'; patch: Partial<SearchFilter> }
  | { type: 'project.open'; id: ProjectId } | { type: 'project.setStatus'; id: ProjectId; status: ProjectStatus }
  | { type: 'project.new.open' } | { type: 'project.new.submit'; name: string; gitInit: boolean; startSession: boolean }
  | { type: 'project.resolve.open'; id: ProjectId } | { type: 'project.resolve'; id: ProjectId; action: ResolveAction }
  | { type: 'project.openEditor'; id: ProjectId } | { type: 'project.openTerminalApp'; id: ProjectId }
  | { type: 'todo.add'; projectId: ProjectId; text: string } | { type: 'todo.toggle'; id: TodoId } | { type: 'todo.remove'; id: TodoId }
  | { type: 'memo.save'; projectId: ProjectId; markdown: string }
  | { type: 'artifact.open'; id: ArtifactId } | { type: 'artifact.add'; projectId: ProjectId; url: string }
  | { type: 'session.open'; id: SessionId } | { type: 'session.setMemo'; id: SessionId; text: string }
  | { type: 'session.new.open'; projectId?: ProjectId; scratch?: boolean } | { type: 'session.new.submit'; params: LaunchParams }
  | { type: 'session.resume'; id: SessionId } | { type: 'session.fork'; id: SessionId } | { type: 'session.kill'; runId: RunId }
  | { type: 'session.openTerminalApp'; runId: RunId; tabId?: TabId } | { type: 'session.openEditor'; sessionId: SessionId }
  | { type: 'session.promote.open'; id: SessionId } | { type: 'session.promote.submit'; id: SessionId; name: string; moveFiles: boolean }
  | { type: 'session.takeover'; id: SessionId; force: boolean }
  | { type: 'summary.toggle'; sessionId: SessionId } | { type: 'summary.regenerate'; sessionId: SessionId }
  | { type: 'tab.open'; sessionId: SessionId; kind: 'agent' | 'shell' } | { type: 'tab.close'; tabId: TabId } | { type: 'tab.select'; tabId: TabId }
  | { type: 'split.toggle' } | { type: 'transcript.toggle' }
  | { type: 'transcript.showThinking'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.showRaw'; sessionId: SessionId; show: boolean }
  | { type: 'transcript.follow'; sessionId: SessionId; follow: boolean }
  | { type: 'transcript.loadMore'; sessionId: SessionId }
  | { type: 'transcript.selectAgent'; sessionId: SessionId; agentId: string | null }
  | { type: 'index.rebuild' }
  | { type: 'overlay.close' }
  | { type: 'toast.dismiss'; id: string }
  | { type: 'sync.now' } | { type: 'sync.pause'; paused: boolean }
  | { type: 'settings.update'; patch: Partial<Settings> };
