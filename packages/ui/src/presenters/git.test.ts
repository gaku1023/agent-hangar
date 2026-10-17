import { describe, expect, it } from 'vitest';
import { translator, type GitDto, type GitTreeDto, type SessionChangesDto, type SessionDto, type SessionEditsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { gitFileKey, initialStore } from '../store/store.ts';
import { gitDetailRows, gitUnsafeFix, presentDiffBody, presentDiffDialog, presentGitChip, presentGitFiles, presentProjectGit } from './git.ts';

const ja = translator('ja');
const en = translator('en');

const tree = (p: Partial<GitTreeDto> = {}): GitTreeDto => ({ root: '/w/alpha', branch: 'fix-login', head: 'a1b2c3d', worktree: null, mainRoot: null, dirty: 7, capped: false, slow: false, ahead: null, behind: null, at: 1, ...p });
const session = (id: string, p: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'p1', name: id, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, ...p });
const git = (p: Partial<GitDto> = {}): GitDto => ({ sessions: { s1: { state: 'ok', root: '/w/alpha', branch: 'fix-login', worktree: null } }, trees: { '/w/alpha': tree() }, ...p });

describe('presentGitChip', () => {
  it('ブランチと未コミットの件数。全文は title', () => {
    expect(presentGitChip(ja, git(), 's1', { s1: session('s1', { live: 'busy' }) })).toEqual({ kind: 'ok', worktree: false, name: 'fix-login', title: 'fix-login', value: '未コミット 7', count: 7, dirty: true, shared: null, sharedTitle: null, label: 'ブランチ fix-login、未コミット 7' });
    expect(presentGitChip(en, git(), 's1', { s1: session('s1', { live: 'busy' }) })).toMatchObject({ value: '7 uncommitted', label: 'Branch fix-login, 7 uncommitted' });
  });
  it('終わったセッションには今の未コミットの件数を出さず、そのセッションのときのブランチ（本文の gitBranch）だけを出す', () => {
    const g = git({ sessions: { s1: { state: 'ok', root: '/w/alpha', branch: 'feature/old', worktree: null } }, trees: { '/w/alpha': tree({ branch: 'main', dirty: 2 }) } });
    expect(presentGitChip(ja, g, 's1', { s1: session('s1') })).toEqual({ kind: 'ok', worktree: false, name: 'feature/old', title: 'feature/old', value: '', count: null, dirty: false, shared: null, sharedTitle: null, label: 'ブランチ feature/old' });
    expect(presentGitChip(en, g, 's1', { s1: session('s1') })?.label).toBe('Branch feature/old');
  });
  it('本文に gitBranch が無い（branch が null）なら、終わったセッションには札を出さず、実行中のセッションは今のブランチを出す', () => {
    const g = git({ sessions: { s1: { state: 'ok', root: '/w/alpha', branch: null, worktree: null } }, trees: { '/w/alpha': tree({ branch: 'feature/after', dirty: 3 }) } });
    expect(presentGitChip(ja, g, 's1', { s1: session('s1') })).toBeNull();
    expect(presentGitChip(ja, g, 's1', { s1: session('s1', { live: 'busy' }) })).toMatchObject({ name: 'feature/after', value: '未コミット 3' });
  });
  it('変更なし、件数なし（時間切れ）、1,000+', () => {
    expect(presentGitChip(ja, git({ trees: { '/w/alpha': tree({ dirty: 0 }) } }), 's1', {})).toMatchObject({ value: '変更なし', dirty: false, count: 0 });
    expect(presentGitChip(ja, git({ trees: { '/w/alpha': tree({ dirty: null, slow: true }) } }), 's1', {})).toMatchObject({ value: '件数不明', dirty: false, count: null, title: 'fix-login\ngit が 3 秒以内に応答しなかったため、件数を省略しました' });
    expect(presentGitChip(ja, git({ trees: { '/w/alpha': tree({ dirty: 1000, capped: true }) } }), 's1', {})).toMatchObject({ value: '未コミット 1,000+', dirty: true, count: 1000 });
  });
  it('worktree は worktree の名前、ブランチは title', () => {
    const g = git({ sessions: { s1: { state: 'ok', root: '/w/alpha/.claude/worktrees/pay', branch: 'worktree-pay', worktree: 'pay' } }, trees: { '/w/alpha/.claude/worktrees/pay': tree({ root: '/w/alpha/.claude/worktrees/pay', branch: 'worktree-pay', worktree: 'pay', dirty: 5 }) } });
    expect(presentGitChip(ja, g, 's1', {})).toMatchObject({ worktree: true, name: 'pay', title: 'worktree-pay', value: '未コミット 5' });
  });
  it('同じ作業ツリーで実行中のセッションが 2 本以上なら、実行中の行に「共有 N」を添える', () => {
    const g = git({ sessions: { s1: { state: 'ok', root: '/w/alpha', branch: 'fix-login', worktree: null }, s2: { state: 'ok', root: '/w/alpha', branch: 'fix-login', worktree: null }, s3: { state: 'ok', root: '/w/alpha', branch: 'fix-login', worktree: null } } });
    const sessions = { s1: session('s1', { live: 'busy' }), s2: session('s2', { live: 'idle' }), s3: session('s3') };
    expect(presentGitChip(ja, g, 's1', sessions)).toMatchObject({ shared: 2, sharedTitle: '同じ作業ツリーで実行中のセッションがほかに 1 件あります' });
    // 終わった行には添えない。
    expect(presentGitChip(ja, g, 's3', sessions)?.shared).toBeNull();
  });
  it('他の PC は本文の gitBranch、git でないものと未取得は出さない、消えた worktree は削除済み', () => {
    expect(presentGitChip(ja, git({ sessions: { s1: { state: 'remote', root: null, branch: 'feature-x', worktree: null } } }), 's1', {})).toMatchObject({ kind: 'remote', name: 'feature-x', value: '他の PC', dirty: false });
    expect(presentGitChip(ja, git({ sessions: { s1: { state: 'nogit', root: null, branch: null, worktree: null } } }), 's1', {})).toBeNull();
    expect(presentGitChip(ja, git(), 'nope', {})).toBeNull();
    expect(presentGitChip(ja, git({ sessions: { s1: { state: 'gone', root: null, branch: 'worktree-old', worktree: 'old' } } }), 's1', {})).toMatchObject({ kind: 'gone', worktree: true, name: 'old', value: '削除済み' });
  });
});

