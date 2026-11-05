import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PeerDeviceDto, UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { NewSessionDialog } from './NewSessionDialog.tsx';
import { pick } from '../test/pick.ts';

// 新規ダイアログの PC の選択（案 1C）。選んだ PC で使えない項目は、選ぶ前に分かり、末尾に集まって選べない。

const projects: NewSessionProps['projects'] = [
  { id: 'p1', name: 'alpha', path: '/w/alpha', status: 'active', lastActivity: '2 分前' },
  { id: 'p2', name: 'beta', path: '/w/beta', status: 'active', lastActivity: '昨日' },
  { id: 'p3', name: 'gamma', path: '/w/gamma', status: 'active', lastActivity: '昨日' },
];
const base: NewSessionProps = { projects, recentIds: [], projectId: 'p1', submitting: false, error: null, scratch: false, draft: null, prefs: {}, dirs: [], takenNames: [], workspaceRoot: '/w', desktop: false, picked: null, createdProjectId: null, accounts: null };
const mac = (over: Partial<PeerDeviceDto> = {}): PeerDeviceDto => ({ id: 'pc-b', name: 'Mac', platform: 'darwin', state: 'ready', accounts: [{ name: 'Work', agent: 'claude-code', loggedIn: true }], agents: ['claude-code'], projects: ['p1', 'p2'], ...over });
const old = mac({ id: 'pc-c', name: 'Garage', state: 'outdated' });
const away = mac({ id: 'pc-d', name: 'Attic', state: 'offline' });

const mount = (over: Partial<NewSessionProps> = {}) => {
  const actions: UiAction[] = [];
  render(<ActionRoot onAction={(a) => { actions.push(a); }}><NewSessionDialog {...base} {...over} /></ActionRoot>);
  return actions;
};
const startButton = (name: RegExp | string) => screen.getByRole('button', { name });
const projectOptions = () => {
  fireEvent.click(screen.getByRole('button', { name: /^プロジェクト/ }));
  return screen.getAllByRole('option').map((o) => [o.getAttribute('aria-label'), o.getAttribute('aria-disabled') === 'true'] as const);
};

describe('PC のメニュー', () => {
  it('ほかの PC が無ければメニューを出さない', () => {
    mount();
    expect(screen.queryByRole('button', { name: '起動する PC' })).toBeNull();
    expect(startButton(/^起動$/)).toBeEnabled();
  });
  it('見出しの右に出て、「この PC」と、頼めない PC には印（未接続、古いバージョン）を添えて並ぶ', () => {
    mount({ peers: [mac(), old, away] });
    const face = screen.getByRole('button', { name: '起動する PC' });
    expect(face.textContent).toContain('この PC');
    expect(face.closest('.dialog-head, header, .dialog-title-row, [class*="dialog"]')).not.toBeNull();
    fireEvent.click(face);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['この PC', 'Mac', 'Garage古いバージョン', 'Attic未接続']);
  });
});

describe('選んだ PC で使えない項目（テスト 22）', () => {
  it('置き場の無いプロジェクトは末尾に集まり、薄く（disabled）、選んでも変わらない', () => {
    mount({ peers: [mac()] });
    pick('起動する PC', 'Mac');
    expect(projectOptions()).toEqual([['クイックセッション', false], ['alpha', false], ['beta', false], ['gamma', true]]);
    const gamma = screen.getByRole('option', { name: 'gamma' });
    expect(gamma.textContent).toContain('ディレクトリなし');
    fireEvent.click(gamma);
    // 選べないので一覧は閉じず、札の値も変わらない。
    expect(screen.getByRole('option', { name: 'alpha' })).toBeInTheDocument();
  });
  it('選んでいたプロジェクトが相手に無ければ、黙って移さず選んだまま残し（薄く、末尾の印）、起動を止める。この PC に戻すと押せる', () => {
    mount({ peers: [mac({ projects: [] })], projectId: 'p1' });
    pick('起動する PC', 'Mac');
    expect(screen.getByRole('button', { name: /^プロジェクト/ }).textContent).toContain('alpha');
    expect(startButton('Mac で起動')).toBeDisabled();
    expect(projectOptions().find(([n]) => n === 'alpha')).toEqual(['alpha', true]);
    expect(screen.getByRole('option', { name: 'alpha' }).textContent).toContain('ディレクトリなし');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    pick('起動する PC', 'この PC');
    expect(screen.getByRole('button', { name: /^プロジェクト/ }).textContent).toContain('alpha');
    expect(startButton(/^起動$/)).toBeEnabled();
  });
  it('登録していないフォルダを選んだまま PC を替えても、移さず残し、起動を止める', () => {
    mount({ peers: [mac()], dir: '/w/url-short', projectId: null, dirs: [{ name: 'url-short', path: '/w/url-short' }] });
    pick('起動する PC', 'Mac');
    expect(screen.getByRole('button', { name: /^プロジェクト/ }).textContent).toContain('url-short');
    expect(startButton('Mac で起動')).toBeDisabled();
  });
  it('入っていないエージェントも、選んだまま残して起動を止める', () => {
    mount({ peers: [mac()], codex: { options: null }, agent: 'codex' } as never);
    pick('起動する PC', 'Mac');
    expect(startButton('Mac で起動')).toBeDisabled();
  });
  it('別の PC を選んだ間は、添付と @ のファイルの札を出さない。この PC に戻すと出る', () => {
    mount({ peers: [mac()] });
    expect(screen.getByRole('button', { name: /添付/ })).toBeInTheDocument();
    pick('起動する PC', 'Mac');
    expect(screen.queryByRole('button', { name: /添付/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /ファイル/ })).toBeNull();
    pick('起動する PC', 'この PC');
    expect(screen.getByRole('button', { name: /添付/ })).toBeInTheDocument();
  });
  it('新しいフォルダと worktree の札は出さない（別の PC には頼めない）', () => {
    mount({ peers: [mac()], dirs: [{ name: 'url-short', path: '/w/url-short' }], desktop: true });
    expect(screen.getByRole('button', { name: /^worktree/ })).toBeInTheDocument();
    pick('起動する PC', 'Mac');
    expect(screen.queryByRole('button', { name: /^worktree/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^プロジェクト/ }));
    expect(screen.queryByRole('option', { name: /url-short/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /新しいフォルダ/ })).toBeNull();
  });
});

