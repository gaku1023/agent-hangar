import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CloudDeviceDto, SyncStatusBody, UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentCloudMember, type CloudMemberProps } from '../presenters/cloudMember.ts';
import { initialCloudMember, type CloudMemberState } from '../store/cloudMember.ts';
import { initialStore, type Store } from '../store/store.ts';
import { CloudJoinSteps, CloudLeaveBand, CloudPcTable, CloudRevokedBand } from './CloudMember.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentSettings } from '../presenters/settings.ts';
import { SettingsScreen } from './SettingsScreen.tsx';

const NOW = Date.parse('2026-10-12T03:00:00Z');
const SYNC: SyncStatusBody = { state: 'idle', paused: false, url: 'https://h.example', lastPushAt: null, lastPullAt: NOW, pending: 0, error: null, deviceCount: 2, limitedUntil: null, skipped: [], sweepPending: null, oncePass: false };
const dev = (id: string, over: Partial<CloudDeviceDto> = {}): CloudDeviceDto => ({ id, name: id, platform: 'darwin', joinedAt: NOW - 20 * 86_400_000, lastSeenAt: NOW - 60_000, revokedAt: null, lastIp: null, lastCity: null, lastRegion: null, lastCountry: null, self: false, ...over });
const plan = { url: 'https://h.example', host: 'h.example', current: null, change: 'new' as const };

function props(member: Partial<CloudMemberState> = {}, over: Partial<Store> = {}): CloudMemberProps {
  const devices = { state: 'ok' as const, devices: [dev('studio', { self: true, lastIp: '192.0.2.10', lastCity: 'Chiba', lastRegion: 'Chiba', lastCountry: 'JP' }), dev('desk', { platform: 'win32' })], creator: false, message: null };
  return presentCloudMember({ ...initialStore(), sync: SYNC, desktop: true, device: { id: 'studio', name: 'studio' }, cloudMember: { ...initialCloudMember(), devices, ...member }, ...over }, NOW);
}

const ui = (node: React.ReactNode, onAction: (a: UiAction) => void = () => {}) => <ActionRoot onAction={onAction}>{node}</ActionRoot>;

describe('参加の段', () => {
  it('貼った参加トークンを「次へ」で渡し、欄を空にする。欄は password で、空なら押せない', () => {
    const onAction = vi.fn();
    render(ui(<CloudJoinSteps m={props()} onClose={() => {}} />, onAction));
    const field = screen.getByLabelText(/参加トークン/) as HTMLInputElement;
    expect(field.type).toBe('password');
    const next = screen.getByRole('button', { name: '次へ' });
    expect(next).toBeDisabled();
    fireEvent.change(field, { target: { value: '  tok  ' } });
    fireEvent.click(next);
    expect(onAction).toHaveBeenCalledWith({ type: 'cloud.join.plan', token: 'tok' });
    expect(field.value).toBe('');
  });

  it('宛先の確認はホストを大きく出し、チェックを入れるまで参加できない', () => {
    const onAction = vi.fn();
    render(ui(<CloudJoinSteps m={props({ join: { kind: 'confirm', plan } })} onClose={() => {}} />, onAction));
    expect(screen.getByText('h.example')).toBeInTheDocument();
    const go = screen.getByRole('button', { name: 'この宛先に参加' });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /hangar setup cloud で作ったクラウドです/ }));
    fireEvent.click(go);
    expect(onAction).toHaveBeenCalledWith({ type: 'cloud.join.go', overwrite: false });
  });

  it('別のクラウドに参加済みなら、赤い警告と「上書きして参加」にする', () => {
    const onAction = vi.fn();
    const other = { ...plan, url: 'https://n.example', host: 'n.example', current: { url: 'https://o.example' }, change: 'other-cloud' as const };
    render(ui(<CloudJoinSteps m={props({ join: { kind: 'confirm', plan: other } })} onClose={() => {}} />, onAction));
    expect(screen.getByText('この PC は既に別のクラウドに参加しています。')).toBeInTheDocument();
    expect(screen.getByText('https://o.example')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '上書きして参加' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'cloud.join.go', overwrite: true });
  });

  it('失敗は理由と、何も書いていないことを出す。秘密が違うときは貼り直し、繋がらないときはもう一度試す', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(<CloudJoinSteps m={props({ join: { kind: 'failed', plan, failure: { code: 'forbidden', message: '' } } })} onClose={() => {}} />, onAction));
    expect(screen.getByRole('alert')).toHaveTextContent('この参加トークンは使えません');
    expect(screen.getByText('この PC の設定には何も書いていません。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '貼り直す' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.join.cancel' });
    rerender(ui(<CloudJoinSteps m={props({ join: { kind: 'failed', plan, failure: { code: 'network', message: '' } } })} onClose={() => {}} />, onAction));
    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.join.go', overwrite: false });
  });

  it('参加が済んだら、再起動して同期を始める旨を出す', () => {
    render(ui(<CloudJoinSteps m={props({ join: { kind: 'joined', host: 'h.example' } })} onClose={() => {}} />));
    expect(screen.getByRole('status')).toHaveTextContent('h.example に参加しました');
  });
});

