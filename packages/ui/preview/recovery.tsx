// 設定のクラウド同期の節の「リカバリーキーを再発行」（試作 cloud-e2e の D2）を、偽の API で動かす頁。primitives.tsx の ?only=recovery から使う。
// 画面と Runtime（runtime/cloudMember.ts）は本物で、サーバーの /api/sync/recovery-key だけを偽物にする。値はすべて作り物である。
// ?fail=502 で確認を Worker の失敗にし、?fail=409 で下書きが無い答えにする。
import { useMemo, useRef, useState } from 'react';
import { formatRecoveryKey, type CloudDevicesDto, type SettingsDto, type SyncStatusBody, type UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../src/action/chain.tsx';
import { cloudMemberStep } from '../src/mediator/cloudMember.ts';
import { initialState } from '../src/mediator/transition.ts';
import { presentSettings } from '../src/presenters/settings.ts';
import { createCloudMemberRunner } from '../src/runtime/cloudMember.ts';
import { initialCloudMember } from '../src/store/cloudMember.ts';
import { initialStore, type Store } from '../src/store/store.ts';
import { LanguageRoot } from '../src/views/primitives/language.tsx';
import { SettingsScreen } from '../src/views/SettingsScreen.tsx';

const params = new URLSearchParams(location.search);
const fail = params.get('fail');
const NOW = Date.now();
const DAY = 86_400_000;
const URL_ = 'https://hangar-sync.example.workers.dev';
/** 作り物の秘密鍵（32 バイト）で作ったリカバリーキー。 */
const PRIV = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TEXT = formatRecoveryKey({ priv: PRIV, url: URL_, createdAt: NOW });

const SETTINGS = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null } as unknown as SettingsDto;
const SYNC: SyncStatusBody = { state: 'idle', paused: false, url: URL_, lastPushAt: NOW - 60_000, lastPullAt: NOW - 30_000, pending: 0, error: null, deviceCount: 2, limitedUntil: null, skipped: [], sweepPending: null, oncePass: false };
const DEVICES: CloudDevicesDto = {
  state: 'ok', creator: true, message: null,
  devices: [
    { id: 'pc-a', name: 'pc-a', platform: 'darwin', joinedAt: NOW - 20 * DAY, lastSeenAt: NOW - 30_000, revokedAt: null, expiresAt: null, kind: 'pc', self: true },
    { id: 'pc-b', name: 'pc-b', platform: 'win32', joinedAt: NOW - 9 * DAY, lastSeenAt: NOW - 3_600_000, revokedAt: null, expiresAt: null, kind: 'pc', self: false },
  ],
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const statusError = (status: number, message: string) => Object.assign(new Error(message), { status });

export function RecoveryPage() {
  const [store, setStore] = useState<Store>(() => ({ ...initialStore(), settings: SETTINGS, desktop: true, device: { id: 'pc-a', name: 'pc-a' }, sync: SYNC, cloudMember: { ...initialCloudMember(), devices: DEVICES } }));
  const ref = useRef(store);
  const runner = useMemo(() => createCloudMemberRunner({
    bridge: null,
    load: async () => DEVICES,
    pair: async () => ({ state: 'not-joined' }),
    joinCodes: { current: async () => ({ kind: 'idle' }), issue: async () => ({ kind: 'idle' }), approve: async () => ({ kind: 'idle' }), reject: async () => ({ kind: 'idle' }), close: async () => ({ kind: 'idle' }) },
    recovery: {
      reissue: async () => { await wait(400); return { text: TEXT, draftId: 'draft-1' }; },
      confirm: async () => {
        await wait(600);
        if (fail === '502') throw statusError(502, 'Worker に接続できません（503）。しばらくしてから、もう一度試してください');
        if (fail === '409') throw statusError(409, '確認できる新しいリカバリーキーがありません。もう一度再発行してください');
      },
    },
    now: () => Date.now(),
    restart: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    get: () => ref.current.cloudMember,
    set: (c) => { ref.current = { ...ref.current, cloudMember: c }; setStore(ref.current); },
  }), []);
  const onAction = (a: UiAction) => {
    if (!a.type.startsWith('cloud.')) return;
    const step = cloudMemberStep(initialState(), { kind: 'action', action: a as Extract<Parameters<typeof cloudMemberStep>[1], { kind: 'action' }>['action'] });
    for (const e of step?.effects ?? []) if (e.kind === 'cloudMember') runner.run(e.command);
  };
  const props = presentSettings({ ...initialState(), screen: { name: 'settings', at: 'cloud' } }, store, Date.now(), 'darwin');
  return (
    <LanguageRoot language="ja">
      <ActionRoot onAction={onAction}>
        <SettingsScreen {...props} />
      </ActionRoot>
    </LanguageRoot>
  );
}
