import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { pick } from '../test/pick.ts';
import type { SessionRowProps } from '../presenters/row.ts';
import { ResolveProjectDialog } from './ResolveProjectDialog.tsx';
import { SessionRows } from './SessionRows.tsx';
import { Header } from './Header.tsx';
import { SessionList } from './SessionList.tsx';
import type { SessionListProps } from '../presenters/sessions.ts';
import { SettingsScreen } from './SettingsScreen.tsx';
import { CloudUsage } from './CloudUsage.tsx';
import { syncFixture } from '../test/syncProps.ts';
import type { CloudUsageProps } from '../presenters/cloudUsage.ts';

const row = (id: string): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null });
// 一覧の部品（SessionList）。ホームとプロジェクトの画面が使う。タブとチップ以外を見る節なので、タブは空にして平らな一覧を描かせる。
const extra: Pick<SessionListProps, 'tabs' | 'tab' | 'tokens' | 'hints' | 'pager' | 'statusColumn' | 'allCount'> = { tabs: [], tab: 'all', tokens: [], hints: [], pager: null, statusColumn: true, allCount: 0 };
const List = (props: Omit<SessionListProps, keyof typeof extra> & Partial<typeof extra>) => <SessionList {...extra} {...props} />;
const openFilters = () => fireEvent.click(screen.getByRole('button', { name: /^絞り込み/ }));

