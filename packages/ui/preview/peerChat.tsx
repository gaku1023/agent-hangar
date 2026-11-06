// ほかの PC の会話の画面（PeerChatPane）を、状態ごとに撮るための頁。`npm run dev -w @agent-hangar/ui` のあと /preview/peerChat.html?case=busy などで開く。
// 本番の bundle には入らない。値はすべて作り物である。
// ?case=busy|idle|waiting|answered|stopped|offline|hosterror|loading|queued|question|restore|images|mention|en
// ?play=1 で、作業中から会話が増え、預かりが渡り、札が閉じる様子を動かす（動きの確認用）。
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/session.css';
import '../src/styles/transcript.css';
import '../src/styles/controls.css';
import '../src/styles/peerChat.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { translator, type PeerChatItem, type PeerChatQueued, type SessionDto } from '@agent-hangar/shared';
import { ActionRoot } from '../src/action/chain.tsx';
import { presentPeerChat, type PeerChatView } from '../src/presenters/peerChat.ts';
import { emptySlice, type PeerChatSlice } from '../src/store/peerChat.ts';
import { initialStore } from '../src/store/store.ts';
import { LanguageRoot } from '../src/views/primitives/language.tsx';
import { PromptAssistContext, NO_ASSIST } from '../src/views/primitives/promptAssist.ts';
import { PeerChatPane } from '../src/views/PeerChatPane.tsx';

const params = new URLSearchParams(location.search);
const lang = params.get('case') === 'en' ? 'en' : 'ja';
const t = translator(lang);
const MAC = { deviceId: 'd-mac', deviceName: 'Mac' };
const stats = { turns: 3, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: 0 };
const SESSION = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: '同期の衝突を調べる', cwd: '/w/app', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, lastTurnAt: 1, hasTranscript: true, live: null, summary: null, stats, fromScratch: false, lock: { deviceId: 'd-mac', deviceName: 'Mac', runId: 'r', heartbeatAt: 1, stale: false }, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null } as unknown as SessionDto;

const u = (uuid: string, text: string, from?: typeof MAC): PeerChatItem => ({ uuid, at: 1, kind: 'user', text, ...(from ? { from } : {}) });
const a = (uuid: string, text: string): PeerChatItem => ({ uuid, at: 2, kind: 'assistant', text });
const tool = (uuid: string, name: string, summary: string): PeerChatItem => ({ uuid, at: 3, kind: 'tool', text: name, tool: { name, summary, ok: true } });
const BASE: PeerChatItem[] = [
  u('u1', '同期のログに「親の行が無い」が出てる。原因を調べて'),
  a('a1', 'ログと移行の順を見ます。'),
  tool('t1', 'Grep', '"parent row missing"  packages/server'),
  tool('t2', 'Read', 'sync/apply.ts  (L120-180)'),
];
const MORE: PeerChatItem[] = [
  a('a2', '原因が分かりました。Artifact の行が親の会話より先に届くと、親の行が無いと判断して捨てています。'),
  tool('t3', 'Bash', 'npm test -- sync/apply'),
  a('a3', '届いた順に関係なく、親が来るまで預ける形に直しました。テストは 42 件すべて通っています。'),
];
const permission = (answered?: boolean): PeerChatItem => ({
  uuid: 'k1', at: 4, kind: 'permission', text: 'git push origin fix/sync-parent',
  ask: { askId: 'ask-1', kind: 'permission', tool: 'Bash', input: 'git push origin fix/sync-parent', options: [{ key: '1', label: '許可' }, { key: '2', label: '今後も許可' }, { key: '3', label: '拒否' }], multi: false, allowText: false, ...(answered ? { answered: { by: MAC, label: '許可', at: 9 } } : {}) },
});
const question: PeerChatItem = {
  uuid: 'k2', at: 4, kind: 'question', text: '直し方を 2 つ考えました。どちらにしますか？',
  ask: { askId: 'ask-2', kind: 'question', input: '直し方を 2 つ考えました。どちらにしますか？', options: [{ key: '1', label: '親が来るまで預ける' }, { key: '2', label: '親を先に送る' }], multi: false, allowText: true },
};
const queued = (id: string, text: string, mine = true): PeerChatQueued => ({ queueId: id, from: { deviceId: mine ? 'me' : 'other', deviceName: mine ? 'Win' : 'Phone-PC' }, text, images: 0, at: 5, state: 'waiting' });

