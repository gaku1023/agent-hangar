import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMotionTokens } from '../test/motion.ts';
import type { CloudDeviceDto, SyncStatusBody, UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentCloudMember, type CloudMemberProps } from '../presenters/cloudMember.ts';
import { presentToasts } from '../presenters/toasts.ts';
import { initialCloudMember, type CloudMemberState } from '../store/cloudMember.ts';
import { initialStore, type Store } from '../store/store.ts';
import { CloudAddButton, CloudAddPc, CloudJoinSteps, CloudLeaveBand, CloudPcTable, CloudPhones, CloudRevokedBand } from './CloudMember.tsx';
import { QrCode } from './primitives/QrCode.tsx';
import { initialState } from '../mediator/transition.ts';
import { presentSettings } from '../presenters/settings.ts';
import { SettingsScreen } from './SettingsScreen.tsx';

const NOW = Date.parse('2026-10-12T03:00:00Z');
const SYNC: SyncStatusBody = { state: 'idle', paused: false, url: 'https://h.example', lastPushAt: null, lastPullAt: NOW, pending: 0, error: null, deviceCount: 2, limitedUntil: null, skipped: [], sweepPending: null, oncePass: false };
const dev = (id: string, over: Partial<CloudDeviceDto> = {}): CloudDeviceDto => ({ id, name: id, platform: 'darwin', joinedAt: NOW - 20 * 86_400_000, lastSeenAt: NOW - 60_000, revokedAt: null, expiresAt: null, kind: 'pc', self: false, ...over });
const check = { url: 'https://h.example', host: 'h.example', pcCount: 2, current: null };

function props(member: Partial<CloudMemberState> = {}, over: Partial<Store> = {}): CloudMemberProps {
  const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('desk', { platform: 'win32' })], creator: false, message: null };
  return presentCloudMember({ ...initialStore(), sync: SYNC, desktop: true, device: { id: 'studio', name: 'studio' }, cloudMember: { ...initialCloudMember(), devices, ...member }, ...over }, NOW);
}

const ui = (node: React.ReactNode, onAction: (a: UiAction) => void = () => {}) => <ActionRoot onAction={onAction}>{node}</ActionRoot>;