describe('一覧の絞り込みと欄', () => {
  it('絞り込みは search.filter、キーワードは search.query', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><List text="" filter={{}} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" conditions={[]} /></IntentRoot>);
    openFilters();
    pick('プロジェクト', 'alpha');
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: 'p1' } });
    expect(screen.queryByRole('radiogroup', { name: '状態' })).toBeNull();
    const kw = screen.getByLabelText('キーワード');
    fireEvent.change(kw, { target: { value: 'x y' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: 'x y', filter: {} });
  });
  it('絞り込みは、何で絞っているかを帯と札で見せる', () => {
    render(<IntentRoot onIntent={() => {}}><List text="" filter={{ projectId: 'p1', live: 'ended' }} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" conditions={[]} /></IntentRoot>);
    openFilters();
    expect(screen.getByRole('button', { name: 'プロジェクト' })).toHaveTextContent('alpha');
    expect(within(screen.getByRole('radiogroup', { name: '期間' })).getByRole('radio', { name: '全期間' })).toHaveAttribute('aria-checked', 'true');
  });
  it('すべてのプロジェクトに戻すと projectId を外す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><List text="" filter={{ projectId: 'p1' }} projects={[{ id: 'p1', name: 'alpha' }]} rows={[]} total={0} loading={false} mode="all" conditions={[]} /></IntentRoot>);
    openFilters();
    pick('プロジェクト', 'すべてのプロジェクト');
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { projectId: undefined } });
  });
  it('日本語入力の確定の Enter では検索しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><List text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" conditions={[]} /></IntentRoot>);
    const kw = screen.getByLabelText('キーワード');
    fireEvent.change(kw, { target: { value: '動画' } });
    fireEvent.keyDown(kw, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(kw, { key: 'Enter', keyCode: 229 });
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: '動画', filter: {} });
    openFilters();
    const file = screen.getByLabelText('操作したファイル');
    fireEvent.change(file, { target: { value: 'a.md' } });
    onIntent.mockClear();
    fireEvent.keyDown(file, { key: 'Enter', isComposing: true });
    expect(onIntent).not.toHaveBeenCalled();
  });
  // 期間は相対の日数で持つ。絶対の時刻で持つと、時間が経つにつれて表示の日数がずれ、半日ほどで「全期間」に見えていた。
  it('期間は日数で持ち、時間が経っても選んだ帯のまま見える', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><List text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" conditions={[]} /></IntentRoot>);
    openFilters();
    fireEvent.click(screen.getByRole('radio', { name: '7 日' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { days: 7 } });
    rerender(<IntentRoot onIntent={onIntent}><List text="" filter={{ days: 7 }} projects={[]} rows={[]} total={0} loading={false} mode="all" conditions={[]} /></IntentRoot>);
    fireEvent.click(screen.getByRole('radio', { name: '全期間' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.filter', patch: { days: undefined } });
  });
  it('選んだ期間の帯に印が付く', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><List text="" filter={{ days: 1 }} projects={[]} rows={[]} total={0} loading={false} mode="all" conditions={[]} /></IntentRoot>);
    openFilters();
    const period = () => within(screen.getByRole('radiogroup', { name: '期間' }));
    expect(period().getByRole('radio', { name: '今日' })).toHaveAttribute('aria-checked', 'true');
    rerender(<IntentRoot onIntent={() => {}}><List text="" filter={{ days: 30 }} projects={[]} rows={[]} total={0} loading={false} mode="all" conditions={[]} /></IntentRoot>);
    expect(period().getByRole('radio', { name: '30 日' })).toHaveAttribute('aria-checked', 'true');
  });
  it('件数は桁を区切って出す（条件の行）', () => {
    render(<IntentRoot onIntent={() => {}}><List text="q" filter={{}} projects={[]} rows={[row('s1')]} total={1320} loading={false} mode="search" conditions={['『q』']} /></IntentRoot>);
    expect(screen.getByRole('status', { name: '絞り込みの条件' })).toHaveTextContent('1,320 件');
  });
  // 条件の無い一覧は、一覧の下のページ送りの帯（A4）で移る。件数は条件の行が全件を言い、範囲は帯が言う。
  it('ページ送りの帯で移り、件数を変える', () => {
    const onIntent = vi.fn();
    const pager = { page: 2, pageCount: 3, size: 50, sizes: [25, 50, 100, 200], from: 51, to: 100, total: 132 };
    render(<IntentRoot onIntent={onIntent}><List text="" filter={{ days: 7 }} projects={[]} rows={[row('s1'), row('s2')]} total={132} loading={false} mode="all" conditions={['7 日']} pager={pager} /></IntentRoot>);
    expect(screen.getByRole('status', { name: '絞り込みの条件' })).toHaveTextContent('132 件');
    const nav = screen.getByRole('navigation', { name: 'セッションのページ' });
    expect(nav).toHaveTextContent('51–100 / 132 件');
    fireEvent.click(within(nav).getByRole('button', { name: '次のページ' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.page', page: 3 });
    fireEvent.click(within(nav).getByRole('button', { name: '1 ページの件数' }));
    fireEvent.click(screen.getByRole('option', { name: '100 件ずつ' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'list.pageSize', size: 100 });
  });
  it('ページ送りが無ければ帯を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><List text="q" filter={{}} projects={[]} rows={[row('s1')]} total={1} loading={false} mode="search" conditions={['『q』']} /></IntentRoot>);
    expect(screen.queryByRole('navigation', { name: 'セッションのページ' })).toBeNull();
  });
  it('条件が 1 つも効いていなければ条件の行を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><List text="" filter={{}} projects={[]} rows={[row('s1')]} total={1} loading={false} mode="all" conditions={[]} /></IntentRoot>);
    expect(screen.queryByRole('status', { name: '絞り込みの条件' })).toBeNull();
    expect(screen.queryByRole('button', { name: '条件をクリア' })).toBeNull();
  });
  it('条件の行は効いている条件を並べ、「条件をクリア」で全部外す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><List text="索引" filter={{ projectId: 'p1', days: 7 }} projects={[{ id: 'p1', name: 'orbit-notes' }]} rows={[row('s1')]} total={1} loading={false} mode="search" conditions={['『索引』', 'orbit-notes', '7 日']} /></IntentRoot>);
    expect(screen.getByRole('status', { name: '絞り込みの条件' })).toHaveTextContent('『索引』 · orbit-notes · 7 日 で絞り込み中');
    fireEvent.click(screen.getByRole('button', { name: '条件をクリア' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.clear' });
  });
  // 上の欄が全文検索の本体である（D1）。トランスクリプトを探すことを札で言い、打った語は × で消せる。
  it('上の欄はトランスクリプトを探す欄で、語を × で消せる', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><List text="索引" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="search" conditions={['『索引』']} /></IntentRoot>);
    const box = container.querySelector('.sessions-keyword')!;
    expect(box.querySelector('svg')).toHaveAttribute('data-icon', 'fullText');
    expect(box).toHaveTextContent('トランスクリプト');
    fireEvent.click(within(box as HTMLElement).getByRole('button', { name: 'キーワードを消す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'search.query', text: '' });
  });
  it('検索中は条件の行の件数の代わりにそう言う', () => {
    render(<IntentRoot onIntent={() => {}}><List text="q" filter={{}} projects={[]} rows={[]} total={0} loading mode="search" conditions={['『q』']} /></IntentRoot>);
    expect(screen.getByText('検索しています')).toBeInTheDocument();
  });
  it('検索で何も当たらなければ「一致するセッションはありません」', () => {
    render(<IntentRoot onIntent={() => {}}><List text="q" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="search" conditions={[]} /></IntentRoot>);
    expect(screen.getByText('一致するセッションはありません')).toBeInTheDocument();
    expect(screen.queryByText('セッションはまだありません')).toBeNull();
  });
  it('全件表示で空なら「セッションはまだありません」のまま', () => {
    render(<IntentRoot onIntent={() => {}}><List text="" filter={{}} projects={[]} rows={[]} total={0} loading={false} mode="all" conditions={[]} /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
  it('検索中は空の文言を出さない', () => {
    render(<IntentRoot onIntent={() => {}}><List text="q" filter={{}} projects={[]} rows={[]} total={0} loading mode="search" conditions={[]} /></IntentRoot>);
    expect(screen.queryByText('一致するセッションはありません')).toBeNull();
  });
});

describe('Header', () => {
  it('探す・移動の錠剤を押すとパレットを開く', () => {
    const onIntent = vi.fn();
    // sync は Task 23 が Header に足した props である。この節が見るのは錠剤だけなので、出さない形で渡す。
    render(<IntentRoot onIntent={onIntent}><Header account={null} newSession={{}} indexLabel={null} usage={{ fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null }} sync={syncFixture({ visible: false, state: 'off', label: '' })} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: '探す・移動' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.open' });
  });
});

describe('ResolveProjectDialog', () => {
  it('三つの解決と閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ResolveProjectDialog projectId="p1" name="alpha" previousPath="/w/alpha" candidates={['/w/alpha-moved']} onQueryCandidates={() => {}} /></IntentRoot>);
    fireEvent.click(screen.getByText('/w/alpha-moved'));
    fireEvent.click(screen.getByText('この場所にする'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'repoint', path: '/w/alpha-moved' } });
    fireEvent.click(screen.getByText('Archived にする'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'archive' } });
    // 一覧から削除は取り消せないので危険色にし、押しても Mediator が先に確認を出す。
    const remove = screen.getByRole('button', { name: '一覧から削除' });
    expect(remove).toHaveClass('btn-danger');
    fireEvent.click(remove);
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve', id: 'p1', action: { kind: 'unlink' } });
    fireEvent.click(screen.getByText('あとで'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('ResolveProjectDialog のフォーカス', () => {
  it('開いたら中の最初の操作にフォーカスを入れる', () => {
    render(<IntentRoot onIntent={vi.fn()}><ResolveProjectDialog projectId="p1" name="alpha" previousPath="/w/alpha" candidates={[]} onQueryCandidates={() => {}} /></IntentRoot>);
    const dialog = screen.getByRole('dialog', { name: 'alpha のディレクトリが見つかりません' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('新しいパス'));
  });
});


describe('SessionRows（空のとき）', () => {
  it('emptyText を渡すとその文言、渡さなければ既定の文言', () => {
    const { unmount } = render(<IntentRoot onIntent={() => {}}><SessionRows rows={[]} height={100} variant="search" emptyText="何もない" /></IntentRoot>);
    expect(screen.getByText('何もない')).toBeInTheDocument();
    unmount();
    render(<IntentRoot onIntent={() => {}}><SessionRows rows={[]} height={100} variant="search" /></IntentRoot>);
    expect(screen.getByText('セッションはまだありません')).toBeInTheDocument();
  });
});

describe('ResolveProjectDialog のアイコン', () => {
  it('三つの解決はそれぞれのアイコンを持つ', () => {
    render(<IntentRoot onIntent={vi.fn()}><ResolveProjectDialog projectId="p1" name="alpha" previousPath="/w/alpha" candidates={[]} onQueryCandidates={() => {}} /></IntentRoot>);
    const iconOf = (name: string) => screen.getByRole('button', { name }).querySelector('svg')?.getAttribute('data-icon') ?? null;
    expect(iconOf('この場所にする')).toBe('repoint');
    expect(iconOf('Archived にする')).toBe('archive');
    expect(iconOf('一覧から削除')).toBe('unlink');
  });
});

const USAGE: CloudUsageProps = {
  tiles: [
    { key: 'bill', label: '今月の請求', value: '$0.00', sub: '9/30 分まで', tone: 'ok' },
    { key: 'd1', label: 'D1 の書き込み（今日）', value: '86%', sub: '86,120 行', tone: 'warn' },
    { key: 'plan', label: 'プラン', value: 'Workers 無料', sub: 'R2 従量', tone: 'ok' },
  ],
  bars: [
    { label: 'D1 の書き込み', when: '今日', pct: 86.12, value: '86,120 / 100,000 行', tone: 'warn' },
    { label: 'R2 の保存', when: '今月', pct: 1.65, value: '0.17 / 10 GB-月', tone: 'ok' },
    { label: 'R2 Infrequent Access Data Retrieval', when: '今月', pct: null, value: '3 GB', tone: 'ok' },
  ],
  splitAfter: 1, legend: ['あと 13,880 行で無料枠の上限です · 9:00 に戻る'], source: 'Cloudflare の数 · 2 分前', strip: null, command: null,
};

describe('CloudUsage', () => {
  it('札と棒と添え書きを描く', () => {
    render(<CloudUsage {...USAGE} />);
    const sec = screen.getByRole('region', { name: '使用量と費用' });
    expect(within(sec).getByText('$0.00')).toBeTruthy();
    expect(within(sec).getByText('86%').closest('[data-tone]')?.getAttribute('data-tone')).toBe('warn');
    const meters = within(sec).getAllByRole('meter');
    expect(meters).toHaveLength(2);
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('86.12');
    expect(within(sec).getByText('3 GB')).toBeTruthy();
    expect(within(sec).getByText('Cloudflare の数 · 2 分前')).toBeTruthy();
  });
  it('停止の帯は alert、案内のコマンドは等幅で出す', () => {
    render(<CloudUsage {...USAGE} strip={{ tone: 'stop', text: 'Cloudflare の無料枠の上限に達したので、同期を止めています。9:00 に枠が戻ると、自動で再開します。' }} command="npm run hangar -- setup cloud --usage-token" />);
    expect(screen.getByRole('alert').textContent).toContain('同期を止めています');
    expect(screen.getByText('npm run hangar -- setup cloud --usage-token').className).toContain('mono');
  });
  it('凡例が空でも崩れず、出典だけ描く', () => {
    render(<CloudUsage {...USAGE} legend={[]} />);
    expect(screen.getByText('Cloudflare の数 · 2 分前')).toBeTruthy();
  });
});