describe('PC の表', () => {
  it('列に参加日と最終同期、名前の下に最後の IP と場所を出し、場所が推定である旨を添える', () => {
    render(ui(<CloudPcTable m={props()} heading="PC" />));
    const table = screen.getByRole('table', { name: 'PC' });
    expect(within(table).getByText('Chiba, Chiba, JP')).toBeInTheDocument();
    expect(within(table).getByText('192.0.2.10')).toBeInTheDocument();
    expect(within(table).getByText('Windows')).toBeInTheDocument();
    expect(screen.getByText(/市区はよく外れます/)).toBeInTheDocument();
  });

  it('IPv6 の長い IP でも場所を先に置き、切られるのは IP だけで、IP の全文は title で読める', () => {
    const ip = '2001:db8:1234:5678:9abc:def0:1234:5678';
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('desk', { platform: 'win32', lastIp: ip, lastCity: 'Urayasu', lastRegion: 'Chiba', lastCountry: 'JP' })], creator: false, message: null };
    render(ui(<CloudPcTable m={props({ devices })} heading="PC" />));
    const table = screen.getByRole('table', { name: 'PC' });
    const place = within(table).getByText('Urayasu, Chiba, JP');
    const addr = within(table).getByText(ip);
    expect(place.compareDocumentPosition(addr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(addr).toHaveClass('cm-ip');
    expect(place).toHaveClass('cm-place');
    expect(addr.getAttribute('title')).toBe(`最後の IP：${ip}`);
    // IP だけのときも同じ欄に出し、title に全文を入れる。
    cleanup();
    const only = { state: 'ok' as const, devices: [dev('studio', { self: true, lastIp: '198.51.100.7' })], creator: false, message: null };
    render(ui(<CloudPcTable m={props({ devices: only })} heading="PC" />));
    expect(screen.getByText('198.51.100.7').getAttribute('title')).toBe('最後の IP：198.51.100.7');
  });

  it('ほかの PC にだけ「解除…」を置き、確認は行の下に開いて、秘密の説明は折りたたむ', () => {
    const onAction = vi.fn();
    render(ui(<CloudPcTable m={props()} heading="PC" />, onAction));
    expect(screen.queryByRole('button', { name: 'studio を同期から解除' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'desk を同期から解除' }));
    expect(screen.getByText('desk を同期から解除しますか。')).toBeInTheDocument();
    expect(screen.getByText('手放した PC、なくした PC のとき')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.device.revoke', id: 'desk' });
  });

  it('解除した PC は「解除した PC」へ移る', () => {
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('old', { revokedAt: Date.parse('2026-10-10T03:00:00Z') })], creator: false, message: null };
    render(ui(<CloudPcTable m={props({ devices })} heading="PC" />));
    const removed = screen.getByRole('table', { name: '解除した PC' });
    expect(within(removed).getByText('old')).toBeInTheDocument();
    expect(within(removed).getByText('10-10 に解除')).toBeInTheDocument();
  });

  it('ブラウザでは解除のボタンを出さず、コマンドを案内する', () => {
    render(ui(<CloudPcTable m={props({}, { desktop: false })} heading="PC" />));
    expect(screen.queryByRole('button', { name: /を同期から解除/ })).toBeNull();
    expect(screen.getByText('hangar cloud revoke <ID>')).toBeInTheDocument();
  });

  it('Worker が古いときは、同期の表の一覧に戻し、解除を出さずに理由を添える', () => {
    const m = props({ devices: { state: 'outdated', devices: [], creator: false, message: 'Worker が古いので使えません' } }, { devices: [{ id: 'studio', name: 'studio', platform: 'darwin', lastSeenAt: NOW, self: true, shell: null }, { id: 'desk', name: 'desk', platform: 'win32', lastSeenAt: NOW, self: false, shell: null }] });
    render(ui(<CloudPcTable m={m} heading="PC" />));
    expect(screen.queryByRole('button', { name: /を同期から解除/ })).toBeNull();
    expect(screen.getByText('Worker が古いので使えません')).toBeInTheDocument();
  });
});

