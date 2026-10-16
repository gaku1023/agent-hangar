import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMotionTokens } from '../test/motion.ts';
import type { CloudDeviceDto, SyncStatusBody, UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import { presentCloudMember, type CloudMemberProps } from '../presenters/cloudMember.ts';
import { initialCloudMember, type CloudMemberState } from '../store/cloudMember.ts';
import { initialStore, type Store } from '../store/store.ts';
import { CloudJoinSteps, CloudLeaveBand, CloudPcTable, CloudPhones, CloudRevokedBand } from './CloudMember.tsx';
import { QrCode } from './primitives/QrCode.tsx';
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
    fireEvent.click(screen.getByRole('checkbox', { name: /hangar setup cloud で自分が作成したクラウドです/ }));
    fireEvent.click(go);
    expect(onAction).toHaveBeenCalledWith({ type: 'cloud.join.go', overwrite: false });
  });

  it('別のクラウドに参加済みなら、赤い警告と「上書きして参加」にする', () => {
    const onAction = vi.fn();
    const other = { ...plan, url: 'https://n.example', host: 'n.example', current: { url: 'https://o.example' }, change: 'other-cloud' as const };
    render(ui(<CloudJoinSteps m={props({ join: { kind: 'confirm', plan: other } })} onClose={() => {}} />, onAction));
    expect(screen.getByText('この PC はすでに別のクラウドに参加しています。')).toBeInTheDocument();
    expect(screen.getByText('https://o.example')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '上書きして参加' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'cloud.join.go', overwrite: true });
  });

  it('失敗は理由と、何も書いていないことを出す。秘密が違うときは貼り直し、繋がらないときはもう一度試す', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(<CloudJoinSteps m={props({ join: { kind: 'failed', plan, failure: { code: 'forbidden', message: '' } } })} onClose={() => {}} />, onAction));
    expect(screen.getByRole('alert')).toHaveTextContent('この参加トークンは使えません');
    expect(screen.getByText('この PC の設定は変更していません。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '貼り付け直す' }));
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
    render(ui(<CloudPcTable m={props()} heading="参加している端末" />));
    const table = screen.getByRole('table', { name: '参加している端末' });
    expect(within(table).getByText('Chiba, Chiba, JP')).toBeInTheDocument();
    expect(within(table).getByText('192.0.2.10')).toBeInTheDocument();
    expect(within(table).getByText('Windows')).toBeInTheDocument();
    expect(screen.getByText(/市区は正確でないことがあります/)).toBeInTheDocument();
  });

  it('IPv6 の長い IP でも場所を先に置き、切られるのは IP だけで、IP の全文は title で読める', () => {
    const ip = '2001:db8:1234:5678:9abc:def0:1234:5678';
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('desk', { platform: 'win32', lastIp: ip, lastCity: 'Urayasu', lastRegion: 'Chiba', lastCountry: 'JP' })], creator: false, message: null };
    render(ui(<CloudPcTable m={props({ devices })} heading="参加している端末" />));
    const table = screen.getByRole('table', { name: '参加している端末' });
    const place = within(table).getByText('Urayasu, Chiba, JP');
    const addr = within(table).getByText(ip);
    expect(place.compareDocumentPosition(addr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(addr).toHaveClass('cm-ip');
    expect(place).toHaveClass('cm-place');
    expect(addr.getAttribute('title')).toBe(`最後の IP：${ip}`);
    // IP だけのときも同じ欄に出し、title に全文を入れる。
    cleanup();
    const only = { state: 'ok' as const, devices: [dev('studio', { self: true, lastIp: '198.51.100.7' })], creator: false, message: null };
    render(ui(<CloudPcTable m={props({ devices: only })} heading="参加している端末" />));
    expect(screen.getByText('198.51.100.7').getAttribute('title')).toBe('最後の IP：198.51.100.7');
  });

  it('ほかの PC にだけ「解除…」を置き、確認は行の下に開いて、秘密の説明は折りたたむ', () => {
    const onAction = vi.fn();
    render(ui(<CloudPcTable m={props()} heading="参加している端末" />, onAction));
    expect(screen.queryByRole('button', { name: 'studio を同期から解除' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'desk を同期から解除' }));
    expect(screen.getByText('desk を同期から解除しますか')).toBeInTheDocument();
    expect(screen.getByText('PC を手放したとき、紛失したとき')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '解除' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.device.revoke', id: 'desk' });
  });

  it('解除した PC は「解除した PC」へ移る', () => {
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('old', { revokedAt: Date.parse('2026-10-10T03:00:00Z') })], creator: false, message: null };
    render(ui(<CloudPcTable m={props({ devices })} heading="参加している端末" />));
    const removed = screen.getByRole('table', { name: '解除した PC' });
    expect(within(removed).getByText('old')).toBeInTheDocument();
    expect(within(removed).getByText('10-10 に解除')).toBeInTheDocument();
  });

  it('ブラウザでは解除のボタンを出さず、コマンドを案内する', () => {
    render(ui(<CloudPcTable m={props({}, { desktop: false })} heading="参加している端末" />));
    expect(screen.queryByRole('button', { name: /を同期から解除/ })).toBeNull();
    expect(screen.getByText('hangar cloud revoke <ID>')).toBeInTheDocument();
  });

  it('Worker が古いときは、同期の表の一覧に戻し、解除を出さずに理由を添える', () => {
    const m = props({ devices: { state: 'outdated', devices: [], creator: false, message: 'Worker が古いので使えません' } }, { devices: [{ id: 'studio', name: 'studio', platform: 'darwin', lastSeenAt: NOW, self: true, shell: null }, { id: 'desk', name: 'desk', platform: 'win32', lastSeenAt: NOW, self: false, shell: null }] });
    render(ui(<CloudPcTable m={m} heading="参加している端末" />));
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
  const both = (m: CloudMemberProps) => <><CloudPcTable m={m} heading="参加している端末" /><CloudPhones m={m} /></>;
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
    expect(screen.getByText(/この QR を人に見せたり、写真で送ったりしないでください/)).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: '文字列をコピー' })).toBeNull();
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
    const table = screen.getByRole('table', { name: '参加している端末' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), dev('desk', { platform: 'win32' }), iphone], creator: false, message: null };
    rerender(ui(both(props({ devices, phone: { kind: 'paired', id: 'p1', name: 'iPhone' } }))));
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(screen.getAllByText('iPhone が接続しました').length).toBeGreaterThan(0);
    expect(screen.getByText('この QR はもう使えません')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('iPhone が接続しました。上の一覧に並んでいます。');
  });

  it('「文字列をコピー」で pairText をクリップボードへ写し、「閉じる」で QR を閉じる', () => {
    vi.useFakeTimers({ now: NOW });
    const onAction = vi.fn();
    render(ui(both(props({ phone: ready })), onAction));
    const copy = screen.getByRole('button', { name: '文字列をコピー' });
    expect(copy).toHaveTextContent('文字列をコピー');
    fireEvent.click(copy);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'clipboard.copy', text: PAIR });
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'cloud.phone.close' });
  });

  it('kind=mobile の行に「スマホ」の印が出て、解除のボタンがある。確認に、解除したスマホは戻れない旨と、なくしたらすぐ解除する旨がある', () => {
    const onAction = vi.fn();
    const devices = { state: 'ok' as const, devices: [dev('studio', { self: true }), iphone], creator: false, message: null };
    render(ui(both(props({ devices })), onAction));
    const table = screen.getByRole('table', { name: '参加している端末' });
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

  it('QR に収まらない長さでも倒れず、文字列のコピーへ案内する', () => {
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
  const both = (m: CloudMemberProps) => ui(<><CloudPcTable m={m} heading="参加している端末" /><CloudPhones m={m} /></>);

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

describe('設定のクラウド同期の節', () => {
  const SETTINGS = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
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
    expect(screen.getByRole('table', { name: '参加している端末' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'この PC の参加を解除' })).toBeInTheDocument();
    // 表の下に「スマホ」の小見出しと「スマホを接続」（試作 A1）。
    expect(screen.getByRole('region', { name: 'スマホ' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '参加している端末' });
    const pairBtn = screen.getByRole('button', { name: 'スマホを接続' });
    expect(table.compareDocumentPosition(pairBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('この PC が解除されていれば、節の先頭に帯を出し、参加の解除の帯は出さない', () => {
    render(ui(<SettingsScreen {...page({ desktop: true, sync: { ...SYNC, state: 'error', revoked: true } })} />));
    expect(screen.getByText('この PC は同期から解除されました')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'この PC の参加を解除' })).toBeNull();
  });
});
