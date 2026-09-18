import type { IndexProgressDto, LiveSessionDto, ProjectDto, RunDto, SessionDto, TabDto } from './api.ts';

export type ServerEvent =
  | { type: 'ready'; version: string }
  | { type: 'project.upsert'; project: ProjectDto }
  | { type: 'project.unresolved'; projectId: string }
  | { type: 'session.upsert'; session: SessionDto }
  | { type: 'live.update'; live: LiveSessionDto[] }
  | { type: 'transcript.appended'; sessionId: string; count: number }
  | { type: 'index.progress'; progress: IndexProgressDto }
  | { type: 'run.started'; run: RunDto; tabs: TabDto[] }
  | { type: 'run.upsert'; run: RunDto }
  | { type: 'run.ended'; run: RunDto }
  | { type: 'tab.upsert'; tab: TabDto }
  | { type: 'toast'; level: 'info' | 'error'; message: string };