const changes = (p: Partial<SessionChangesDto> = {}): SessionChangesDto => ({
  state: 'ok', root: '/w/alpha', tree: tree(),
  files: [
    { path: '/w/alpha/src/a.ts', rel: 'src/a.ts', status: 'M', added: 20, deleted: 2, binary: false },
    { path: '/w/alpha/src/n.ts', rel: 'src/n.ts', status: 'U', added: 34, deleted: 0, binary: false },
    { path: '/w/alpha/src/c.css', rel: 'src/c.css', status: 'C', added: null, deleted: null, binary: false },
  ],
  others: [{ path: '/w/alpha/icon.png', rel: 'icon.png', status: 'M', added: null, deleted: null, binary: true }],
  othersCapped: false, ...p,
});

describe('gitDetailRows', () => {
  it('ブランチ、作業ツリーの未コミット、このセッションの変更', () => {
    const rows = gitDetailRows(ja, git({ trees: { '/w/alpha': tree({ ahead: 2 }) } }), 's1', {}, changes());
    expect(rows.map((r) => [r.name, r.value, r.note ?? null])).toEqual([
      ['ブランチ', 'fix-login', 'origin より 2 コミット先行'],
      ['作業ツリーの未コミット', '7 件', null],
      ['このセッションの変更', '未コミット 2 件', null],
    ]);
    expect(rows[2]!.link).toEqual({ label: '一覧', send: { type: 'diff.open', sessionId: 's1' } });
  });
  it('git でない、他の PC、時間切れ、消えた worktree', () => {
    expect(gitDetailRows(ja, git({ sessions: { s1: { state: 'nogit', root: null, branch: null, worktree: null } } }), 's1', {}, undefined).map((r) => r.value)).toEqual(['git リポジトリではありません']);
    expect(gitDetailRows(ja, git({ sessions: { s1: { state: 'remote', root: null, branch: 'x', worktree: null } } }), 's1', {}, undefined).map((r) => r.value)).toEqual(['x', '他の PC で実行中のため、この PC では取得しません']);
    expect(gitDetailRows(ja, git({ trees: { '/w/alpha': tree({ slow: true, dirty: null }) } }), 's1', {}, undefined).map((r) => r.value)).toEqual(['fix-login', 'git が 3 秒以内に応答しませんでした']);
    expect(gitDetailRows(ja, git({ sessions: { s1: { state: 'gone', root: null, branch: 'worktree-old', worktree: 'old' } } }), 's1', {}, undefined).map((r) => r.value)).toEqual(['old', '削除済み（ブランチ worktree-old は残っている場合があります）']);
    expect(gitDetailRows(ja, git(), 'nope', {}, undefined)).toEqual([]);
  });
  it('持ち主の違いで git が断ったものは、札を出さず、(i) に訳と許すコマンドを出す（git の設定は書かない）', () => {
    const g = git({ sessions: { s1: { state: 'unsafe', root: 'C:/Users/you/work/alpha', branch: 'main', worktree: null } }, trees: {} });
    expect(presentGitChip(ja, g, 's1', {})).toBeNull();
    expect(gitDetailRows(ja, g, 's1', {}, undefined).map((r) => [r.name, r.value])).toEqual([['ブランチ', 'main'], ['git', '所有者が異なるため、git で読み取れません']]);
    expect(gitDetailRows(en, g, 's1', {}, undefined).at(-1)!.value).toBe('Refused: owned by another user');
    expect(gitUnsafeFix(g, 's1', 'win32')).toBe('git config --global --add safe.directory C:/Users/you/work/alpha');
    expect(gitUnsafeFix(git({ sessions: { s1: { state: 'unsafe', root: '/Users/you/my work', branch: null, worktree: null } } }), 's1', 'darwin')).toBe("git config --global --add safe.directory '/Users/you/my work'");
    expect(gitUnsafeFix(git(), 's1', 'darwin')).toBeNull();
    expect(gitUnsafeFix(git(), 'nope', 'darwin')).toBeNull();
  });
});

