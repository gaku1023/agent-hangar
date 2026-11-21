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

describe('クラウドの Worker が古い PC を選んだとき', () => {
  const stale = mac({ id: 'pc-e', name: 'Shed', state: 'worker-outdated' });
  it('選んだ時点で、断る文と「エージェントで調査…」を出す。起動は押せないまま。選び直すと消える', () => {
    const actions = mount({ peers: [mac(), stale], workerCompat: 9 });
    expect(screen.queryByRole('alert')).toBeNull();
    pick('起動する PC', 'Shed');
    const band = screen.getByRole('alert');
    expect(band).toHaveTextContent('クラウドの Worker が古いため、他の PC にこのリクエストを送信できません（Worker の互換バージョンは 9、必要なのは 10 以上）');
    expect(startButton('Shed で起動')).toBeDisabled();
    fireEvent.click(within(band).getByRole('button', { name: 'エージェントで調査…' }));
    expect(actions).toContainEqual(expect.objectContaining({ type: 'investigate.open', op: 'workerOutdated', worker: { feature: 'launch', need: 10 } }));
    pick('起動する PC', 'Mac');
    expect(screen.queryByText(/Worker が古いため/)).toBeNull();
  });
  it('互換値が分からなければ括弧を省く。ほかの印の PC では出さない', () => {
    mount({ peers: [mac(), stale, old], workerCompat: null });
    pick('起動する PC', 'Shed');
    expect(screen.getByRole('alert').textContent).not.toContain('互換バージョンは');
    pick('起動する PC', 'Garage');
    expect(screen.queryByText(/Worker が古いため/)).toBeNull();
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

describe('この PC に置き場の無いプロジェクト', () => {
  // delta は相手（Mac）にだけ置き場がある。epsilon はどちらにも無い。
  const away: NewSessionProps['away'] = [
    { id: 'p4', name: 'delta', path: null, status: 'active', lastActivity: '5 分前' },
    { id: 'p5', name: 'epsilon', path: null, status: 'active', lastActivity: '' },
  ];
  const macWithDelta = () => mac({ projects: ['p1', 'p2', 'p4'], paths: { p1: '/m/alpha', p2: '/m/beta', p4: '/m/delta' } });
  it('この PC のままなら出さない', () => {
    mount({ peers: [macWithDelta()], away });
    const names = projectOptions().map(([n]) => n);
    expect(names).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
    expect(names).not.toContain('delta');
    expect(names).not.toContain('epsilon');
  });
  it('相手の PC を選ぶと、相手に置き場があるものを名前の順に混ぜて、相手のパスで出す。どちらにも無いものは出さない', () => {
    mount({ peers: [macWithDelta()], away });
    pick('起動する PC', 'Mac');
    expect(projectOptions()).toEqual([['クイックセッション', false], ['alpha', false], ['beta', false], ['delta', false], ['gamma', true]]);
    expect(screen.getByRole('option', { name: 'delta' }).textContent).toContain('/m/delta');
    expect(screen.getByRole('option', { name: 'alpha' }).textContent).toContain('/m/alpha');
  });
  it('最近は、相手の PC を選んだ間は両方の PC のプロジェクトから数える', () => {
    mount({ peers: [macWithDelta()], away, recentIds: ['p1'], recentAnywhere: ['p4', 'p1'] });
    pick('起動する PC', 'Mac');
    fireEvent.click(screen.getByRole('button', { name: /^プロジェクト/ }));
    const recent = screen.getByRole('group', { name: '最近' });
    expect(within(recent).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['delta', 'alpha']);
  });
  it('選んで頼める。選んだまま この PC に戻すと、移さず残して起動を止める', () => {
    const actions = mount({ peers: [macWithDelta()], away, projectId: null });
    pick('起動する PC', 'Mac');
    fireEvent.click(screen.getByRole('button', { name: /^プロジェクト/ }));
    fireEvent.click(screen.getByRole('option', { name: 'delta' }));
    fireEvent.click(startButton('Mac で起動'));
    expect(actions.find((a) => a.type === 'session.new.submitPeer')).toMatchObject({ body: { device: 'pc-b', projectId: 'p4', scratch: false } });
    pick('起動する PC', 'この PC');
    expect(screen.getByRole('button', { name: /^プロジェクト/ }).textContent).toContain('delta');
    expect(startButton(/^起動$/)).toBeDisabled();
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

describe('opencode のモデルは起動先の PC の一覧から（#698）', () => {
  const zen = (id: string, label: string) => ({ id: `opencode/${id}`, label, group: 'OpenCode', provider: 'opencode', tools: true, context: null, cost: { input: 0, output: 0 } });
  const LOCAL = {
    version: '2.1.4', verified: true, modes: [{ id: 'build', description: null }],
    models: [zen('glm-5.3-flash-free', 'GLM-5.3-Flash Free'), { id: 'openrouter/qwen3-coder', label: 'Qwen3 Coder', group: 'OpenRouter', provider: 'openrouter', tools: true, context: null, cost: { input: 0.2, output: 0.8 } }],
    providers: [{ id: 'opencode', name: 'OpenCode', where: 'remote' as const }, { id: 'openrouter', name: 'OpenRouter', where: 'remote' as const }],
    // opencode.json の既定は、この PC に無い LM Studio のモデル。
    defaultModel: 'lmstudio/qwen3.6-35b-a3b', pricesAt: null, fetchedAt: 1, stale: false,
  };
  const PEER_OC = {
    modes: [{ id: 'build', description: null }],
    models: [{ id: 'lmstudio/gemma-4-12b', label: 'Gemma 4 12B', group: 'LM Studio', provider: 'lmstudio', tools: true, context: null, cost: null }, zen('deepseek-v4.1-flash-free', 'DeepSeek V4.1 Flash Free')],
    providers: [{ id: 'lmstudio', name: 'LM Studio', where: 'device' as const }, { id: 'opencode', name: 'OpenCode', where: 'remote' as const }],
    defaultModel: 'lmstudio/qwen3.6-35b-a3b',
  };
  const ocMac = (over: Partial<PeerDeviceDto> = {}) => mac({ agents: ['claude-code', 'opencode'], opencode: PEER_OC, ...over });
  const ocBase = { prefs: { p1: { agent: 'opencode' } } as unknown as NewSessionProps['prefs'], opencode: { options: { dir: '/w/alpha', status: 'ready' as const, data: LOCAL } } };
  const modelChip = () => screen.queryByRole('button', { name: 'モデル' });

  it('この PC の既定が使えなければ、札に Zen の無料のモデルを出し、それで起動する', () => {
    const actions = mount({ ...ocBase });
    expect(modelChip()!.textContent).toContain('GLM-5.3-Flash Free');
    fireEvent.click(startButton(/^起動$/));
    expect(actions.find((a) => a.type === 'session.new.submit')).toMatchObject({ params: { agent: 'opencode', model: 'opencode/glm-5.3-flash-free' } });
  });
  it('別の PC を選ぶと、その PC の一覧から選び、既定が使えなければその PC の Zen の無料のモデルにする', () => {
    const actions = mount({ ...ocBase, peers: [ocMac()] });
    pick('起動する PC', 'Mac');
    expect(modelChip()!.textContent).toContain('DeepSeek V4.1 Flash Free');
    fireEvent.click(modelChip()!);
    const names = screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));
    expect(names).toContain('Gemma 4 12B');
    expect(names).not.toContain('Qwen3 Coder');
    expect(names).not.toContain('デフォルト');
    expect(screen.getByText('Mac のモデル一覧')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Gemma 4 12B' }));
    fireEvent.click(startButton('Mac で起動'));
    expect(actions.find((a) => a.type === 'session.new.submitPeer')).toMatchObject({ body: { device: 'pc-b', agent: 'opencode', model: 'lmstudio/gemma-4-12b' } });
  });
  it('一覧を持たない古い版の PC では、モデルの札を出さず、モデルを指定せずに頼む', () => {
    const actions = mount({ ...ocBase, peers: [ocMac({ opencode: undefined })] });
    pick('起動する PC', 'Mac');
    expect(modelChip()).toBeNull();
    fireEvent.click(startButton('Mac で起動'));
    const sent = actions.find((a) => a.type === 'session.new.submitPeer') as Extract<UiAction, { type: 'session.new.submitPeer' }>;
    expect(sent.body.agent).toBe('opencode');
    expect(sent.body).not.toHaveProperty('model');
    pick('起動する PC', 'この PC');
    expect(modelChip()).not.toBeNull();
  });
});
