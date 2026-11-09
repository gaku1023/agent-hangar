// 閉じている間に溜まったイベントの札（#563 の C4 と C6）と、起こした行の光り（E4）を、本物の部品で出す頁（撮るとき用）。
// `npm run dev -w @agent-hangar/ui` のあと /preview/held.html を開く。
// 本番の bundle には入らない。
// 値はすべて作り物である。
// ?case=card（既定。畳んだ札）|choose（「選ぶ」で結び付けごとの群を開いた形）|wake（サイドバーの行が Active に入って光る）|none（イベントを使えない PC。札は出ない）
// ?click=押すボタンの名前（コンマ区切り）で、群の選びまで進める。
// 例：?case=choose&click=すべて（先頭の群が「すべて」）
// wake は ?at=行が入るまでのミリ秒（既定 700）。
// もう一度見るときは頁のボタンか window.__held.wake() を呼ぶ。
// ?motion=off で動きを止めた形（prefers-reduced-motion 相当）。
import { useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/workbench.css';
import '../src/styles/rows.css';
import '../src/styles/controls.css';
import '../src/styles/schedules.css';
import { translator, type HeldEventDto } from '@agent-hangar/shared';
import { ActionRoot } from '../src/action/chain.tsx';
import { initialState } from '../src/mediator/transition.ts';
import { presentHeldEvents } from '../src/presenters/heldEvents.ts';
import type { SessionMenuProps } from '../src/presenters/sessionMenu.ts';
import type { SideLiveGroup, SideLiveProps, SideLiveRow } from '../src/presenters/shell.ts';
import { presentToasts } from '../src/presenters/toasts.ts';
import { initialStore, type Store } from '../src/store/store.ts';
import { Sidebar } from '../src/views/Sidebar.tsx';
import { ToastStack } from '../src/views/ToastStack.tsx';
import { LanguageRoot } from '../src/views/primitives/language.tsx';

const params = new URLSearchParams(location.search);
const kind = params.get('case') ?? 'card';
const t = translator('ja');
if (params.get('motion') === 'off') document.documentElement.style.setProperty('--dur', '0ms');

const fact = (over: Record<string, unknown> = {}) => ({ source: 'github' as const, event: 'ci_done', repo: 'acme/app', number: 571, outcome: 'success' as const, receivedAt: new Date(2026, 10, 10, 8, 40).getTime(), ...over });
const held: HeldEventDto[] = [
  { bindingId: 'b1', facts: [fact(), fact({ outcome: 'failure' }), fact({ event: 'review' }), fact({ event: 'merged', outcome: undefined })] },
  { bindingId: 'b2', facts: [fact({ source: 'hook', event: 'hook', repo: undefined, number: undefined, outcome: undefined }), fact({ source: 'hook', event: 'hook', repo: undefined, number: undefined, outcome: undefined })] },
  { bindingId: 'b3', facts: [fact({ repo: 'acme/docs', number: 12, event: 'comment', outcome: undefined })] },
];
const store: Store = { ...initialStore(), sync: { state: 'ok', revoked: false, workerCompat: kind === 'none' ? 11 : 12 } as never, heldEvents: kind === 'wake' ? [] : held };

const menu = (id: string): SessionMenuProps => ({ id, name: id, status: null, resumeHere: null, stop: { runId: `r-${id}`, working: true, aside: false, shellTabs: 0 }, moveBlocked: null });
const row = (id: string, name: string, over: Partial<SideLiveRow> = {}): SideLiveRow => ({ id, name, live: 'busy', aside: false, reason: null, waited: null, current: false, menu: menu(id), ...over });

let woken = false;
let glow = false;
let rerender: () => void = () => {};
const wake = () => { woken = true; glow = true; rerender(); };
(window as unknown as { __held: unknown }).__held = { wake, reset: () => { woken = false; glow = false; rerender(); } };

function Page() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  rerender = bump;
  const rows = [row('s1', '同期の親子の順序を直す', { current: true }), row('s2', 'README の画像を撮り直す'), ...(woken ? [row('s3', 'イベントの試作', { ...(glow ? { wake: true as const } : {}) })] : [])];
  const group: SideLiveGroup = { key: 'web', name: 'agent-hangar', open: true, waiting: 0, rows };
  const live: SideLiveProps = { count: rows.length, ids: rows.map((r) => r.id), rows, groups: [group], pins: [] };
  // 本番と同じ道を通す。
  // 札の中身は presenter が、store の山とイベントを使えるかから決める。
  const toasts = presentToasts(initialState(), store, Date.now());
  const card = presentHeldEvents(store, t);
  return (
    <LanguageRoot language="ja">
      <ActionRoot onAction={(a) => { console.log(JSON.stringify(a)); if (a.type === 'wakeGlow.seen') glow = false; }}>
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, padding: 20, minHeight: '90vh', alignItems: 'start' }}>
          <div className="shell" data-sidebar="open" style={{ background: 'var(--surface)', borderRadius: 14, boxShadow: 'var(--surface-shadow)', padding: 8, display: 'block', minHeight: 0, height: 'auto' }}>
            <Sidebar nav={[]} foot={[]} collapsed={false} live={live} />
          </div>
          {kind === 'wake' && <div><button type="button" className="btn" data-preview="wake" onClick={wake}>起こす</button></div>}
        </div>
        <ToastStack {...toasts} heldEvents={card} />
      </ActionRoot>
    </LanguageRoot>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);

// 撮るための自動の操作。
// 本番の画面には無い。
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
void (async () => {
  await wait(400);
  for (const name of (params.get('click') ?? (kind === 'choose' ? '選ぶ' : '')).split(',').filter(Boolean)) {
    [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === name)?.click();
    await wait(250);
  }
  if (kind === 'wake') { await wait(Number(params.get('at') ?? 700)); wake(); }
})();