describe('presentGitFiles', () => {
  it('印、件数、ほかに変わったファイル', () => {
    const v = presentGitFiles(ja, changes());
    expect(v.state).toBe('ok');
    expect(v.files.map((f) => [f.rel, f.mark, f.statusLabel, f.counts])).toEqual([['src/a.ts', 'M', '変更', '+20 −2'], ['src/n.ts', 'A', '追加（未追跡）', '+34 −0'], ['src/c.css', '✓', 'コミット済み', 'コミット済み']]);
    expect(v.othersLabel).toBe('ほかに作業ツリーで変更されたファイル 1 件');
    expect(v.others.map((f) => f.counts)).toEqual(['バイナリ']);
    expect(v.uncommitted).toBe(2);
  });
  it('取得中、git でない、他の PC、時間切れの注記', () => {
    expect(presentGitFiles(ja, undefined).state).toBe('loading');
    expect(presentGitFiles(ja, changes({ state: 'nogit', root: null, tree: null, others: [] })).note).toBe('Bash などのコマンドで変更したファイルは、この一覧に表示されません。');
    expect(presentGitFiles(ja, changes({ state: 'remote', others: [] })).note).toBe('他の PC で実行中です。この PC の作業ツリーは読み取りません。');
    expect(presentGitFiles(ja, changes({ state: 'slow', others: [] })).note).toBe('git が 3 秒以内に応答しませんでした。');
    expect(presentGitFiles(ja, changes({ state: 'unsafe', root: null, tree: null, others: [] })).note).toBe('ディレクトリの所有者が異なるため、git で読み取れません。このセッションの編集だけを表示します。');
    expect(presentGitFiles(ja, changes({ othersCapped: true })).othersLabel).toBe('ほかに作業ツリーで変更されたファイル 1 件以上');
  });
});

describe('presentDiffBody', () => {
  it('git の差は統合形式から行に直し、開く行は最初に足した行', () => {
    const b = presentDiffBody(ja, { source: 'git', file: changes().files[0]!, diff: { file: '/w/alpha/src/a.ts', rel: 'src/a.ts', status: 'M', text: '@@ -1,2 +1,2 @@\n a\n-b\n+B\n', truncated: false, binary: false }, edits: undefined, cwd: '/w/alpha' });
    expect(b.kind).toBe('hunks');
    expect(b.line).toBe(2);
  });
  it('コミット済み、バイナリ、取得中、編集', () => {
    expect(presentDiffBody(ja, { source: 'git', file: changes().files[2]!, diff: undefined, edits: undefined, cwd: '/w' })).toMatchObject({ kind: 'note', text: 'このファイルへの変更はコミット済みです。作業ツリーとの差分はありません。' });
    expect(presentDiffBody(ja, { source: 'git', file: changes().files[0]!, diff: { file: '/w/alpha/src/a.ts', rel: 'src/a.ts', status: 'M', text: '', truncated: false, binary: true }, edits: undefined, cwd: '/w' })).toMatchObject({ kind: 'note', text: 'バイナリファイルのため、差分を表示しません。' });
    expect(presentDiffBody(ja, { source: 'git', file: changes().files[0]!, diff: undefined, edits: undefined, cwd: '/w' }).kind).toBe('loading');
    const edits: SessionEditsDto = { file: '/w/alpha/src/a.ts', truncated: false, edits: [
      { seq: 3, ts: Date.UTC(2026, 9, 1, 1, 2), agentId: null, call: { toolId: 't1', name: 'Edit', input: { file_path: '/w/alpha/src/a.ts', old_string: 'b', new_string: 'B' }, summary: '' }, result: { text: 'ok', isError: false } },
      { seq: 5, ts: null, agentId: null, call: { toolId: 't2', name: 'Write', input: { file_path: '/w/alpha/src/a.ts', content: 'x\ny\n' }, summary: '' }, result: null },
    ] };
    const e = presentDiffBody(ja, { source: 'session', file: changes().files[0]!, diff: undefined, edits, cwd: '/w/alpha' });
    expect(e.kind).toBe('edits');
    if (e.kind !== 'edits') return;
    expect(e.items.map((i) => i.hunks.flatMap((h) => h.lines.map((l) => (l.t === 'gap' ? 'gap' : `${l.t}:${l.text}`))))).toEqual([['del:b', 'add:B'], ['add:x', 'add:y']]);
    expect(e.items[0]!.head).toMatch(/^Edit · \d\d:\d\d$/);
  });
});

