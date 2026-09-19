import type { ArtifactDto, DeviceDto, IndexProgressDto, LiveSessionDto, MemoDto, ProjectDto, RunDto, SessionDto, SyncStatusDto, TabDto, TakeoverUpdateDto, TodoDto, UsageDto } from './api.ts';
import type { SharedTable } from './cloud.ts';

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
  | { type: 'usage.update'; usage: UsageDto }
  | { type: 'todos.update'; projectId: string; todos: TodoDto[] }
  | { type: 'memo.update'; memo: MemoDto }
  | { type: 'artifact.upsert'; artifact: ArtifactDto }
  | { type: 'summary.pending'; sessionId: string }
  | { type: 'summary.updated'; sessionId: string }
  | { type: 'summary.failed'; sessionId: string; message: string }
  | { type: 'sync.status'; status: SyncStatusDto }
  | { type: 'sync.applied'; table: SharedTable; rowId: string }
  | { type: 'takeover.update'; update: TakeoverUpdateDto }
  | { type: 'devices.update'; devices: DeviceDto[] }
  | { type: 'toast'; level: 'info' | 'error'; message: string };