describe('この PC の参加を解除', () => {
  it('節の末尾の帯から確認を開き、削除するもの・残るもの・戻すときを並べる。クラウドでの解除は既定でオン', () => {
    const onAction = vi.fn();
    render(ui(<CloudLeaveBand m={props()} />, onAction));
    fireEvent.click(screen.getByRole('button', { name: '参加を解除…' }));
    expect(screen.getByText('削除するもの')).toBeInTheDocument();
    expect(screen.getByText('残るもの')).toBeInTheDocument();
    expect(screen.getByText('戻すとき')).toBeInTheDocument();
    const also = screen.getByRole('checkbox', { name: /クラウドでもこの PC を解除する/ }) as HTMLInputElement;
    expect(also.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '参加を解除' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.leave', revoke: true });
  });

  it('クラウドを作った PC では、teardown できなくなる旨を先に出す', () => {
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true })], creator: true, message: null };
    render(ui(<CloudLeaveBand m={props({ devices })} />));
    fireEvent.click(screen.getByRole('button', { name: '参加を解除…' }));
    expect(screen.getByText('この PC はクラウドを作った PC です。')).toBeInTheDocument();
  });

  it('クラウドで解除できなかったときは理由を出し、再起動は押してもらう', () => {
    const onAction = vi.fn();
    render(ui(<CloudLeaveBand m={props({ leave: { kind: 'left', revokeError: '接続できません' } })} />, onAction));
    expect(screen.getByRole('alert')).toHaveTextContent('接続できません');
    fireEvent.click(screen.getByRole('button', { name: '再起動して同期を停止' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'shell.restart' });
  });

  it('ブラウザではボタンを出さず、コマンドを案内する', () => {
    render(ui(<CloudLeaveBand m={props({}, { desktop: false })} />));
    expect(screen.queryByRole('button', { name: '参加を解除…' })).toBeNull();
    expect(screen.getByText('hangar cloud leave')).toBeInTheDocument();
  });
});

describe('この PC が解除されたとき', () => {
  it('節の先頭に帯を出し、参加し直すか、同期の設定を削除するかを選べる', () => {
    const onAction = vi.fn();
    render(ui(<CloudRevokedBand m={props({}, { sync: { ...SYNC, state: 'error', revoked: true, pending: 3 } })} joinCommand="hangar join <token>" />, onAction));
    expect(screen.getByRole('alert')).toHaveTextContent('この PC は同期から解除されました。');
    expect(screen.getByRole('alert')).toHaveTextContent('3 件');
    fireEvent.click(screen.getByRole('button', { name: 'この PC の同期の設定を削除' }));
    expect(screen.queryByRole('checkbox', { name: /クラウドでもこの PC を解除する/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '参加を解除' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.leave', revoke: false });
  });
});

describe('設定のクラウド同期の節', () => {
  const SETTINGS = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
  const page = (over: Partial<Store>) => presentSettings({ ...initialState(), screen: { name: 'settings', at: 'cloud' } }, { ...initialStore(), settings: SETTINGS, device: { id: 'studio', name: 'studio' }, ...over }, NOW, 'darwin');

  it('殻の中で同期していなければ、参加トークンで参加の段を節の中で開く', () => {
    render(ui(<SettingsScreen {...page({ desktop: true, sync: { ...SYNC, state: 'off', url: null } })} />));
    fireEvent.click(screen.getByRole('button', { name: '参加トークンで参加' }));
    expect(screen.getByLabelText(/参加トークン/)).toHaveAttribute('type', 'password');
  });

  it('ブラウザで同期していなければ、今までどおりコマンドを案内する', () => {
    render(ui(<SettingsScreen {...page({ desktop: false, sync: { ...SYNC, state: 'off', url: null } })} />));
    fireEvent.click(screen.getByRole('button', { name: '参加トークンで参加' }));
    expect(screen.queryByLabelText(/参加トークン/)).toBeNull();
    expect(screen.getByText('hangar join <token>')).toBeInTheDocument();
  });

  it('同期していれば、PC の表と、節の末尾の「この PC の参加を解除」を出す', () => {
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('desk')], creator: false, message: null };
    render(ui(<SettingsScreen {...page({ desktop: true, sync: SYNC, cloudMember: { ...initialCloudMember(), devices } })} />));
    expect(screen.getByRole('table', { name: 'PC' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'この PC の参加を解除' })).toBeInTheDocument();
  });

  it('この PC が解除されていれば、節の先頭に帯を出し、参加の解除の帯は出さない', () => {
    render(ui(<SettingsScreen {...page({ desktop: true, sync: { ...SYNC, state: 'error', revoked: true } })} />));
    expect(screen.getByText('この PC は同期から解除されました。')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'この PC の参加を解除' })).toBeNull();
  });
});