describe('presentProjectGit', () => {
  it('ルートと worktree の行、乗っているセッションの数', () => {
    const pg = { root: tree({ dirty: 7 }), worktrees: [{ path: '/w/alpha/.claude/worktrees/pay', name: 'pay', branch: 'worktree-pay', tree: tree({ root: '/w/alpha/.claude/worktrees/pay', branch: 'worktree-pay', worktree: 'pay', dirty: 0 }) }] };
    const sessions = [session('s1', { live: 'busy' }), session('s2', { live: 'idle' }), session('s3', { live: 'waiting', cwd: '/w/alpha/.claude/worktrees/pay' })];
    const gitDto = git({ sessions: { s3: { state: 'ok', root: '/w/alpha/.claude/worktrees/pay', branch: 'worktree-pay', worktree: 'pay' } } });
    const v = presentProjectGit(ja, pg, sessions, gitDto);
    expect(v.root).toMatchObject({ name: 'fix-login', value: '未コミット 7' });
    expect(v.rows.map((r) => [r.name, r.worktree, r.value, r.branch, r.sessions])).toEqual([
      ['alpha', false, '未コミット 7', 'ブランチ fix-login', '実行中 2'],
      ['pay', true, '変更なし', 'ブランチ worktree-pay', '入力待ち 1'],
    ]);
    expect(presentProjectGit(ja, undefined, [], git()).state).toBe('loading');
    expect(presentProjectGit(ja, { root: null, worktrees: [] }, [], git()).state).toBe('nogit');
  });
  it('この PC にパスが無い、フォルダが無い、持ち主の違いで git が断ったものは、読めない訳を出す', () => {
    expect(presentProjectGit(ja, { root: null, worktrees: [], blocked: { kind: 'noPath' } }, [], git())).toEqual({ state: 'noPath', root: null, rows: [], fix: null });
    expect(presentProjectGit(ja, { root: null, worktrees: [], blocked: { kind: 'missing' } }, [], git()).state).toBe('missing');
    expect(presentProjectGit(ja, { root: null, worktrees: [], blocked: { kind: 'unsafe', path: '/w/alpha' } }, [], git(), 'darwin')).toEqual({ state: 'unsafe', root: null, rows: [], fix: 'git config --global --add safe.directory /w/alpha' });
  });
});

describe('presentDiffDialog', () => {
  const base = () => {
    const store = { ...initialStore(), sessions: { s1: session('s1', { name: 'ログイン' }) }, git: git(), gitChanges: { s1: changes() } };
    return store;
  };
  const stateWith = (file: string | null, source: 'git' | 'session' | null = null) => ({ ...initialState(), overlay: { kind: 'diff' as const, sessionId: 's1', file, source } });
  it('ファイルを選んでいなければ最初の未コミット、出どころは git。開く行は差分から', () => {
    const store = { ...base(), gitDiffs: { [gitFileKey('s1', '/w/alpha/src/a.ts')]: { file: '/w/alpha/src/a.ts', rel: 'src/a.ts', status: 'M' as const, text: '@@ -3,1 +3,1 @@\n-a\n+b\n', truncated: false, binary: false } } };
    const p = presentDiffDialog(stateWith(null), store)!;
    expect(p).toMatchObject({ sessionId: 's1', name: 'ログイン', source: 'git', canGit: true, selected: '/w/alpha/src/a.ts', line: 3, openLabel: 'VS Code で開く' });
    expect(p.body.kind).toBe('hunks');
    expect(p.load).toEqual({ type: 'git.diff.load', sessionId: 's1', file: '/w/alpha/src/a.ts' });
  });
  it('git でなければ、このセッションの編集だけ', () => {
    const store = { ...base(), gitChanges: { s1: changes({ state: 'nogit', root: null, tree: null, others: [] }) } };
    const p = presentDiffDialog(stateWith('/w/alpha/src/n.ts', 'git'), store)!;
    expect(p).toMatchObject({ source: 'session', canGit: false, selected: '/w/alpha/src/n.ts' });
    expect(p.load).toEqual({ type: 'git.edits.load', sessionId: 's1', file: '/w/alpha/src/n.ts' });
  });
  it('開いていなければ null', () => {
    expect(presentDiffDialog(initialState(), base())).toBeNull();
  });
});
