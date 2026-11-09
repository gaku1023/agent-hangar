// 予定の画面のイベントの節（#563）を撮るための頁。`npm run dev -w @agent-hangar/ui` のあと /preview/schedules.html
// 本番の bundle には入らない。値はすべて作り物である。
// ?case=list（既定。承認待ちと行）|new（作成の入口で GitHub を選んだ形）|hook（webhook を選んだ形）|none（Worker の版が足りない）
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
  bind({ id: 'e2', state: 'held', prompt: 'デプロイ通知を見る', source: { kind: 'hook' }, runs: [run('r4', 'skipped', 'held:hourly')] }),
];
const store = {
  ...initialStore(), sync: { state: 'ok', revoked: false, workerCompat: kind === 'none' ? 11 : 12 } as never,
  projects: { p: { id: 'p', name: 'agent-hangar', status: 'active', isScratch: false, resolved: true, path: '/w/agent-hangar', lastActivityAt: null } } as never,
  schedules: [{ id: 'a', prompt: '依存の脆弱性を調べる', spec: { kind: 'weekly', days: [1], time: '09:00' }, target: { kind: 'new', projectId: 'p' }, projectId: 'p', projectName: 'agent-hangar', accountName: null, sessionTitle: null, enabled: true, nextAt: NOW + 86_400_000, runs: [run('s1', 'finished')] } satisfies ScheduleDto],
  eventTrigger: { ...initialStore().eventTrigger, ready: true, bindings, claims: [{ sessionId: 's', repo: 'acme/app', pr: 571, claimedAt: 1, sessionTitle: 'Windows の移植' }] },
};

createRoot(document.getElementById('root')!).render(
  <LanguageRoot language="ja">
    <ActionRoot onAction={(a) => console.log(JSON.stringify(a))}>
      <SchedulesScreen {...presentSchedules(store, translator('ja'), NOW)} />
    </ActionRoot>
  </LanguageRoot>,
);