function viewOf(slice: Partial<PeerChatSlice>): PeerChatView {
  const st = initialStore();
  st.device = { id: 'me', name: 'Win' };
  st.sessions = { s1: SESSION };
  st.peerChat = { s1: { ...emptySlice('v1'), phase: 'live', device: MAC, status: 'idle', ...slice } };
  return presentPeerChat(st, 's1', t)!;
}

const CASES: Record<string, Partial<PeerChatSlice>> = {
  busy: { status: 'busy', items: BASE },
  idle: { status: 'idle', items: [...BASE, ...MORE] },
  waiting: { status: 'waiting', items: [...BASE, permission()] },
  answered: { status: 'busy', items: [...BASE, permission(true)] },
  question: { status: 'waiting', items: [...BASE, question] },
  stopped: { status: 'stopped', items: [...BASE, ...MORE] },
  offline: { status: 'busy', link: 'offline', items: BASE },
  hosterror: { status: 'busy', link: 'host-error', items: BASE },
  loading: { phase: 'loading', status: null },
  queued: { status: 'busy', items: BASE, queued: [queued('q1', 'ついでに、同じ直しを Codex 側にも入れて'), queued('q2', 'この件は後で見ます', false)] },
  restore: { status: 'idle', items: [...BASE, ...MORE], restore: { n: 1, text: 'ついでに、同じ直しを Codex 側にも入れて', images: [] }, notice: { n: 1, reason: 'gone' } },
  images: { status: 'idle', items: [...BASE, ...MORE] },
  mention: { status: 'idle', items: [...BASE, ...MORE] },
  en: { status: 'busy', items: BASE, queued: [queued('q1', 'Also apply the same fix on the Codex side')] },
};

function Play() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const ids = [900, 1800, 2700, 3600, 4800, 6000].map((ms, i) => setTimeout(() => setN(i + 1), ms));
    return () => ids.forEach(clearTimeout);
  }, []);
  const slice: Partial<PeerChatSlice> =
    n === 0 ? { status: 'busy', items: BASE, queued: [] }
    : n === 1 ? { status: 'busy', items: [...BASE, MORE[0]!], queued: [queued('q1', 'ついでに、同じ直しを Codex 側にも入れて')] }
    : n === 2 ? { status: 'waiting', items: [...BASE, MORE[0]!, permission()], queued: [queued('q1', 'ついでに、同じ直しを Codex 側にも入れて')] }
    : n === 3 ? { status: 'busy', items: [...BASE, MORE[0]!, permission(true), MORE[1]!], queued: [queued('q1', 'ついでに、同じ直しを Codex 側にも入れて')] }
    : n === 4 ? { status: 'idle', items: [...BASE, MORE[0]!, permission(true), MORE[1]!, MORE[2]!], queued: [queued('q1', 'ついでに、同じ直しを Codex 側にも入れて')] }
    : { status: 'busy', items: [...BASE, MORE[0]!, permission(true), MORE[1]!, MORE[2]!, u('u9', 'ついでに、同じ直しを Codex 側にも入れて', MAC)], queued: [] };
  return <PeerChatPane view={viewOf(slice)} />;
}

const name = params.get('case') ?? 'busy';
const assist = {
  ...NO_ASSIST,
  upload: async (f: File) => ({ path: '/h/drops/1-1-' + f.name, name: f.name, size: f.size }),
  peerFiles: async (_s: string, q: string) => ['packages/server/src/sync/apply.ts', 'packages/server/src/sync/apply.test.ts', 'packages/ui/src/views/PeerChatPane.tsx'].filter((f) => f.includes(q)),
};

function Frame() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (name !== 'mention') return;
    // @ の候補を開いた形（欄に @ap を打った状態）にする。
    const timer = setTimeout(() => {
      const el = document.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!el) return;
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      el.focus();
      set.call(el, '見て @ap');
      el.setSelectionRange(5, 5);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setShown(true);
    }, 50);
    return () => clearTimeout(timer);
  }, []);
  void shown;
  return (
    <section id="frame" className="tr-sheet pchat-sheet" style={{ width: 760, height: 520, margin: 24 }}>
      {params.get('play') === '1' ? <Play /> : <PeerChatPane view={viewOf(CASES[name] ?? CASES.busy!)} />}
    </section>
  );
}

createRoot(document.getElementById('root')!).render(
  <LanguageRoot language={lang}>
    <PromptAssistContext.Provider value={assist}>
      <ActionRoot onAction={() => {}}><Frame /></ActionRoot>
    </PromptAssistContext.Provider>
  </LanguageRoot>,
);
