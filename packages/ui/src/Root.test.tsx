import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, ServerEvent } from '@agent-hangar/shared';
import { Root } from './Root.tsx';
import { createRuntime, type RuntimeDeps } from './runtime/runtime.ts';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c' }, projects: [{ id: 'p1', name: 'alpha', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: Date.now(), runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 }], sessions: [], live: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1' };

function make() {
  let hash = '#/';
  const hashListeners = new Set<() => void>();
  const handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }[] = [];
  const deps: RuntimeDeps = {
    api: { bootstrap: async () => boot, events: async () => ({ sessionId: '', events: [], total: 0, nextSeq: null }), subagents: async () => [], search: async () => ({ hits: [], total: 0 }), setProjectStatus: async () => boot.projects[0]!, resolveProject: async () => ({}), candidates: async () => ['/w/alpha2'], updateSettings: async (p) => ({ ...boot.settings, ...p }), rebuildIndex: async () => {} },
    ws: (h) => { handlers.push(h); return { connect: () => {}, close: () => {} }; },
    location: { getHash: () => hash, setHash: (h) => { hash = h; for (const l of hashListeners) l(); }, onHashChange: (cb) => { hashListeners.add(cb); return () => hashListeners.delete(cb); } },
    storage: { get: () => undefined, set: () => {}, keys: () => [] },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  const rt = createRuntime(deps);
  return { rt, deps, handlers, setHash: deps.location.setHash };
}
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe('Root', () => {
  it('起動から Home、Projects へ遷移、未解決ダイアログ', async () => {
    const { rt, deps, handlers, setHash } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} />);
    expect(screen.getByText('読み込んでいます')).toBeInTheDocument();
    act(() => handlers[0]!.onOpen());
    await flush();
    expect(screen.getByText('プロジェクト')).toBeInTheDocument();
    act(() => setHash('#/projects'));
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    act(() => rt.dispatch({ kind: 'server', event: { type: 'project.unresolved', projectId: 'p1' } }));
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('/w/alpha2')).toBeInTheDocument();
  });
  it('トーストは出て、5 秒で消える', async () => {
    vi.useFakeTimers();
    const { rt, deps } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} />);
    act(() => rt.dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message: 'hello' } }));
    expect(screen.getByText('hello')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5100); });
    expect(screen.queryByText('hello')).toBeNull();
    vi.useRealTimers();
  });
  it('キーボード。/ で検索欄にフォーカスし、⌘K でパレットが開き、Esc で閉じる', async () => {
    const { rt, deps, handlers } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} />);
    act(() => handlers[0]!.onOpen());
    await flush();
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement?.id).toBe('global-search');
    // 入力中の / は横取りしない。
    fireEvent.keyDown(document.getElementById('global-search')!, { key: '/' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByText('コマンドパレット')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('コマンドパレット')).toBeNull();
    // Esc は未解決ダイアログを閉じない。
    act(() => rt.dispatch({ kind: 'server', event: { type: 'project.unresolved', projectId: 'p1' } }));
    await flush();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