describe('起動', () => {
  it('頼めない PC（古いバージョン、つながらない）を選ぶと、起動のボタンが押せない', () => {
    mount({ peers: [mac(), old, away] });
    pick('起動する PC', 'Garage');
    expect(startButton('Garage で起動')).toBeDisabled();
    pick('起動する PC', 'Attic');
    expect(startButton('Attic で起動')).toBeDisabled();
    pick('起動する PC', 'Mac');
    expect(startButton('Mac で起動')).toBeEnabled();
    pick('起動する PC', 'この PC');
    expect(startButton(/^起動$/)).toBeEnabled();
  });
  it('選んだ PC に起動を頼む（session.new.submitPeer）。この PC の起動（session.new.submit）は送らない', () => {
    const actions = mount({ peers: [mac()] });
    pick('起動する PC', 'Mac');
    fireEvent.change(screen.getByLabelText('初期プロンプト（任意）'), { target: { value: ' 見出しを直して ' } });
    fireEvent.click(startButton('Mac で起動'));
    expect(actions.filter((a) => a.type === 'session.new.submit')).toEqual([]);
    expect(actions.find((a) => a.type === 'session.new.submitPeer')).toEqual({ type: 'session.new.submitPeer', body: { device: 'pc-b', projectId: 'p1', scratch: false, agent: 'claude-code', account: 'Work', prompt: '見出しを直して' } });
  });
  it('クイックセッションは projectId なしの scratch で頼む', () => {
    const actions = mount({ peers: [mac()], projectId: null });
    pick('起動する PC', 'Mac');
    fireEvent.click(startButton('Mac で起動'));
    expect(actions.find((a) => a.type === 'session.new.submitPeer')).toMatchObject({ body: { device: 'pc-b', projectId: null, scratch: true } });
  });
  it('この PC のままなら、今までの起動（session.new.submit）を送る', () => {
    const actions = mount({ peers: [mac()] });
    fireEvent.click(startButton(/^起動$/));
    expect(actions.find((a) => a.type === 'session.new.submit')).toBeDefined();
    expect(actions.find((a) => a.type === 'session.new.submitPeer')).toBeUndefined();
  });
});

describe('アカウント（名前で突き合わせる）', () => {
  const two = { list: [{ id: 'primary', name: 'Main', color: '#2a57b8', current: true, auth: 'ok', loggedIn: true }, { id: 'a2', name: 'Work', color: '#7a4a9e', current: false, auth: 'ok', loggedIn: true }], currentId: 'primary' } as never;
  it('相手に無い名前とログアウト中の名前は末尾に集まり選べない。この PC のいまのアカウントが相手に無ければ、そのまま残して起動を止め、選べる名前を選ぶと押せる', () => {
    const actions = mount({
      accounts: two,
      peers: [mac({ accounts: [{ name: 'Work', agent: 'claude-code', loggedIn: true }, { name: 'Old', agent: 'claude-code', loggedIn: false }] })],
    });
    pick('起動する PC', 'Mac');
    const chip = within(screen.getByRole('group', { name: '起動の設定' })).getByRole('button', { name: /^アカウント/ });
    expect(chip.textContent).toContain('Main');
    expect(startButton('Mac で起動')).toBeDisabled();
    fireEvent.click(chip);
    const rows = screen.getAllByRole('option').map((o) => [o.textContent, o.getAttribute('aria-disabled')]);
    expect(rows).toEqual([['Work', null], ['Mainなし', 'true'], ['Oldログアウト中', 'true']]);
    fireEvent.click(screen.getByRole('option', { name: 'Work' }));
    expect(startButton('Mac で起動')).toBeEnabled();
    fireEvent.click(startButton('Mac で起動'));
    expect(actions.find((a) => a.type === 'session.new.submitPeer')).toMatchObject({ body: { account: 'Work' } });
  });
});