describe('参加コードで参加（試作 B2）', () => {
  it('接続先の URL を入力して「次へ」で接続先を確認する。空なら押せない', () => {
    const onAction = vi.fn();
    render(ui(<CloudJoinSteps m={props()} onClose={() => {}} />, onAction));
    const field = screen.getByLabelText('接続先の URL') as HTMLInputElement;
    const next = screen.getByRole('button', { name: '次へ' });
    expect(next).toBeDisabled();
    fireEvent.change(field, { target: { value: ' https://h.example ' } });
    fireEvent.click(next);
    expect(onAction).toHaveBeenCalledWith({ type: 'cloud.join.check', url: 'https://h.example' });
  });

  it('URL を入れて「次へ」でホスト名と参加済みの PC の台数が出る（PC の名前は出ない）。参加コードの欄が開く', () => {
    const { container } = render(ui(<CloudJoinSteps m={props({ join: { kind: 'code', check } })} onClose={() => {}} />));
    const join = container.querySelector('.cm-join')!;
    expect(within(join as HTMLElement).getByText('h.example')).toBeInTheDocument();
    expect(join).toHaveTextContent('参加済みの PC：2 台');
    expect(join).not.toHaveTextContent('studio');
    expect(join).not.toHaveTextContent('desk');
    expect(screen.getByLabelText('参加コード')).toBeInTheDocument();
  });

  it('形の違うコードはその場で「参加コードの形が違います」と出し、送らない。正しいコードは半角にそろえて送る', () => {
    const onAction = vi.fn();
    render(ui(<CloudJoinSteps m={props({ join: { kind: 'code', check } })} onClose={() => {}} />, onAction));
    const field = screen.getByLabelText('参加コード');
    fireEvent.change(field, { target: { value: 'K7QM-2XF0' } });
    fireEvent.click(screen.getByRole('button', { name: '参加をリクエスト' }));
    expect(screen.getByRole('alert')).toHaveTextContent('参加コードの形が違います');
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cloud.join.request' }));
    fireEvent.change(field, { target: { value: 'ｋ７ｑｍ－２ｘｆｄ' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '参加をリクエスト' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.join.request', code: 'K7QM2XFD' });
  });

  it('別のクラウドに参加済みなら、赤い警告と「上書きして参加をリクエスト」にする', () => {
    render(ui(<CloudJoinSteps m={props({ join: { kind: 'code', check: { ...check, current: { url: 'https://o.example' } } } })} onClose={() => {}} />));
    expect(screen.getByText('この PC はすでに別のクラウドに参加しています。')).toBeInTheDocument();
    expect(screen.getByText('https://o.example')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上書きして参加をリクエスト' })).toBeInTheDocument();
  });

  it('待ちの文は「参加コードを発行した PC で承認してください。」で、確認コードが出る', () => {
    render(ui(<CloudJoinSteps m={props({ join: { kind: 'waiting', check, sas: '123456', expiresAt: NOW + 262_000 } })} onClose={() => {}} />));
    expect(screen.getByText('承認を待っています')).toBeInTheDocument();
    expect(screen.getByText('参加コードを発行した PC で承認してください。')).toBeInTheDocument();
    expect(screen.getByText('123 456')).toBeInTheDocument();
  });

  it('期限切れ、拒否、応答なし（5 分）でそれぞれの文と次の手順を出し、参加コードを入力し直せる', () => {
    const onAction = vi.fn();
    const failed = (reason: 'expired' | 'rejected' | 'no-answer') => ui(<CloudJoinSteps m={props({ join: { kind: 'failed', reason, message: '', check } })} onClose={() => {}} />, onAction);
    const { rerender } = render(failed('expired'));
    expect(screen.getByRole('alert')).toHaveTextContent('参加コードの有効期限が切れました');
    expect(screen.getByRole('alert')).toHaveTextContent('新しい参加コード');
    rerender(failed('rejected'));
    expect(screen.getByRole('alert')).toHaveTextContent('参加リクエストが拒否されました');
    expect(screen.getByRole('alert')).toHaveTextContent('この PC には何も送信されていません');
    rerender(failed('no-answer'));
    expect(screen.getByRole('alert')).toHaveTextContent('応答がありませんでした');
    expect(screen.getByRole('alert')).toHaveTextContent('スリープ中');
    expect(screen.getByRole('alert')).toHaveTextContent('新しい参加コード');
    fireEvent.click(screen.getByRole('button', { name: '参加コードを入力し直す' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.join.reenter' });
  });

  it('承認されたら、再起動して同期を開始する旨を出す', () => {
    render(ui(<CloudJoinSteps m={props({ join: { kind: 'done', host: 'h.example' } })} onClose={() => {}} />));
    expect(screen.getByRole('status')).toHaveTextContent('h.example に参加しました');
  });
});

describe('PC を追加（試作 A1）', () => {
  const open = { kind: 'open' as const, code: 'K7QM-2XFD', expiresAt: NOW + 300_000 };
  const requested = { kind: 'requested' as const, code: 'K7QM-2XFD', expiresAt: NOW + 262_000, request: { name: 'pc-b', os: 'win32', sas: '418207' } };
  /** 設定の節と同じく、ボタンの段と欄を並べる。 */
  const AddPc = (p: { m: CloudMemberProps }) => <><div className="btns"><CloudAddButton m={p.m} /></div><CloudAddPc m={p.m} /></>;
  afterEach(() => { vi.useRealTimers(); });

  it('「PC を追加」で参加コードと URL が欄の中に出る', () => {
    vi.useFakeTimers({ now: NOW });
    const onAction = vi.fn();
    const { rerender } = render(ui(<AddPc m={props()} />, onAction));
    fireEvent.click(screen.getByRole('button', { name: 'PC を追加' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.add.open' });
    rerender(ui(<AddPc m={props({ add: open })} />, onAction));
    const panel = screen.getByRole('region', { name: 'PC を追加' });
    expect(within(panel).getByText('K7QM-2XFD')).toBeInTheDocument();
    expect(within(panel).getByText('https://h.example')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: '参加コードをコピー' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: '接続先の URL をコピー' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('あと 5:00 で有効期限が切れます');
    expect(panel).toHaveTextContent('新しい PC からの参加リクエストを待っています');
    fireEvent.click(within(panel).getByRole('button', { name: 'キャンセル' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.add.close' });
  });

  it('リクエストを受信すると、同じ欄が承認の欄（名前、OS、確認コード、承認、拒否）に切り替わる', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(<AddPc m={props({ add: open })} />, onAction));
    const panel = screen.getByRole('region', { name: 'PC を追加' });
    rerender(ui(<AddPc m={props({ add: requested })} />, onAction));
    expect(screen.getByRole('region', { name: 'PC を追加' })).toBe(panel);
    expect(panel).toHaveTextContent('pc-b から参加リクエストを受信しました');
    expect(panel).toHaveTextContent('Windows');
    expect(panel).toHaveTextContent('418 207');
    expect(panel).toHaveTextContent('新しい PC に表示されている確認コードと同じなら承認してください');
    fireEvent.click(within(panel).getByRole('button', { name: '承認' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.add.approve' });
    fireEvent.click(within(panel).getByRole('button', { name: '拒否' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.add.reject' });
  });

  it('期限切れと失敗は欄の中に理由を出し、参加コードを再発行できる', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(<AddPc m={props({ add: { kind: 'expired' } })} />, onAction));
    expect(screen.getByRole('alert')).toHaveTextContent('参加コードの有効期限が切れました');
    fireEvent.click(screen.getByRole('button', { name: '参加コードを再発行' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.add.open' });
    rerender(ui(<AddPc m={props({ add: { kind: 'failed', message: '承認できませんでした（x）。新しい参加コードを発行して、もう一度試してください' } })} />, onAction));
    expect(screen.getByRole('alert')).toHaveTextContent('新しい参加コードを発行して');
  });

  it('承認で欄が閉じ、完了の帯を出す', () => {
    const { rerender } = render(ui(<AddPc m={props({ add: requested })} />));
    rerender(ui(<AddPc m={props({ add: { kind: 'done', name: 'pc-b' } })} />));
    expect(screen.queryByRole('region', { name: 'PC を追加' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('pc-b が参加しました');
  });

  it('参加リクエストの通知の中身は、確認コードを区切って出す（右下の通知）', () => {
    const p = presentToasts(initialState(), { ...initialStore(), cloudMember: { ...initialCloudMember(), add: requested } }, NOW);
    expect(p.join).toEqual({ name: 'pc-b', os: 'Windows', sas: '418 207' });
    const onSettings = presentToasts({ ...initialState(), screen: { name: 'settings', at: 'cloud' } }, { ...initialStore(), cloudMember: { ...initialCloudMember(), add: requested } }, NOW);
    expect(onSettings.join).toBeNull();
  });
});

describe('PC の表', () => {
  it('列に名前と OS を出し、IP と所在地は出さない', () => {
    render(ui(<CloudPcTable m={props()} heading="参加している PC" />));
    const table = screen.getByRole('table', { name: '参加している PC' });
    expect(within(table).getByText('Windows')).toBeInTheDocument();
    expect(screen.queryByText(/市区は正確でないことがあります/)).toBeNull();
  });

  it('他の PC にだけ「解除…」を置き、確認は行の下に開いて、秘密の説明は折りたたむ', () => {
    const onAction = vi.fn();
    render(ui(<CloudPcTable m={props()} heading="参加している PC" />, onAction));
    expect(screen.queryByRole('button', { name: 'studio を同期から解除' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'desk を同期から解除' }));
    expect(screen.getByText('desk を同期から解除しますか')).toBeInTheDocument();
    expect(screen.getByText('PC を手放したとき、紛失したとき')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.device.revoke', id: 'desk' });
  });

  it('解除した PC は「解除した PC」へ移る', () => {
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('old', { revokedAt: Date.parse('2026-10-10T03:00:00Z') })], creator: false, message: null };
    render(ui(<CloudPcTable m={props({ devices })} heading="参加している PC" />));
    const removed = screen.getByRole('table', { name: '解除した PC' });
    expect(within(removed).getByText('old')).toBeInTheDocument();
    expect(within(removed).getByText('10-10 に解除')).toBeInTheDocument();
  });

  it('ブラウザでは解除のボタンを出さず、コマンドを案内する', () => {
    render(ui(<CloudPcTable m={props({}, { desktop: false })} heading="参加している PC" />));
    expect(screen.queryByRole('button', { name: /を同期から解除/ })).toBeNull();
    expect(screen.getByText('hangar cloud revoke <ID>')).toBeInTheDocument();
  });

  it('Worker が古いときは、同期の表の一覧に戻し、解除を出さずに理由を添える', () => {
    const m = props({ devices: { state: 'outdated', devices: [], creator: false, message: 'Worker が古いので使えません' } }, { devices: [{ id: 'studio', name: 'studio', platform: 'darwin', lastSeenAt: NOW, self: true, shell: null }, { id: 'desk', name: 'desk', platform: 'win32', lastSeenAt: NOW, self: false, shell: null }] });
    render(ui(<CloudPcTable m={m} heading="参加している PC" />));
    expect(screen.queryByRole('button', { name: /を同期から解除/ })).toBeNull();
    expect(screen.getByText('Worker が古いので使えません')).toBeInTheDocument();
  });
});

describe('この PC の参加を解除', () => {
  it('節の末尾の帯から確認を開き、削除するもの・削除しないもの・元に戻すにはを並べる。クラウドでの解除は既定でオン', () => {
    const onAction = vi.fn();
    render(ui(<CloudLeaveBand m={props()} />, onAction));
    fireEvent.click(screen.getByRole('button', { name: '参加を解除…' }));
    expect(screen.getByText('削除するもの')).toBeInTheDocument();
    expect(screen.getByText('削除しないもの')).toBeInTheDocument();
    expect(screen.getByText('元に戻すには')).toBeInTheDocument();
    const also = screen.getByRole('checkbox', { name: /クラウドでもこの PC を解除する/ }) as HTMLInputElement;
    expect(also.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '参加を解除' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.leave', revoke: true });
  });

  it('クラウドを作った PC では、teardown できなくなる旨を先に出す', () => {
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true })], creator: true, message: null };
    render(ui(<CloudLeaveBand m={props({ devices })} />));
    fireEvent.click(screen.getByRole('button', { name: '参加を解除…' }));
    expect(screen.getByText('この PC はクラウドを作成した PC です')).toBeInTheDocument();
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
    expect(screen.getByRole('alert')).toHaveTextContent('この PC は同期から解除されました');
    expect(screen.getByRole('alert')).toHaveTextContent('3 件');
    fireEvent.click(screen.getByRole('button', { name: 'この PC の同期の設定を削除' }));
    expect(screen.queryByRole('checkbox', { name: /クラウドでもこの PC を解除する/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '参加を解除' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.leave', revoke: false });
  });
});

describe('スマホの接続（試作 A1）', () => {
  const PAIR = 'eyJwYWlyIjoidGVzdCJ9';
  const ready = { kind: 'ready' as const, pairUrl: `https://h.example/app/#pair=${PAIR}`, pairText: PAIR, expiresAt: NOW + 300_000, known: [] };
  const iphone = dev('p1', { name: 'iPhone', platform: 'mobile', kind: 'mobile', joinedAt: NOW, lastSeenAt: NOW });
  const both = (m: CloudMemberProps) => <><CloudPcTable m={m} heading="参加している PC" /><CloudPhones m={m} /></>;
  afterEach(() => { vi.useRealTimers(); });

  it('「スマホを接続」を押すと QR を頼み、QR（svg）と残り時間（5 分）と「この QR を人に見せない」旨の注意書きが出る', () => {
    vi.useFakeTimers({ now: NOW });
    const onAction = vi.fn();
    const { rerender } = render(ui(both(props()), onAction));
    expect(screen.getByText(/スマホで受信箱を見て/)).toBeInTheDocument();
    expect(screen.getByText('「Remote Control を付けて起動する」の設定は「連携」にあります。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'スマホを接続' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.phone.pair' });
    rerender(ui(both(props({ phone: ready })), onAction));
    const qr = screen.getByRole('img', { name: 'スマホを接続する QR' });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByText('残り 5:00')).toBeInTheDocument();
    expect(screen.getByText(/この QR と「コードをコピー」でコピーしたコードは同じ内容です。どちらも人に見せたり、写真やメッセージで送ったりしないでください/)).toBeInTheDocument();
    expect(screen.getByText('スマホのカメラで QR を読む')).toBeInTheDocument();
    // QR を出している間は見出しのボタンを隠す（閉じるか期限が切れたら戻る）。
    expect(screen.queryByRole('button', { name: 'スマホを接続' })).toBeNull();
    // QR の中身はリンクにも title にも出さない（QR とコピーのボタンだけ）。
    expect(document.body.innerHTML).not.toContain(PAIR);
  });

  it('5 分たつと QR を薄くして「新しい QR を出す」を出し、押すと新しい QR を頼む', () => {
    vi.useFakeTimers({ now: NOW });
    const onAction = vi.fn();
    render(ui(both(props({ phone: ready })), onAction));
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(screen.getByText('残り 3:00')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(180_000); });
    expect(document.querySelector('.cm-qr')).toHaveAttribute('data-dead', 'true');
    expect(screen.getByText('この QR は期限切れです')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'コードをコピー' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新しい QR を出す' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.phone.pair' });
    // Runtime が expired にした後も同じ姿で、QR の中身を持たない。
    cleanup();
    render(ui(both(props({ phone: { kind: 'expired' } })), onAction));
    expect(document.querySelector('.cm-qr')).toHaveAttribute('data-dead', 'true');
    expect(screen.getByRole('button', { name: '新しい QR を出す' })).toBeInTheDocument();
  });

  it('QR を出している間に cloud-devices に新しい kind=mobile の行が現れたら「〈名前〉が接続しました」を出し、表に行が増える', () => {
    const { rerender } = render(ui(both(props({ phone: ready }))));
    const table = screen.getByRole('table', { name: '参加している PC' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('desk', { platform: 'win32' }), iphone], creator: false, message: null };
    rerender(ui(both(props({ devices, phone: { kind: 'paired', id: 'p1', name: 'iPhone' } }))));
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(screen.getAllByText('iPhone が接続しました').length).toBeGreaterThan(0);
    expect(screen.getByText('この QR はもう使えません')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('iPhone が接続しました。上の一覧に並んでいます。');
  });

  it('「コードをコピー」で pairText をクリップボードへ写し、「閉じる」で QR を閉じる', () => {
    vi.useFakeTimers({ now: NOW });
    const onAction = vi.fn();
    render(ui(both(props({ phone: ready })), onAction));
    const copy = screen.getByRole('button', { name: 'コードをコピー' });
    expect(copy).toHaveTextContent('コードをコピー');
    fireEvent.click(copy);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'clipboard.copy', text: PAIR });
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.phone.close' });
  });

  it('kind=mobile の行に「スマホ」の印が出て、解除のボタンがある。確認に、解除したスマホは戻れない旨と、なくしたらすぐ解除する旨がある', () => {
    const onAction = vi.fn();
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), iphone], creator: false, message: null };
    render(ui(both(props({ devices })), onAction));
    const table = screen.getByRole('table', { name: '参加している PC' });
    const row = within(table).getByText('iPhone').closest('[role="row"]') as HTMLElement;
    expect(within(row).getByText('スマホ')).toHaveClass('cm-chip');
    fireEvent.click(within(row).getByRole('button', { name: 'iPhone を解除' }));
    expect(screen.getByText('iPhone を解除しますか')).toBeInTheDocument();
    expect(screen.getByText(/解除したスマホは受信箱を読めず.*新しい QR を読む必要があります/)).toBeInTheDocument();
    expect(screen.getByText(/選んだ権限モードで全部の PC に会話を起動できます。なくしたときはすぐに解除してください/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.device.revoke', id: 'p1' });
  });

  it('節が外れたら（設定の画面を離れたなど）QR を閉じる。Runtime は close で再読み込みを止め、QR の中身を捨てる', () => {
    vi.useFakeTimers({ now: NOW });
    const onAction = vi.fn();
    const { unmount } = render(ui(both(props({ phone: ready })), onAction));
    expect(onAction).not.toHaveBeenCalledWith({ type: 'cloud.phone.close' });
    unmount();
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.phone.close' });
  });

  it('QR に収まらない長さでも倒れず、コードのコピーへ案内する', () => {
    render(ui(<QrCode text={'x'.repeat(4000)} size={172} label="QR" fallback="QR に収まりませんでした" />));
    expect(screen.queryByRole('img', { name: 'QR' })).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('QR に収まりませんでした');
  });

  it('worker-too-old では QR を出さず、更新を促す文を出す。券の取りすぎと失敗も理由を出す', () => {
    const { rerender } = render(ui(both(props({ phone: { kind: 'old', compat: 6 } }))));
    expect(screen.queryByRole('img', { name: 'スマホを接続する QR' })).toBeNull();
    expect(screen.getByText(/Worker は古いバージョンです（互換の版 6）/)).toBeInTheDocument();
    expect(screen.getByText(/hangar setup cloud/)).toBeInTheDocument();
    rerender(ui(both(props({ phone: { kind: 'limited' } }))));
    expect(screen.getByRole('alert')).toHaveTextContent('10 分ほど待ってから');
    rerender(ui(both(props({ phone: { kind: 'failed', message: '接続できません' } }))));
    expect(screen.getByRole('alert')).toHaveTextContent('QR を作成できませんでした。接続できません');
  });
});

describe('スマホの接続の動き', () => {
  let restore: (() => void) | null = null;
  let animations: { el: Element; frames: Keyframe[] }[] = [];
  let finish: (() => void)[] = [];
  const motion = (dur: string) => {
    restore?.();
    restore = fakeMotionTokens({ '--dur-fast': dur === '0ms' ? '0ms' : '200ms', '--dur': dur, '--dur-exit': dur === '0ms' ? '0ms' : '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' }, { everywhere: true });
  };
  beforeEach(() => {
    motion('420ms');
    animations = []; finish = [];
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
      animations.push({ el: this, frames });
      return { finished: new Promise<void>((r) => finish.push(r)), cancel: vi.fn() };
    };
  });
  afterEach(() => {
    restore?.(); restore = null;
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
  });
  const on = (el: Element | null) => animations.filter((a) => a.el === el);
  const done = async () => { await act(async () => { finish.forEach((f) => f()); await Promise.resolve(); }); };
  const ready = { kind: 'ready' as const, pairUrl: 'https://h.example/app/#pair=X', pairText: 'X', expiresAt: Date.now() + 300_000, known: [] };
  const both = (m: CloudMemberProps) => ui(<><CloudPcTable m={m} heading="参加している PC" /><CloudPhones m={m} /></>);

  it('はじめから QR を出している描画では動かさない', () => {
    render(both(props({ phone: ready })));
    expect(animations).toHaveLength(0);
  });

  it('QR の段は growIn で伸びて開き、閉じると collapseOut で畳んでから外す', async () => {
    const { rerender, container } = render(both(props()));
    rerender(both(props({ phone: ready })));
    const panel = container.querySelector('.cm-pair')!;
    expect(on(panel)[0]!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
    rerender(both(props()));
    expect(container.querySelector('.cm-pair')).toBe(panel);
    expect(on(panel).at(-1)!.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
    await done();
    expect(container.querySelector('.cm-pair')).toBeNull();
  });

  it('期限切れと接続の知らせは fadeIn で現れ、新しいスマホの行は growIn で表に入る', () => {
    const { rerender, container } = render(both(props({ phone: ready })));
    rerender(both(props({ phone: { kind: 'expired' } })));
    const over = container.querySelector('.cm-qr-over')!;
    expect(on(over)[0]!.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    rerender(both(props({ phone: ready })));
    animations = [];
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('p1', { name: 'iPhone', platform: 'mobile', kind: 'mobile' })], creator: false, message: null };
    rerender(both(props({ devices, phone: { kind: 'paired', id: 'p1', name: 'iPhone' } })));
    expect(on(container.querySelector('.cm-qr-over'))[0]!.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    const row = screen.getByText('iPhone', { selector: '.cm-name span' }).closest('[role="rowgroup"]');
    expect(on(row)[0]!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
  });

  it('「新しい QR を出す」の後、新しい券を待つ間も段を畳まず、薄い図のまま待つ', () => {
    const { rerender, container } = render(both(props({ phone: { kind: 'expired' } })));
    const panel = container.querySelector('.cm-pair')!;
    animations = [];
    rerender(both(props({ phone: { kind: 'loading', renew: true } })));
    expect(container.querySelector('.cm-pair')).toBe(panel);
    expect(on(panel)).toHaveLength(0);
    expect(container.querySelector('.cm-qr')).toHaveAttribute('data-dead', 'true');
    expect(container.querySelector('.cm-qr-over')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('QR を作成しています');
    rerender(both(props({ phone: ready })));
    expect(container.querySelector('.cm-pair')).toBe(panel);
    expect(on(panel)).toHaveLength(0);
  });

  it('動きを減らす設定（長さ 0）では、動かさずにすぐ切り替える', () => {
    motion('0ms');
    const { rerender, container } = render(both(props()));
    rerender(both(props({ phone: ready })));
    rerender(both(props({ phone: { kind: 'expired' } })));
    rerender(both(props()));
    expect(container.querySelector('.cm-pair')).toBeNull();
    expect(animations).toHaveLength(0);
  });
});

describe('参加の動き（A1、B2）', () => {
  let restore: (() => void) | null = null;
  let animations: { el: Element; frames: Keyframe[] }[] = [];
  let finish: (() => void)[] = [];
  beforeEach(() => {
    restore = fakeMotionTokens({ '--dur-fast': '200ms', '--dur': '420ms', '--dur-exit': '250ms', '--ease-out': 'ease-out', '--ease-in': 'ease-in', '--rise': '6px', '--blur-in': '6px' }, { everywhere: true });
    animations = []; finish = [];
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
      animations.push({ el: this, frames });
      return { finished: new Promise<void>((r) => finish.push(r)), cancel: vi.fn() };
    };
    // jsdom は高さを測らないので、中身の文字数を高さとみなす（中身を入れ替えると高さが変わる）。
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return (this.textContent ?? '').length; } });
  });
  afterEach(() => {
    restore?.(); restore = null;
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
    delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown }).offsetHeight;
  });
  const on = (el: Element | null) => animations.filter((a) => a.el === el);
  const done = async () => { await act(async () => { finish.forEach((f) => f()); await Promise.resolve(); }); };
  const open = { kind: 'open' as const, code: 'K7QM-2XFD', expiresAt: Date.now() + 300_000 };
  const requested = { kind: 'requested' as const, code: 'K7QM-2XFD', expiresAt: Date.now() + 262_000, request: { name: 'pc-b', os: 'win32', sas: '418207' } };
  const page = (m: CloudMemberProps) => ui(<><CloudAddPc m={m} /><CloudPcTable m={m} heading="参加している PC" /></>);

  it('A1：欄の開きは growIn、承認の欄への切り替えは resizeFrom＋fadeIn、承認で閉じるのは collapseOut。新しい PC の行は growIn で入る', async () => {
    const { rerender, container } = render(page(props()));
    expect(animations).toHaveLength(0);
    rerender(page(props({ add: open })));
    const panel = container.querySelector('.cm-add')!;
    expect(on(panel)[0]!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
    animations = [];
    rerender(page(props({ add: requested })));
    expect(container.querySelector('.cm-add')).toBe(panel);
    expect(on(panel)[0]!.frames).toEqual([{ height: expect.stringMatching(/px$/) }, { height: expect.stringMatching(/px$/) }]);
    expect(on(container.querySelector('.cm-add-body'))[0]!.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    animations = [];
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('desk', { platform: 'win32' }), dev('pc-b', { platform: 'win32' })], creator: false, message: null };
    rerender(page(props({ devices, add: { kind: 'done', name: 'pc-b' } })));
    expect(on(panel).at(-1)!.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
    const row = screen.getByText('pc-b', { selector: '.cm-name span' }).closest('[role="rowgroup"]');
    expect(on(row)[0]!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
    await done();
    expect(container.querySelector('.cm-add')).toBeNull();
  });

  it('B2：参加コードの欄は growIn で開き、承認待ちへの切り替えは resizeFrom', () => {
    const { rerender, container } = render(ui(<CloudJoinSteps m={props()} onClose={() => {}} />));
    rerender(ui(<CloudJoinSteps m={props({ join: { kind: 'code', check } })} onClose={() => {}} />));
    expect(on(container.querySelector('.cm-join-code'))[0]!.frames[0]).toMatchObject({ height: '0px', opacity: 0 });
    const box = container.querySelector('.cm-join')!;
    animations = [];
    rerender(ui(<CloudJoinSteps m={props({ join: { kind: 'waiting', check, sas: '123456', expiresAt: Date.now() + 262_000 } })} onClose={() => {}} />));
    expect(container.querySelector('.cm-join')).toBe(box);
    expect(on(box)[0]!.frames).toEqual([{ height: expect.stringMatching(/px$/) }, { height: expect.stringMatching(/px$/) }]);
  });
});

describe('設定のクラウド同期の節', () => {
  const SETTINGS = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
  const page = (over: Partial<Store>) => presentSettings({ ...initialState(), screen: { name: 'settings', at: 'cloud' } }, { ...initialStore(), settings: SETTINGS, device: { id: 'studio', name: 'studio' }, ...over }, NOW, 'darwin');

  it('殻の中で同期していなければ、参加コードで参加の段を節の中で開く', () => {
    render(ui(<SettingsScreen {...page({ desktop: true, sync: { ...SYNC, state: 'off', url: null } })} />));
    fireEvent.click(screen.getByRole('button', { name: '参加コードで参加' }));
    expect(screen.getByLabelText('接続先の URL')).toBeInTheDocument();
  });

  it('ブラウザで同期していなければ、コマンドを案内する', () => {
    render(ui(<SettingsScreen {...page({ desktop: false, sync: { ...SYNC, state: 'off', url: null } })} />));
    fireEvent.click(screen.getByRole('button', { name: '参加コードで参加' }));
    expect(screen.queryByLabelText('接続先の URL')).toBeNull();
    expect(screen.getByText('hangar cloud join <URL>')).toBeInTheDocument();
  });

  it('同期していれば、今すぐ同期の段に「PC を追加」を置き、参加トークンの表示は出さない', () => {
    const onAction = vi.fn();
    render(ui(<SettingsScreen {...page({ desktop: true, sync: SYNC })} />, onAction));
    expect(screen.queryByRole('button', { name: '参加トークンを表示' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'PC を追加' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.add.open' });
  });

  it('同期していれば、PC の表と、節の末尾の「この PC の参加を解除」を出す', () => {
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('desk')], creator: false, message: null };
    render(ui(<SettingsScreen {...page({ desktop: true, sync: SYNC, cloudMember: { ...initialCloudMember(), devices } })} />));
    expect(screen.getByRole('table', { name: '参加している PC' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'この PC の参加を解除' })).toBeInTheDocument();
    // 表の下に「スマホ」の小見出しと「スマホを接続」（試作 A1）。
    expect(screen.getByRole('region', { name: 'スマホ' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '参加している PC' });
    const pairBtn = screen.getByRole('button', { name: 'スマホを接続' });
    expect(table.compareDocumentPosition(pairBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('この PC が解除されていれば、節の先頭に帯を出し、参加の解除の帯は出さない', () => {
    render(ui(<SettingsScreen {...page({ desktop: true, sync: { ...SYNC, state: 'error', revoked: true } })} />));
    expect(screen.getByText('この PC は同期から解除されました')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'この PC の参加を解除' })).toBeNull();
  });
});
