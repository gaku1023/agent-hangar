import type { PaletteCommand, SessionStatus } from '@agent-hangar/shared';
import { overlayReplaceable } from './overlay.ts';
import { canMoveBehind, nextWaitingStep, searchQueryStep } from './screen.ts';
import { sidebarStep } from './sidebar.ts';
import type { Input, State, Step } from './types.ts';
import type { Store } from '../store/store.ts';

/** Paused の入力をそのセッションへ送ったら閉じる。別のセッションへの操作では閉じない。 */
const closePause = (state: State, id: string): State => (state.overlay.kind === 'pause' && state.overlay.sessionId === id ? { ...state, overlay: { kind: 'none' } } : state);
/** 状態の本文。渡されたものだけを載せる（省いた理由で、サーバの今の理由を消さないため）。 */
const stateBody = (i: { status: SessionStatus | null; note?: string; returnOn?: string; returnTime?: string }) => ({ status: i.status, ...(i.note !== undefined ? { note: i.note } : {}), ...(i.returnOn !== undefined ? { returnOn: i.returnOn } : {}), ...(i.returnTime !== undefined ? { returnTime: i.returnTime } : {}) });

/** `cmd:new-session` のような項目 ID を種類と残りに割る。 */
function splitId(id: string): [string, string] {
  const at = id.indexOf(':');
  return at < 0 ? [id, ''] : [id.slice(0, at), id.slice(at + 1)];
}

function paletteRun(state: State, store: Store, command: PaletteCommand): Step {
  // 閉じるのはパレット自身だけ。別のダイアログが開いているときに走っても、それは消さない。
  const closed: State = state.overlay.kind === 'palette' ? { ...state, overlay: { kind: 'none' } } : state;
  const [kind, rest] = splitId(command.id);
  // 画面を移す行は、確認や入力のあるダイアログの裏では移さない（screen.ts の canMoveBehind）。
  const moves = kind === 'project' || kind === 'session' || kind === 'search' || kind === 'go' || (kind === 'cmd' && rest === 'settings');
  if (moves && !canMoveBehind(closed)) return { state: closed, effects: [] };
  if (kind === 'project') return { state: closed, effects: [{ kind: 'navigate', route: { name: 'project', id: rest } }] };
  if (kind === 'session') return { state: closed, effects: [{ kind: 'navigate', route: { name: 'session', id: rest } }] };
  // 全文検索の行。残りが検索語そのもので、語の中のコロンもそのまま残る。
  if (kind === 'search') return searchQueryStep(closed, rest);
  if (kind === 'go' && (rest === 'home' || rest === 'projects' || rest === 'sessions')) return { state: closed, effects: [{ kind: 'navigate', route: { name: rest } }] };
  if (kind === 'cmd') {
    // ダイアログを開く行は、確認や入力のあるダイアログを差し替えない（overlay.ts の overlayReplaceable）。
    const opens = rest.startsWith('new-session') || rest === 'new-scratch' || rest === 'shortcuts' || rest === 'new-project';
    if (opens && !overlayReplaceable(closed.overlay)) return { state: closed, effects: [] };
    // 新しいセッションは、パレットを開いた画面のプロジェクトを最初から選ぶ。
    // Mediator はストアを見ないので、どれを選ぶかは presenter が ID の後ろに載せてくる（new-session:project:<id> か new-session:scratch）。
    if (rest.startsWith('new-session')) {
      const target = rest.slice('new-session'.length);
      const projectId = target.startsWith(':project:') ? target.slice(':project:'.length) : null;
      return { state: { ...closed, overlay: { kind: 'newSession', projectId, scratch: target === ':scratch' }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
    }
    switch (rest) {
      case 'sidebar': return sidebarStep(closed, { kind: 'intent', intent: { type: 'sidebar.toggle' } })!;
      case 'new-scratch': return { state: { ...closed, overlay: { kind: 'newSession', projectId: null, scratch: true }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
      case 'new-project': return { state: { ...closed, overlay: { kind: 'newProject' }, projectCreate: { kind: 'idle' } }, effects: [] };
      case 'settings': return { state: closed, effects: [{ kind: 'navigate', route: { name: 'settings' } }] };
      case 'rebuild-index': return { state: closed, effects: [{ kind: 'api.rebuildIndex' }] };
      case 'shortcuts': return { state: { ...closed, overlay: { kind: 'shortcuts' } }, effects: [] };
      case 'next-waiting': return nextWaitingStep(state, store);
    }
  }
  return { state: closed, effects: [] };
}

/** workbench 領域：TODO、メモ、アーティファクト、事後要約、パレットの実行。状態はほとんど持たない。 */
export function workbenchStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'server') {
    const e = input.event;
    if (e.type === 'summary.failed') return { state: { ...state, summaryFailed: { ...state.summaryFailed, [e.sessionId]: e.message } }, effects: [] };
    if (e.type === 'summary.pending' || e.type === 'summary.updated') {
      if (!state.summaryFailed[e.sessionId]) return { state, effects: [] };
      const { [e.sessionId]: _drop, ...rest } = state.summaryFailed;
      return { state: { ...state, summaryFailed: rest }, effects: [] };
    }
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    // 追加した後も入力欄に居座らせて、続けて書けるようにする。
    case 'todo.add': return i.text.trim() ? { state, effects: [{ kind: 'api.addTodo', projectId: i.projectId, text: i.text.trim() }, { kind: 'focus', target: 'todoInput' }] } : { state, effects: [] };
    case 'session.state.set': return { state: closePause(state, i.id), effects: [{ kind: 'api.setSessionState', id: i.id, body: stateBody(i) }] };
    case 'session.state.confirm': return { state: closePause(state, i.id), effects: [{ kind: 'api.confirmSessionState', id: i.id, body: i.returnOn !== undefined ? { returnOn: i.returnOn, ...(i.returnTime !== undefined ? { returnTime: i.returnTime } : {}) } : {} }] };
    case 'summarizer.test': return { state, effects: [{ kind: 'api.testSummarizer' }] };
    // 幅の変更は SplitPane の IntentBoundary が処理する。ここへ来るのは境界の外で発行されたときだけで、無視してよい。
    case 'split.resize': return { state, effects: [] };
    case 'palette.run': return paletteRun(state, store, i.command);
    default: return null;
  }
}
