// 予定の画面のイベントの節（#563）を撮るための頁。
// `npm run dev -w @agent-hangar/ui` のあと /preview/schedules.html
// 本番の bundle には入らない。
// 値はすべて作り物である。
// ?case=list（既定。承認待ちと行）|new（作成の入口で GitHub を選んだ形）|hook（webhook を選んだ形）|steps（最初の結び付けの手順が進む形）|none（Worker の版が足りない）
// ?open=行の指示の一部&click=押すボタンの名前（コンマ区切り）で、行を開いて URL の表示や作り直しの確かめまで進める。
// 例：?open=デプロイ&click=表示,作り直す
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/workbench.css';
import '../src/styles/rows.css';
import '../src/styles/controls.css';
import '../src/styles/schedules.css';
import { createRoot } from 'react-dom/client';
import { translator, type EventBindingDto, type ScheduleDto } from '@agent-hangar/shared';
import { ActionRoot } from '../src/action/chain.tsx';
import { presentSchedules } from '../src/presenters/schedules.ts';
import { initialStore } from '../src/store/store.ts';
import { EventHookApiContext, type EventHookApi } from '../src/views/eventHookApi.ts';
import { LanguageRoot } from '../src/views/primitives/language.tsx';
import { SchedulesScreen } from '../src/views/SchedulesScreen.tsx';

const kind = new URLSearchParams(location.search).get('case') ?? 'list';
const NOW = new Date(2026, 10, 10, 9, 0).getTime();
const run = (id: string, result: 'finished' | 'failed' | 'skipped', error: string | null = null) => ({ id, plannedAt: NOW, startedAt: NOW - 3_600_000, endedAt: NOW - 3_500_000, result, sessionId: null, sessionTitle: null, error });
const bind = (o: Partial<EventBindingDto>): EventBindingDto => ({
  id: 'e', source: { kind: 'github', repo: 'acme/app', when: ['ci_failed'] }, action: { kind: 'new', projectId: 'p' }, prompt: '落ちた CI のログを読み、原因を直す',
  passBody: false, allowAuthors: [], state: 'active', hookUrl: null, createdAt: 1, expiresAt: null, runs: [], ...o,
});
const bindings: EventBindingDto[] = [
  bind({ id: 'd1', state: 'draft', prompt: '新しい issue の再現手順を確かめる', source: { kind: 'github', repo: 'acme/app', when: ['issue_opened'], labels: ['bug'] }, action: { kind: 'new', projectId: 'p', autoApprove: true, permissionMode: 'bypassPermissions' } }),
  bind({ id: 'e1', runs: [run('r1', 'finished'), run('r2', 'failed'), run('r3', 'skipped', 'rejected:signature x3')] }),
  bind({ id: 'd2', state: 'draft', prompt: '失敗した webhook を付け直す', source: { kind: 'github', repo: 'acme/tools', when: ['merged'] } }),
  bind({ id: 'e3', prompt: '権限のない repo の CI を見る', source: { kind: 'github', repo: 'acme/docs', when: ['ci_done'] } }),
  bind({ id: 'e2', state: 'held', prompt: 'デプロイ通知を見る', source: { kind: 'hook' }, runs: [run('r4', 'skipped', 'held:hourly')] }),
];
const store = {
  ...initialStore(), sync: { state: 'ok', revoked: false, workerCompat: kind === 'none' ? 11 : 12 } as never,
  projects: { p: { id: 'p', name: 'agent-hangar', status: 'active', isScratch: false, resolved: true, path: '/w/agent-hangar', lastActivityAt: null } } as never,
  schedules: [{ id: 'a', prompt: '依存の脆弱性を調べる', spec: { kind: 'weekly', days: [1], time: '09:00' }, target: { kind: 'new', projectId: 'p' }, projectId: 'p', projectName: 'agent-hangar', accountName: null, sessionTitle: null, enabled: true, nextAt: NOW + 86_400_000, runs: [run('s1', 'finished')] } satisfies ScheduleDto],
  eventTrigger: { ...initialStore().eventTrigger, ready: true, bindings, claims: [{ sessionId: 's', repo: 'acme/app', pr: 571, claimedAt: 1, sessionTitle: 'Windows の移植' }] },
};

// 作り物の webhook の口。
// repo ごとに札の状態を変え、作り直すたびに別の URL を返す。
let generation = 0;
const hookApi: EventHookApi = {
  hookUrl: async () => `https://hook.example.test/hooks/${['k7Qp2xVd9mZt4Hn8', 'Rr6uY1sEa5Mm3Jc7'][generation % 2]}`,
  rotateUrl: async () => { generation += 1; return null; },
  repoHook: async (repo) => ({ status: repo === 'acme/docs' ? 'no_admin' : repo === 'acme/tools' ? 'failed' : 'registered' }),
};

const root = createRoot(document.getElementById('root')!);
const draw = (busy: boolean, done: number) => {
  const base = store.eventTrigger;
  const s = { ...store, eventTrigger: { ...base, form: { ...base.form, busy, done } } };
  root.render(
    <LanguageRoot language="ja">
      <ActionRoot onAction={(a) => console.log(JSON.stringify(a))}>
        <EventHookApiContext.Provider value={hookApi}>
          <SchedulesScreen {...presentSchedules(s, translator('ja'), NOW)} />
        </EventHookApiContext.Provider>
      </ActionRoot>
    </LanguageRoot>,
  );
};
draw(false, 0);

// 撮るための自動の操作。
// 本番の画面には無い。
const params = new URLSearchParams(location.search);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const press = async (name: string) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === name);
  b?.click();
  await wait(250);
};
const typeInto = (el: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  if (!el) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
void (async () => {
  await wait(400);
  const open = params.get('open');
  if (open) {
    [...document.querySelectorAll<HTMLButtonElement>('.sch-title')].find((x) => x.textContent?.includes(open))?.click();
    await wait(400);
  }
  for (const name of (params.get('click') ?? '').split(',').filter(Boolean)) await press(name);
  if (kind === 'steps') {
    await press('新しい予定');
    await press('GitHub');
    typeInto(document.querySelector('.sch-repo'), 'acme/new-repo');
    await wait(100);
    await press('CI 失敗');
    typeInto(document.querySelector('.sch-prompt'), '落ちた CI を直す');
    await wait(100);
    await press('作成');
    draw(true, 0);
    const stage = params.get('stage');
    await wait(stage === 'webhook' ? 1600 : 200);
    if (stage === 'settled') draw(false, 1);
  }
})();
